import { Marked } from "/vendor/marked.esm.js";
import DOMPurify from "/vendor/purify.es.mjs";

const $ = (s) => document.querySelector(s);
const log = $("#log");
const agentsEl = $("#agents");
const statusEl = $("#status");
const connEl = $("#conn");
const text = $("#text");
const pendingEl = $("#pending");
const lightbox = $("#lightbox");
const composer = $("#composer");
const readonlyEl = $("#readonly");

// current view: { agentId, conversationId, chatId|null, title }
let current = JSON.parse(localStorage.getItem("current") || "null");
let agents = [];
const convsByAgent = new Map();
const expanded = new Set(JSON.parse(localStorage.getItem("expanded") || "[]"));
const roExpanded = new Set();
let pending = [];
const seen = new Set();
let roBefore = null;
// Background activity for webui chats other than the open one.
const unread = new Map(Object.entries(JSON.parse(localStorage.getItem("unread") || "{}"))); // chatId -> count
const busy = new Set(); // chatIds with a turn queued/running
const chatAgent = new Map(); // chatId -> agentId (so collapsed agents can show badges)
const saveUnread = () => localStorage.setItem("unread", JSON.stringify(Object.fromEntries(unread)));

const api = async (path, opts) => {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status}`);
  return body;
};
const post = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// ── Markdown (marked + DOMPurify, vendored in /vendor) ─────────────────────

const md = new Marked({ gfm: true, breaks: true });
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noreferrer noopener");
  }
});
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function markdown(src) {
  return DOMPurify.sanitize(md.parse(String(src)), { FORBID_TAGS: ["style", "form", "button"] });
}
function ago(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const days = (Date.now() - d) / 864e5;
  return days < 1 ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { day: "numeric", month: "short" });
}

// ── Sidebar ─────────────────────────────────────────────────────────────────
async function loadAgents() {
  ({ agents } = await api("/api/agents"));
  if (!expanded.size && agents[0]) expanded.add(agents[0].id);
  await Promise.all(agents.filter((a) => expanded.has(a.id)).map((a) => loadConvs(a.id)));
  renderSidebar();
}

async function loadConvs(agentId) {
  const { conversations } = await api(`/api/conversations?agent=${encodeURIComponent(agentId)}`);
  convsByAgent.set(agentId, conversations);
}

function convItem(agent, c) {
  const a = document.createElement("a");
  const isActive = current?.conversationId === c.id;
  a.className = `conv${c.chatId ? "" : " ro"}${isActive ? " active" : ""}`;
  const n = c.chatId ? unread.get(c.chatId) || 0 : 0;
  const dot = c.chatId && busy.has(c.chatId) ? '<span class="busy" title="working…">●</span>' : "";
  a.innerHTML = `${c.chatId ? "💬" : "👁"} <span class="name${n ? " unread" : ""}">${esc(c.title || c.id)}</span>${dot}${n ? `<span class="badge">${n}</span>` : ""}<span class="when">${esc(ago(c.lastAt))}</span>`;
  a.title = c.id;
  a.onclick = () => open({ agentId: agent.id, conversationId: c.id, chatId: c.chatId, title: c.title || c.id });
  return a;
}

function renderSidebar() {
  agentsEl.innerHTML = "";
  for (const agent of agents) {
    const box = document.createElement("div");
    box.className = "agent";
    const head = document.createElement("div");
    head.className = "agent-head";
    const isOpen = expanded.has(agent.id);
    const agentChats = [...chatAgent].filter(([, a]) => a === agent.id).map(([c]) => c);
    const agentUnread = agentChats.reduce((sum, c) => sum + (unread.get(c) || 0), 0);
    const agentBusy = agentChats.some((c) => busy.has(c));
    head.innerHTML = `<span class="caret">${isOpen ? "▾" : "▸"}</span>${esc(agent.name)}${agentBusy ? '<span class="busy" title="working…">●</span>' : ""}${agentUnread && !isOpen ? `<span class="badge">${agentUnread}</span>` : ""}`;
    const nb = document.createElement("button");
    nb.className = "new";
    nb.textContent = "+ New";
    nb.title = `New conversation with ${agent.name}`;
    nb.onclick = (e) => {
      e.stopPropagation();
      newChat(agent);
    };
    head.appendChild(nb);
    head.onclick = async () => {
      if (isOpen) expanded.delete(agent.id);
      else {
        expanded.add(agent.id);
        await loadConvs(agent.id);
      }
      localStorage.setItem("expanded", JSON.stringify([...expanded]));
      renderSidebar();
    };
    box.appendChild(head);
    if (isOpen) {
      const convs = convsByAgent.get(agent.id) ?? [];
      const mine = convs.filter((c) => c.chatId);
      const other = convs.filter((c) => !c.chatId);
      if (!mine.length) box.insertAdjacentHTML("beforeend", '<div class="empty">No web conversations yet. Press “+ New”.</div>');
      mine.forEach((c) => box.appendChild(convItem(agent, c)));
      if (other.length) {
        const g = document.createElement("div");
        g.className = "group";
        const roOpen = roExpanded.has(agent.id) || other.some((c) => c.id === current?.conversationId);
        g.textContent = `${roOpen ? "▾" : "▸"} other channels · read-only (${other.length})`;
        g.onclick = () => {
          roOpen ? roExpanded.delete(agent.id) : roExpanded.add(agent.id);
          renderSidebar();
        };
        box.appendChild(g);
        if (roOpen) other.forEach((c) => box.appendChild(convItem(agent, c)));
      }
    }
    agentsEl.appendChild(box);
  }
}

async function newChat(agent) {
  const title = prompt(`New conversation with ${agent.name}. Title (optional):`, "");
  if (title === null) return;
  try {
    const chat = await post("/api/chats", { agentId: agent.id, title });
    chatAgent.set(chat.chatId, agent.id);
    expanded.add(agent.id);
    await loadConvs(agent.id);
    open({ agentId: agent.id, conversationId: chat.conversationId, chatId: chat.chatId, title: chat.title || chat.conversationId });
  } catch (err) {
    alert(`Could not create: ${err.message}`);
  }
}

$("#rename").onclick = async () => {
  if (!current?.chatId) return;
  const title = prompt("Rename conversation:", current.title || "");
  if (!title) return;
  try {
    await post("/api/rename", { conversationId: current.conversationId, title });
    current.title = title;
    localStorage.setItem("current", JSON.stringify(current));
    await loadConvs(current.agentId);
    renderSidebar();
    renderHeader();
  } catch (err) {
    alert(`Rename failed: ${err.message}`);
  }
};

// ── Main pane ───────────────────────────────────────────────────────────────
function renderHeader() {
  const agent = agents.find((a) => a.id === current?.agentId);
  $("#title").textContent = current ? current.title : "Pick a conversation";
  $("#subtitle").textContent = current ? `${agent?.name ?? ""} · ${current.conversationId}` : "";
  $("#rename").hidden = !current?.chatId;
  composer.hidden = !current?.chatId;
  readonlyEl.hidden = !current || !!current.chatId;
}

async function open(view) {
  current = view;
  if (current.chatId && unread.delete(current.chatId)) saveUnread();
  updateTabTitle();
  localStorage.setItem("current", JSON.stringify(current));
  renderSidebar();
  renderHeader();
  seen.clear();
  log.innerHTML = "";
  setStatus(null);
  if (current.chatId) {
    const { messages, status } = await api(`/api/history?chat=${encodeURIComponent(current.chatId)}`);
    messages.forEach(addMessage);
    setStatus(status);
  } else {
    roBefore = null;
    await loadReadOnly();
  }
  log.scrollTop = log.scrollHeight;
}

async function loadReadOnly(older = false) {
  const conv = current.conversationId;
  const q = new URLSearchParams({ conversation: conv, ...(older && roBefore ? { before: roBefore } : {}) });
  const { messages, nextBefore, hasMore } = await api(`/api/readonly?${q}`);
  if (current?.conversationId !== conv) return;
  roBefore = nextBefore;
  const prevHeight = log.scrollHeight;
  log.querySelector(".more")?.remove();
  const frag = document.createDocumentFragment();
  if (hasMore) {
    const b = document.createElement("button");
    b.className = "ghost more";
    b.textContent = "Load older";
    b.onclick = () => loadReadOnly(true);
    frag.appendChild(b);
  }
  for (const m of messages) frag.appendChild(renderMessage({ ...m, chatId: null }));
  if (!messages.length && !older) frag.appendChild(Object.assign(document.createElement("div"), { className: "msg system", textContent: "No text messages in this conversation." }));
  log.prepend(frag);
  if (older) log.scrollTop = log.scrollHeight - prevHeight;
}

function renderMedia(m) {
  const cap = m.title || m.name;
  if (m.kind === "image") return `<figure><img src="${esc(m.url)}" alt="${esc(cap)}" loading="lazy" /><figcaption>${esc(cap)}</figcaption></figure>`;
  if (m.kind === "video") return `<figure><video src="${esc(m.url)}" controls preload="metadata"></video><figcaption>${esc(cap)}</figcaption></figure>`;
  if (m.kind === "audio") return `<figure><audio src="${esc(m.url)}" controls></audio><figcaption>${esc(cap)}</figcaption></figure>`;
  return `<a href="${esc(m.url)}" target="_blank">📄 ${esc(cap)}</a>`;
}

function renderMessage(m) {
  const div = document.createElement("div");
  div.className = `msg ${m.role}`;
  const time = new Date(m.ts).toLocaleString([], { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" });
  const who = m.role === "user" ? "you" : m.role === "agent" ? "agent" : "system";
  const src = m.source ? `<span class="src">${esc(m.source)}</span>` : "";
  div.innerHTML =
    (m.role === "system" ? "" : `<div class="meta">${who} · ${time}${src}</div>`) +
    (m.text ? `<div class="body">${m.role === "system" ? esc(m.text) : markdown(m.text)}</div>` : "") +
    (m.media?.length ? `<div class="media">${m.media.map(renderMedia).join("")}</div>` : "");
  return div;
}

function addMessage(m) {
  if (!current?.chatId || m.chatId !== current.chatId || seen.has(m.id)) return;
  seen.add(m.id);
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  const div = renderMessage(m);
  log.appendChild(div);
  const stick = nearBottom || m.role === "user";
  if (stick) div.scrollIntoView({ block: "end" });
  for (const v of div.querySelectorAll("img, video")) {
    v.addEventListener(v.tagName === "IMG" ? "load" : "loadedmetadata", () => stick && div.scrollIntoView({ block: "end" }));
  }
}

function setStatus(s) {
  if (!s || s.state === "idle") return void (statusEl.hidden = true);
  statusEl.hidden = false;
  statusEl.textContent = s.state === "queued" ? "queued…" : s.detail ? `working: ${s.detail}` : "thinking…";
}

function touchConv(chatId, ts) {
  const agentId = chatAgent.get(chatId);
  const c = convsByAgent.get(agentId)?.find((x) => x.chatId === chatId);
  if (c) c.lastAt = new Date(ts).toISOString();
  renderSidebar();
  updateTabTitle();
}

function updateTabTitle() {
  const total = [...unread.values()].reduce((a, b) => a + b, 0);
  document.title = total ? `(${total}) Letta UI` : "Letta UI";
}

// Reading the open chat in a background tab counts as unread until you come back.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && current?.chatId && unread.delete(current.chatId)) {
    saveUnread();
    renderSidebar();
    updateTabTitle();
  }
});

function connect() {
  const es = new EventSource("/api/events");
  es.onopen = () => {
    connEl.textContent = "connected";
    connEl.className = "conn ok";
    if (current?.chatId) open(current).catch(() => {}); // catch up after reconnect
  };
  es.onerror = () => {
    connEl.textContent = "offline";
    connEl.className = "conn bad";
  };
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === "message") {
      const m = ev.message;
      if (m.chatId === current?.chatId && document.visibilityState === "visible") addMessage(m);
      else {
        if (m.chatId === current?.chatId) addMessage(m);
        if (m.role !== "user") {
          unread.set(m.chatId, (unread.get(m.chatId) || 0) + 1);
          saveUnread();
        }
      }
      touchConv(m.chatId, m.ts);
    }
    if (ev.type === "status") {
      if (ev.chatId === current?.chatId) setStatus(ev);
      const was = busy.has(ev.chatId);
      ev.state === "idle" ? busy.delete(ev.chatId) : busy.add(ev.chatId);
      if (was !== busy.has(ev.chatId)) renderSidebar();
    }
  };
}

// ── Composer ────────────────────────────────────────────────────────────────
function renderPending() {
  pendingEl.innerHTML = "";
  pending.forEach((p, i) => {
    const s = document.createElement("span");
    s.textContent = `${p.name} ✕`;
    s.onclick = () => (pending.splice(i, 1), renderPending());
    pendingEl.appendChild(s);
  });
}

function addFiles(files) {
  if (!current?.chatId) return;
  for (const f of files) {
    const r = new FileReader();
    r.onload = () => {
      pending.push({ name: f.name || "pasted.png", mime: f.type, dataBase64: String(r.result).split(",")[1] });
      renderPending();
    };
    r.readAsDataURL(f);
  }
}

async function send() {
  if (!current?.chatId) return;
  const body = { chat: current.chatId, text: text.value, attachments: pending };
  if (!body.text.trim() && !pending.length) return;
  text.value = "";
  pending = [];
  renderPending();
  try {
    await post("/api/send", body);
  } catch (err) {
    log.appendChild(renderMessage({ role: "system", ts: Date.now(), text: `Send failed: ${err.message}` }));
  }
}

composer.addEventListener("submit", (e) => (e.preventDefault(), send()));
text.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});
text.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});
$("#file").addEventListener("change", (e) => {
  addFiles(e.target.files);
  e.target.value = "";
});
document.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (current?.chatId) document.body.classList.add("drag");
});
document.addEventListener("dragleave", () => document.body.classList.remove("drag"));
document.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("drag");
  addFiles(e.dataTransfer.files);
});
log.addEventListener("click", (e) => {
  if (e.target.tagName === "IMG") {
    lightbox.querySelector("img").src = e.target.src;
    lightbox.hidden = false;
  }
});
lightbox.addEventListener("click", () => (lightbox.hidden = true));

// ── Boot ────────────────────────────────────────────────────────────────────
(async () => {
  try {
    const { chats } = await api("/api/chats");
    for (const c of chats) chatAgent.set(c.chatId, c.agentId);
    for (const id of [...unread.keys()]) if (!chatAgent.has(id)) unread.delete(id);
    updateTabTitle();
    await loadAgents();
  } catch (err) {
    agentsEl.innerHTML = `<div class="empty">Could not load agents: ${esc(err.message)}</div>`;
  }
  if (!current) {
    const { chats } = await api("/api/chats");
    const c = chats[0];
    if (c) current = { agentId: c.agentId, conversationId: c.conversationId, chatId: c.chatId, title: c.conversationId };
  }
  if (current) {
    // refresh title/chat binding from the server
    const convs = convsByAgent.get(current.agentId) ?? (await loadConvs(current.agentId), convsByAgent.get(current.agentId));
    const c = convs?.find((x) => x.id === current.conversationId);
    if (c) current = { ...current, chatId: c.chatId, title: c.title || c.id };
    await open(current);
  } else renderHeader();
  connect();
})();
