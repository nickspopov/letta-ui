// letta-ui: a Letta Code user channel plugin ("webui") that serves its own
// local web chat page. Agents reply (text + images/videos/files) through the
// built-in MessageChannel tool; the page is up exactly when the channel is up.
//
// No dependencies: node:http + Server-Sent Events, so it runs under Bun or Node.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CHANNEL_ID = "webui";
const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../public");
const DEFAULT_PORT = 4610;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".heic": "image/heic",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
};

function mimeFor(name) {
  return MIME[extname(name).toLowerCase()] ?? "application/octet-stream";
}

function kindFor(mime) {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

function channelDir() {
  const root = process.env.LETTA_CONFIG_DIR ?? join(homedir(), ".letta");
  return join(root, "channels", CHANNEL_ID);
}

function safeName(name) {
  return (basename(String(name || "file")).replace(/[^\w.\-]+/g, "_") || "file").slice(0, 120);
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

// ── Message store (one JSONL file per chat) ────────────────────────────────

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.chatsDir = join(dataDir, "chats");
    this.mediaDir = join(dataDir, "media");
    this.uploadsDir = join(dataDir, "uploads");
    for (const d of [this.chatsDir, this.mediaDir, this.uploadsDir]) mkdirSync(d, { recursive: true });
  }

  chatFile(chatId) {
    return join(this.chatsDir, `${safeName(chatId)}.jsonl`);
  }

  append(entry) {
    appendFileSync(this.chatFile(entry.chatId), `${JSON.stringify(entry)}\n`);
  }

  /** Latest `limit` messages, or the `limit` messages before message id `before`. */
  history(chatId, { before = null, limit = 300 } = {}) {
    const file = this.chatFile(chatId);
    if (!existsSync(file)) return { messages: [], hasMore: false };
    const all = readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
    let end = all.length;
    if (before) {
      const i = all.findIndex((m) => m.id === before);
      if (i >= 0) end = i;
    }
    const start = Math.max(0, end - limit);
    return { messages: all.slice(start, end), hasMore: start > 0 };
  }

  /** Copy an agent-provided local file into the media store (stable snapshot). */
  importMedia(path, fileName) {
    const src = resolve(path.startsWith("~") ? join(homedir(), path.slice(1)) : path);
    const st = statSync(src);
    if (!st.isFile()) throw new Error(`Not a file: ${src}`);
    const name = safeName(fileName || basename(src));
    const stored = `${randomUUID()}-${name}`;
    copyFileSync(src, join(this.mediaDir, stored));
    const mime = mimeFor(name);
    return { url: `/media/${stored}`, name, mime, kind: kindFor(mime), size: st.size };
  }

  saveUpload(name, buf) {
    const stored = `${randomUUID()}-${safeName(name)}`;
    const path = join(this.uploadsDir, stored);
    writeFileSync(path, buf);
    return { path, stored };
  }
}

// ── App Server client ─────────────────────────────────────────────────────
// The plugin runs inside `letta channel-gateway`, which is started with
// `--app-server-url ws://127.0.0.1:<port>/ws` (loopback, no auth). That App
// Server speaks protocol_v2: agent_list, conversation_create, ... with
// request_id correlation.

function appServerUrl() {
  const i = process.argv.indexOf("--app-server-url");
  return i >= 0 ? process.argv[i + 1] : process.env.LETTA_UI_APP_SERVER_URL;
}

class AppServerClient {
  constructor() {
    this.ws = null;
    this.pending = new Map();
    this.opening = null;
  }

  async connect() {
    if (this.ws?.readyState === 1) return this.ws;
    if (this.opening) return this.opening;
    const url = appServerUrl();
    if (!url) throw new Error("App Server URL unknown (not running inside channel-gateway?)");
    this.opening = new Promise((ok, fail) => {
      const ws = new WebSocket(url);
      ws.onopen = () => {
        this.ws = ws;
        this.opening = null;
        ok(ws);
      };
      ws.onerror = () => {
        this.opening = null;
        fail(new Error(`cannot connect to App Server ${url}`));
      };
      ws.onclose = () => {
        this.ws = null;
        for (const p of this.pending.values()) p.fail(new Error("App Server connection closed"));
        this.pending.clear();
      };
      ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(String(e.data));
        } catch {
          return;
        }
        const p = msg?.request_id && this.pending.get(msg.request_id);
        if (!p) return;
        this.pending.delete(msg.request_id);
        if (msg.success === false) p.fail(new Error(msg.error || `${msg.type} failed`));
        else p.ok(msg);
      };
    });
    return this.opening;
  }

  async request(command, timeoutMs = 15000) {
    const ws = await this.connect();
    const request_id = `webui-${randomUUID()}`;
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id);
        fail(new Error(`${command.type} timed out`));
      }, timeoutMs);
      this.pending.set(request_id, {
        ok: (m) => (clearTimeout(timer), ok(m)),
        fail: (e) => (clearTimeout(timer), fail(e)),
      });
      ws.send(JSON.stringify({ ...command, request_id }));
    });
  }

  close() {
    this.ws?.close();
  }
}

// ── Routes (routing.json) ─────────────────────────────────────────────────
// The gateway caches routes, but a cache miss re-reads routing.json, so a NEW
// chatId written here is picked up live. Existing chatIds are never re-pointed.

function routingPath() {
  return join(channelDir(), "routing.json");
}

function readRoutesFile() {
  const data = readJson(routingPath(), { routes: [] });
  return Array.isArray(data.routes) ? data.routes : [];
}

function ensureRoute(accountId, chatId, agentId, conversationId) {
  const routes = readRoutesFile();
  if (routes.some((r) => r.accountId === accountId && r.chatId === chatId)) return;
  const now = new Date().toISOString();
  routes.push({
    accountId,
    chatId,
    chatType: "direct",
    threadId: null,
    agentId,
    conversationId,
    enabled: true,
    outboundEnabled: true,
    createdAt: now,
    updatedAt: now,
  });
  const tmp = `${routingPath()}.webui-${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ routes }, null, 2)}\n`);
  renameSync(tmp, routingPath());
}

// ── Adapter ────────────────────────────────────────────────────────────────

function createWebUiAdapter(account) {
  const cfg = account.config ?? {};
  const port = Number(cfg.port) || DEFAULT_PORT;
  const host = "127.0.0.1";
  const senderId = String(cfg.sender_id || "user");
  const senderName = String(cfg.sender_name || "User");
  const store = new Store(cfg.data_dir ? resolve(String(cfg.data_dir)) : join(channelDir(), "data"));
  const clients = new Set();
  const status = new Map(); // chatId -> {state, detail}
  let server = null;
  let running = false;

  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  function broadcast(event) {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) res.write(data);
  }

  function record(entry) {
    const full = { id: randomUUID(), ts: Date.now(), ...entry };
    store.append(full);
    broadcast({ type: "message", message: full });
    return full;
  }

  function setStatus(chatId, state, detail) {
    if (state === "idle") status.delete(chatId);
    else status.set(chatId, { state, detail });
    broadcast({ type: "status", chatId, state, detail: detail ?? null });
  }

  const app = new AppServerClient();
  let agentsCache = { at: 0, agents: [] };

  /** webui chats = our routes (one chat per agent+conversation). */
  function listChats() {
    // Paused routes (/pause sets enabled=false) still belong to webui.
    return readRoutesFile()
      .filter((r) => r.accountId === account.accountId)
      .map((r) => ({ chatId: r.chatId, agentId: r.agentId, conversationId: r.conversationId, paused: r.enabled === false }));
  }

  async function listAgents() {
    if (Date.now() - agentsCache.at < 60_000) return agentsCache.agents;
    const res = await app.request({ type: "agent_list", query: { limit: 200 } });
    const agents = (res.agents ?? []).map((a) => ({ id: a.id, name: a.name || a.id }));
    agentsCache = { at: Date.now(), agents };
    return agents;
  }

  /** All conversations of an agent; ones routed to webui are writable, the rest read-only. */
  async function listConversations(agentId) {
    // Page through the whole list (the App Server caps each page).
    const raw = [];
    for (let after = null, page = 0; page < 50; page++) {
      const res = await app.request({ type: "conversation_list", query: { agent_id: agentId, limit: 100, ...(after ? { after } : {}) } });
      const batch = res.conversations ?? [];
      raw.push(...batch);
      if (batch.length < 100) break;
      after = batch[batch.length - 1].id;
    }
    const chats = listChats().filter((c) => c.agentId === agentId);
    const byConv = new Map(chats.map((c) => [c.conversationId, c]));
    const toConv = (c) => ({
      id: c.id,
      title: c.summary || null,
      lastAt: c.last_message_at || c.updated_at || c.created_at,
      chatId: byConv.get(c.id)?.chatId ?? null,
      paused: byConv.get(c.id)?.paused === true,
      archived: c.archived === true,
    });
    const convs = raw.map(toConv);
    // Routed conversations the list didn't return (created after this process
    // scanned storage): fetch their real metadata instead of inventing it.
    for (const chat of chats) {
      if (convs.some((c) => c.id === chat.conversationId)) continue;
      try {
        const r = await app.request({ type: "conversation_retrieve", conversation_id: chat.conversationId });
        if (r.conversation) {
          convs.unshift(toConv(r.conversation));
          continue;
        }
      } catch {}
      convs.unshift({ id: chat.conversationId, title: null, lastAt: null, chatId: chat.chatId, paused: chat.paused, archived: false });
    }
    return convs;
  }

  async function createChat(agentId, title) {
    const agents = await listAgents();
    if (!agents.some((a) => a.id === agentId)) throw new Error(`unknown agent ${agentId}`);
    const res = await app.request({
      type: "conversation_create",
      body: { agent_id: agentId, ...(title ? { summary: title } : {}) },
    });
    const conversationId = res.conversation?.id;
    if (!conversationId) throw new Error("conversation_create returned no id");
    const chatId = `c-${conversationId}`;
    ensureRoute(account.accountId, chatId, agentId, conversationId);
    return { chatId, agentId, conversationId, title: title || null };
  }

  async function renameConversation(conversationId, title) {
    await app.request({ type: "conversation_update", conversation_id: conversationId, body: { summary: title } });
  }

  function textOf(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((p) => (p?.type === "text" ? p.text : "")).join("");
    return "";
  }

  /** Map Letta history to read-only display entries (text both ways + channel sends). */
  function toReadOnlyEntries(messages) {
    const out = [];
    // In channel turns the user sees MessageChannel sends, not the trailing
    // assistant text ("Sent."), so drop assistant text after a channel send.
    let channelTurn = false;
    for (const m of messages) {
      const ts = Date.parse(m.date) || 0;
      if (m.message_type === "user_message") channelTurn = false;
      if (m.message_type === "assistant_message" && channelTurn) continue;
      if (m.message_type === "user_message") {
        let t = textOf(m.content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
        let source = null;
        const n = /<channel-notification\b([^>]*)>([\s\S]*?)<\/channel-notification>/.exec(t);
        if (n) {
          source = /source="([^"]*)"/.exec(n[1])?.[1] ?? null;
          t = n[2];
        }
        t = t.trim();
        if (t) out.push({ id: m.id, ts, role: "user", text: t, source });
      } else if (m.message_type === "assistant_message") {
        const t = textOf(m.content).trim();
        if (t) out.push({ id: m.id, ts, role: "agent", text: t });
      } else if (m.message_type === "approval_request_message" || m.message_type === "tool_call_message") {
        const call = m.tool_call ?? m.tool_calls?.[0];
        if (call?.name !== "MessageChannel") continue;
        channelTurn = true;
        let args = {};
        try {
          args = JSON.parse(call.arguments || "{}");
        } catch {}
        const text = [args.message, args.media ? `📎 ${basename(String(args.media))}` : ""].filter(Boolean).join("\n\n");
        if (text) out.push({ id: m.id, ts, role: "agent", text, source: args.channel ?? null });
      }
    }
    return out;
  }

  async function readOnlyHistory(conversationId, before) {
    const res = await app.request({
      type: "conversation_messages_list",
      conversation_id: conversationId,
      query: { limit: 200, order: "desc", ...(before ? { before } : {}) },
    });
    return {
      messages: toReadOnlyEntries([...(res.messages ?? [])].reverse()),
      nextBefore: res.next_before ?? null,
      hasMore: res.has_more === true,
    };
  }

  function sendJson(res, code, body) {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }

  function serveFile(req, res, path, untrusted = false) {
    let st;
    try {
      st = statSync(path);
      if (!st.isFile()) throw new Error("not a file");
    } catch {
      res.writeHead(404).end("not found");
      return;
    }
    const headers = { "content-type": mimeFor(path), "accept-ranges": "bytes", "cache-control": "no-cache" };
    if (untrusted) {
      // Agent/user files (e.g. an HTML report) must never run script on this
      // origin: sandbox gives them an opaque origin with scripts disabled.
      headers["content-security-policy"] = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";
      headers["x-content-type-options"] = "nosniff";
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
      start = Math.max(0, start);
      end = Math.min(end, st.size - 1);
      if (start > end) {
        res.writeHead(416, { "content-range": `bytes */${st.size}` }).end();
        return;
      }
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": end - start + 1 });
      createReadStream(path, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, "content-length": st.size });
    createReadStream(path).pipe(res);
  }

  function readBody(req, limit) {
    return new Promise((resolveBody, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > limit) {
          reject(new Error("body too large"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolveBody(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  async function handleSend(req, res) {
    const origin = req.headers.origin;
    if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ""))) {
      sendJson(res, 403, { error: "bad origin" });
      return;
    }
    const body = JSON.parse((await readBody(req, MAX_UPLOAD_BYTES * 1.4)).toString("utf8"));
    const chatId = String(body.chat || "").trim();
    const text = String(body.text ?? "");
    if (!chatId) return sendJson(res, 400, { error: "chat required" });
    const chat = listChats().find((c) => c.chatId === chatId);
    if (!chat) return sendJson(res, 400, { error: "chat is not routed to webui" });
    if (chat.paused && !/^\/\w/.test(text.trim())) return sendJson(res, 409, { error: "this chat is paused; send /resume first" });
    if (!adapter.onMessage) return sendJson(res, 503, { error: "channel not wired yet" });

    const attachments = [];
    const shown = [];
    for (const a of Array.isArray(body.attachments) ? body.attachments : []) {
      const buf = Buffer.from(String(a.dataBase64 || ""), "base64");
      if (!buf.length) continue;
      const name = safeName(a.name || "upload");
      const mime = String(a.mime || mimeFor(name));
      const { path, stored } = store.saveUpload(name, buf);
      const kind = kindFor(mime);
      attachments.push({
        id: stored,
        name,
        mimeType: mime,
        sizeBytes: buf.length,
        kind,
        localPath: path,
        ...(kind === "image" && buf.length <= INLINE_IMAGE_MAX_BYTES ? { imageDataBase64: buf.toString("base64") } : {}),
      });
      shown.push({ url: `/uploads/${stored}`, name, mime, kind, size: buf.length });
    }
    if (!text.trim() && attachments.length === 0) return sendJson(res, 400, { error: "empty message" });

    const entry = record({ chatId, role: "user", text, media: shown });
    // Fire and forget: the agent turn can take minutes; replies arrive via SSE.
    adapter
      .onMessage({
        channel: CHANNEL_ID,
        accountId: account.accountId,
        chatId,
        chatType: "direct",
        chatLabel: chatId,
        senderId,
        senderName,
        text,
        timestamp: entry.ts,
        messageId: entry.id,
        threadId: null,
        ...(attachments.length ? { attachments } : {}),
      })
      .catch((err) => record({ chatId, role: "system", text: `Delivery failed: ${err?.message ?? err}` }));
    sendJson(res, 200, { ok: true, id: entry.id });
  }

  async function onRequest(req, res) {
    try {
      if (!allowedHosts.has(req.headers.host ?? "")) {
        res.writeHead(403).end("forbidden host");
        return;
      }
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const p = url.pathname;

      if (req.method === "GET" && (p === "/" || p === "/index.html")) return serveFile(req, res, join(PUBLIC_DIR, "index.html"));
      if (req.method === "GET" && (p === "/app.js" || p === "/style.css")) return serveFile(req, res, join(PUBLIC_DIR, p.slice(1)));
      if (req.method === "GET" && /^\/vendor\/[\w.\-]+$/.test(p)) return serveFile(req, res, join(PUBLIC_DIR, p.slice(1)));
      if (req.method === "GET" && /^\/(manifest\.webmanifest|icon(-\d+)?\.(png|svg))$/.test(p)) return serveFile(req, res, join(PUBLIC_DIR, p.slice(1)));
      if (req.method === "GET" && p === "/api/chats") return sendJson(res, 200, { accountId: account.accountId, chats: listChats() });
      if (req.method === "GET" && p === "/api/statuses") return sendJson(res, 200, { statuses: Object.fromEntries(status) });
      if (req.method === "GET" && p === "/api/agents") return sendJson(res, 200, { agents: await listAgents() });
      if (req.method === "GET" && p === "/api/conversations") {
        return sendJson(res, 200, { conversations: await listConversations(url.searchParams.get("agent") ?? "") });
      }
      if (req.method === "GET" && p === "/api/readonly") {
        const conv = url.searchParams.get("conversation") ?? "";
        if (listChats().some((c) => c.conversationId === conv)) return sendJson(res, 400, { error: "routed to webui; use /api/history" });
        return sendJson(res, 200, await readOnlyHistory(conv, url.searchParams.get("before")));
      }
      if (req.method === "POST" && p === "/api/reveal") {
        if (req.headers.origin && !allowedHosts.has(req.headers.origin.replace(/^https?:\/\//, ""))) return sendJson(res, 403, { error: "bad origin" });
        const body = JSON.parse((await readBody(req, 16 * 1024)).toString("utf8") || "{}");
        const m = /^\/(media|uploads)\/([^/]+)$/.exec(String(body.url ?? ""));
        if (!m) return sendJson(res, 400, { error: "not a local media url" });
        const dir = m[1] === "media" ? store.mediaDir : store.uploadsDir;
        const file = resolve(dir, decodeURIComponent(m[2]));
        if (!file.startsWith(dir + sep) || !existsSync(file)) return sendJson(res, 404, { error: "file not found" });
        const [cmd, args] = process.platform === "darwin" ? ["open", ["-R", file]] : ["xdg-open", [dirname(file)]];
        spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
        return sendJson(res, 200, { ok: true, path: file });
      }
      if (req.method === "POST" && p === "/api/archive") {
        if (req.headers.origin && !allowedHosts.has(req.headers.origin.replace(/^https?:\/\//, ""))) return sendJson(res, 403, { error: "bad origin" });
        const body = JSON.parse((await readBody(req, 16 * 1024)).toString("utf8") || "{}");
        const chat = listChats().find((c) => c.conversationId === body.conversationId);
        if (!chat) return sendJson(res, 400, { error: "only webui conversations can be archived here" });
        await app.request({ type: "conversation_update", conversation_id: chat.conversationId, body: { archived: body.archived !== false } });
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "POST" && (p === "/api/chats" || p === "/api/rename")) {
        if (req.headers.origin && !allowedHosts.has(req.headers.origin.replace(/^https?:\/\//, ""))) {
          return sendJson(res, 403, { error: "bad origin" });
        }
        const body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8") || "{}");
        const title = String(body.title ?? "").trim().slice(0, 120);
        if (p === "/api/chats") return sendJson(res, 200, await createChat(String(body.agentId ?? ""), title));
        const chat = listChats().find((c) => c.conversationId === body.conversationId);
        if (!chat) return sendJson(res, 400, { error: "only webui conversations can be renamed here" });
        await renameConversation(chat.conversationId, title);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "GET" && p === "/api/history") {
        const chatId = url.searchParams.get("chat") ?? "";
        const page = store.history(chatId, { before: url.searchParams.get("before") });
        return sendJson(res, 200, { ...page, status: status.get(chatId) ?? null });
      }
      if (req.method === "GET" && p === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(": hi\n\n");
        clients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 25000);
        req.on("close", () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }
      if (req.method === "POST" && p === "/api/send") return await handleSend(req, res);
      for (const [prefix, dir] of [["/media/", store.mediaDir], ["/uploads/", store.uploadsDir]]) {
        if (req.method === "GET" && p.startsWith(prefix)) {
          const file = resolve(dir, decodeURIComponent(p.slice(prefix.length)));
          if (!file.startsWith(dir + sep)) return res.writeHead(400).end();
          return serveFile(req, res, file, true);
        }
      }
      res.writeHead(404).end("not found");
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: String(err?.message ?? err) });
    }
  }

  const adapter = {
    id: `${CHANNEL_ID}:${account.accountId}`,
    channelId: CHANNEL_ID,
    accountId: account.accountId,
    name: account.displayName ?? "Web UI",
    onMessage: undefined,

    async start(options) {
      if (running) return;
      server = createServer((req, res) => void onRequest(req, res));
      await new Promise((ok, fail) => {
        server.once("error", fail);
        server.listen(port, host, () => {
          server.off("error", fail);
          ok();
        });
      });
      running = true;
      options?.logger?.(`[webui] serving http://${host}:${port}`);
      console.log(`[webui] serving http://${host}:${port}`);
    },

    async stop() {
      running = false;
      app.close();
      for (const res of clients) res.end();
      clients.clear();
      if (server) await new Promise((ok) => server.close(() => ok()));
      server = null;
    },

    isRunning() {
      return running;
    },

    async sendMessage(msg) {
      if (msg.reaction) return { messageId: randomUUID() }; // reactions: not rendered
      let media = [];
      if (msg.mediaPath) {
        const m = store.importMedia(msg.mediaPath, msg.fileName);
        if (msg.title) m.title = msg.title;
        media = [m];
      }
      const entry = record({ chatId: msg.chatId, role: "agent", text: msg.text ?? "", media });
      return { messageId: entry.id };
    },

    async sendDirectReply(chatId, text) {
      record({ chatId, role: "system", text });
    },

    async handleTurnLifecycleEvent(event) {
      const sources = event.type === "queued" ? [event.source] : event.sources ?? [];
      for (const s of sources) {
        if (s.channel !== CHANNEL_ID) continue;
        if (event.type === "finished") {
          setStatus(s.chatId, "idle");
          if (event.outcome && event.outcome !== "completed" && event.error) {
            record({ chatId: s.chatId, role: "system", text: `Turn ended: ${event.outcome}: ${event.error}` });
          }
        } else {
          setStatus(s.chatId, event.type);
        }
      }
    },

    async handleTurnProgressEvent(event) {
      const detail = event.toolBatchTitle || event.toolTitle || event.message || null;
      for (const s of event.sources ?? []) {
        if (s.channel !== CHANNEL_ID) continue;
        // Only refresh the detail of a turn we know is running: a late progress
        // event must not resurrect "processing" after the turn finished.
        if (status.has(s.chatId)) setStatus(s.chatId, "processing", detail);
        broadcast({
          type: "progress",
          chatId: s.chatId,
          kind: event.kind ?? null,
          state: event.state ?? null,
          toolCallId: event.toolCallId ?? null,
          toolName: event.toolName ?? null,
          title: event.toolTitle || event.message || event.toolName || null,
          details: event.toolDetails ?? null,
          error: event.errorDetails ?? null,
        });
      }
    },
  };

  return adapter;
}

// ── Plugin export ──────────────────────────────────────────────────────────

export const channelPlugin = {
  metadata: {
    id: CHANNEL_ID,
    displayName: "Web UI",
    runtimePackages: [],
    runtimeModules: [],
  },

  createAdapter(account) {
    return createWebUiAdapter(account);
  },

  messageActions: {
    describeMessageTool() {
      // "upload-file" is what makes Letta keep media/filename/title in the
      // MessageChannel schema (message-channel-tool-definition.ts).
      return { actions: ["send", "upload-file"] };
    },
    async handleAction({ adapter, request, formatText }) {
      if (request.action !== "send" && request.action !== "upload-file") {
        return `Error: action ${request.action} is not supported on webui.`;
      }
      if (request.action === "upload-file" && !request.mediaPath) return "Error: upload-file requires media (a local file path).";
      if (!request.message && !request.mediaPath) return "Error: send requires message or media.";
      const formatted = formatText(request.message ?? "");
      const result = await adapter.sendMessage({
        channel: request.channel,
        chatId: request.chatId,
        text: formatted.text,
        threadId: request.threadId,
        mediaPath: request.mediaPath,
        fileName: request.filename,
        title: request.title,
      });
      return `Message sent to webui (message_id: ${result.messageId})`;
    },
  },
};

export default channelPlugin;
