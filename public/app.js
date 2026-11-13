import { Marked } from "/vendor/marked.esm.js";
import DOMPurify from "/vendor/purify.es.mjs";
import hljs from "/vendor/highlight.min.mjs";

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
const cmdMenu = $("#cmd-menu");
const palette = $("#palette");

// Channel slash commands Letta Code handles before the agent sees the message
// (src/channels/command-surface.ts).
const COMMANDS = [
  ["cancel", "Cancel the in-progress agent turn"],
  ["status", "Show this chat's channel connection status"],
  ["model", "Show, list, or switch the model for this conversation"],
  ["reflection", "Start a memory reflection pass"],
  ["pause", "Pause agent routing for this chat"],
  ["resume", "Resume agent routing for this chat"],
  ["reload", "Reload settings, local mods, and agent secrets"],
  ["whoami", "Show your access tier and runnable commands"],
  ["help", "Show channel usage guidance"],
  ["chat", "Show the Letta web chat link for this route"],
  ["feedback", "Send feedback about Letta Code"],
];

// current view: { agentId, conversationId, chatId|null, title, archived }
let current = JSON.parse(localStorage.getItem("current") || "null");
let agents = [];
const convsByAgent = new Map();
const expanded = new Set(JSON.parse(localStorage.getItem("expanded") || "[]"));
const groupOpen = new Set(); // `${agentId}:ro` / `${agentId}:archived`
let pending = [];
const seen = new Set();
let roBefore = null;
const unread = new Map(Object.entries(JSON.parse(localStorage.getItem("unread") || "{}"))); // chatId -> count
const busy = new Set(); // chatIds with a turn queued/running
const chatAgent = new Map(); // chatId -> agentId
const steps = new Map(); // chatId -> [{id, title, state, error}]
const statusByChat = new Map(); // chatId -> last status event
let stepsOpen = false;
let notifyOn = localStorage.getItem("notify") === "on";
const saveUnread = () => localStorage.setItem("unread", JSON.stringify(Object.fromEntries(unread)));

const api = async (path, opts) => {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status}`);
  return body;
};
const post = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// ── Markdown + code ─────────────────────────────────────────────────────────
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
function enhanceCode(root) {
  for (const code of root.querySelectorAll("pre > code")) {
    const lang = /language-([\w-]+)/.exec(code.className)?.[1];
    if (lang && hljs.getLanguage(lang)) hljs.highlightElement(code);
    const btn = document.createElement("button");
    btn.className = "copy";
    btn.type = "button";
    btn.textContent = "Copy";
    btn.onclick = async () => {
      await navigator.clipboard.writeText(code.textContent);
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = "Copy"), 1200);
    };
    code.parentElement.appendChild(btn);
  }
}
function plain(src, n = 140) {
  const t = String(src || "").replace(/```[\s\S]*?```/g, "[code]").replace(/[#*_`>|-]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
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
  for (const c of conversations) if (c.chatId) chatAgent.set(c.chatId, agentId);
}

function findConv(conversationId) {
  for (const [agentId, convs] of convsByAgent) {
    const c = convs.find((x) => x.id === conversationId);
    if (c) return { agentId, c };
  }
  return null;
}

function viewOf(agentId, c) {
  return { agentId, conversationId: c.id, chatId: c.chatId, title: c.title || c.id, archived: !!c.archived };
}

function convItem(agent, c) {
  const a = document.createElement("a");
  const isActive = current?.conversationId === c.id;
  a.className = `conv${c.chatId ? "" : " ro"}${isActive ? " active" : ""}`;
  const n = c.chatId ? unread.get(c.chatId) || 0 : 0;
  const dot = c.chatId && busy.has(c.chatId) ? '<span class="busy" title="working…">●</span>' : "";
  a.innerHTML = `${c.chatId ? "💬" : "👁"} <span class="name${n ? " unread" : ""}">${esc(c.title || c.id)}</span>${dot}${n ? `<span class="badge">${n}</span>` : ""}<span class="when">${esc(ago(c.lastAt))}</span>`;
  a.title = c.id;
  a.onclick = () => open(viewOf(agent.id, c));
  return a;
}

function group(box, agent, key, label, items) {
  if (!items.length) return;
  const id = `${agent.id}:${key}`;
  const isOpen = groupOpen.has(id) || items.some((c) => c.id === current?.conversationId);
  const g = document.createElement("div");
  g.className = "group";
  g.textContent = `${isOpen ? "▾" : "▸"} ${label} (${items.length})`;
  g.onclick = () => {
    isOpen ? groupOpen.delete(id) : groupOpen.add(id);
    renderSidebar();
  };
  box.appendChild(g);
  if (isOpen) items.forEach((c) => box.appendChild(convItem(agent, c)));
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
      const mine = convs.filter((c) => c.chatId && !c.archived);
      if (!mine.length) box.insertAdjacentHTML("beforeend", '<div class="empty">No web conversations yet. Press “+ New”.</div>');
      mine.forEach((c) => box.appendChild(convItem(agent, c)));
      group(box, agent, "ro", "other channels · read-only", convs.filter((c) => !c.chatId && !c.archived));
      group(box, agent, "archived", "archived", convs.filter((c) => c.archived));
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
    open({ agentId: agent.id, conversationId: chat.conversationId, chatId: chat.chatId, title: chat.title || chat.conversationId, archived: false });
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

$("#archive").onclick = async () => {
  if (!current?.chatId) return;
  const archived = !current.archived;
  try {
    await post("/api/archive", { conversationId: current.conversationId, archived });
    current.archived = archived;
    localStorage.setItem("current", JSON.stringify(current));
    await loadConvs(current.agentId);
    renderSidebar();
    renderHeader();
  } catch (err) {
    alert(`Archive failed: ${err.message}`);
  }
};

// ── Main pane ───────────────────────────────────────────────────────────────
function renderHeader() {
  const agent = agents.find((a) => a.id === current?.agentId);
  $("#title").textContent = current ? current.title : "Pick a conversation";
  $("#subtitle").textContent = current ? `${agent?.name ?? ""} · ${current.conversationId}${current.archived ? " · archived" : ""}` : "";
  $("#rename").hidden = !current?.chatId;
  $("#archive").hidden = !current?.chatId;
  $("#archive").textContent = current?.archived ? "Unarchive" : "Archive";
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
  stepsOpen = false;
  renderStatus();
  if (current.chatId) {
    const { messages, status } = await api(`/api/history?chat=${encodeURIComponent(current.chatId)}`);
    applyStatus(current.chatId, status);
    messages.forEach((m) => addMessage(m, { history: true }));
    renderStatus();
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

function mediaActions(m) {
  return /^\/(media|uploads)\//.test(m.url) ? `<button type="button" class="reveal" data-url="${esc(m.url)}" title="Show the file in Finder">Show in Finder</button>` : "";
}

function renderMedia(m) {
  const cap = esc(m.title || m.name);
  if (m.kind === "image") return `<figure><img src="${esc(m.url)}" alt="${cap}" loading="lazy" /><figcaption>${cap}${mediaActions(m)}</figcaption></figure>`;
  if (m.kind === "video") return `<figure class="wide"><video src="${esc(m.url)}" controls preload="metadata"></video><figcaption>${cap}${mediaActions(m)}</figcaption></figure>`;
  if (m.kind === "audio") return `<figure class="wide"><audio src="${esc(m.url)}" controls></audio><figcaption>${cap}${mediaActions(m)}</figcaption></figure>`;
  return `<figure class="file"><a href="${esc(m.url)}" target="_blank">📄 ${cap}</a>${mediaActions(m)}</figure>`;
}

function renderMessage(m) {
  const div = document.createElement("div");
  div.className = `msg ${m.role}`;
  div.dataset.role = m.role;
  div.dataset.ts = String(m.ts);
  const time = new Date(m.ts).toLocaleString([], { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" });
  const who = m.role === "user" ? "you" : m.role === "agent" ? "agent" : "system";
  const src = m.source ? `<span class="src">${esc(m.source)}</span>` : "";
  const images = (m.media ?? []).filter((x) => x.kind === "image").length;
  div.innerHTML =
    (m.role === "system" ? "" : `<div class="meta">${who} · ${time}${src}</div>`) +
    (m.text ? `<div class="body">${m.role === "system" ? esc(m.text) : markdown(m.text)}</div>` : "") +
    (m.media?.length ? `<div class="media${images > 1 ? " grid" : ""}">${m.media.map(renderMedia).join("")}</div>` : "");
  enhanceCode(div);
  return div;
}

// Consecutive image-only replies from the agent (e.g. 7 E2E screenshots sent
// one by one) are merged into the previous agent bubble as a grid.
function mergeIntoPrevious(m) {
  const onlyImages = m.role === "agent" && !m.text?.trim() && m.media?.length && m.media.every((x) => x.kind === "image");
  const prev = log.lastElementChild;
  if (!onlyImages || prev?.dataset.role !== "agent") return null;
  if (m.ts - Number(prev.dataset.ts) > 10 * 60 * 1000) return null;
  const media = prev.querySelector(".media");
  if (!media || !media.querySelector("img")) return null;
  media.insertAdjacentHTML("beforeend", m.media.map(renderMedia).join(""));
  media.classList.add("grid");
  prev.dataset.ts = String(m.ts);
  return prev;
}

function addMessage(m, { history = false } = {}) {
  if (!current?.chatId || m.chatId !== current.chatId || seen.has(m.id)) return;
  seen.add(m.id);
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 160;
  const div = mergeIntoPrevious(m) ?? log.appendChild(renderMessage(m));
  const stick = history || nearBottom || m.role === "user";
  if (stick) log.scrollTop = log.scrollHeight;
  for (const v of div.querySelectorAll("img, video")) {
    v.addEventListener(v.tagName === "IMG" ? "load" : "loadedmetadata", () => stick && (log.scrollTop = log.scrollHeight), { once: true });
  }
}

// ── Status, steps, stop ─────────────────────────────────────────────────────
function renderStatus() {
  const s = current?.chatId ? statusByChat.get(current.chatId) : null;
  if (!s || s.state === "idle") {
    statusEl.hidden = true;
    return;
  }
  statusEl.hidden = false;
  $("#status-text").textContent = s.state === "queued" ? "queued…" : s.detail ? `working: ${s.detail}` : "thinking…";
  const list = steps.get(current.chatId) ?? [];
  const toggle = $("#steps-toggle");
  toggle.hidden = !list.length;
  toggle.textContent = `${stepsOpen ? "▾" : "▸"} ${list.length} step${list.length === 1 ? "" : "s"}`;
  const ol = $("#steps");
  ol.hidden = !stepsOpen || !list.length;
  ol.innerHTML = list
    .map((x) => `<li class="${esc(x.state || "")}"><span class="st">${x.state === "failed" ? "✗" : x.state === "completed" ? "✓" : "…"}</span>${esc(x.title || "step")}${x.error ? `<div class="err">${esc(x.error)}</div>` : ""}</li>`)
    .join("");
}
$("#steps-toggle").onclick = () => {
  stepsOpen = !stepsOpen;
  renderStatus();
};
$("#stop").onclick = async () => {
  if (!current?.chatId) return;
  $("#stop").disabled = true;
  try {
    await post("/api/send", { chat: current.chatId, text: "/cancel", attachments: [] });
  } finally {
    setTimeout(() => ($("#stop").disabled = false), 1500);
  }
};

function onStatus(ev) {
  const wasBusy = busy.has(ev.chatId);
  if (ev.state === "idle") busy.delete(ev.chatId);
  else {
    if (!wasBusy) steps.set(ev.chatId, []); // a new turn starts
    busy.add(ev.chatId);
  }
  statusByChat.set(ev.chatId, ev);
  if (ev.chatId === current?.chatId) renderStatus();
  if (wasBusy !== busy.has(ev.chatId)) renderSidebar();
}

// The server is the source of truth for "is a turn running". Events can be
// missed (server restart mid-turn, SSE reconnect), so resync from it.
function applyStatus(chatId, s) {
  if (s && s.state && s.state !== "idle") {
    statusByChat.set(chatId, { chatId, ...s });
    busy.add(chatId);
  } else {
    statusByChat.delete(chatId);
    busy.delete(chatId);
  }
}
async function syncStatuses() {
  try {
    const { statuses } = await api("/api/statuses");
    for (const chatId of new Set([...busy, ...statusByChat.keys()])) if (!statuses[chatId]) applyStatus(chatId, null);
    for (const [chatId, s] of Object.entries(statuses)) applyStatus(chatId, s);
    renderSidebar();
    renderStatus();
  } catch {}
}
setInterval(() => busy.size && syncStatuses(), 30000);

function onProgress(ev) {
  if (ev.kind !== "tool") return; // thinking/status updates only drive the one-line status
  const list = steps.get(ev.chatId) ?? [];
  const key = ev.toolCallId || `${ev.toolName}:${list.length}`;
  let step = list.find((x) => x.id === key);
  if (!step) list.push((step = { id: key }));
  // Later events for the same call often drop toolName/details: keep what we had.
  if (ev.toolName) step.toolName = ev.toolName;
  if (ev.details) step.details = ev.details;
  if (ev.error) step.error = ev.error;
  step.state = /error|fail/.test(ev.state || "") ? "failed" : /complete|finish|done|success/.test(ev.state || "") ? "completed" : "running";
  step.title = [step.toolName, step.details].filter(Boolean).join(": ") || ev.title || "tool";
  steps.set(ev.chatId, list.slice(-60));
  if (ev.chatId === current?.chatId) renderStatus();
}

// ── Notifications, unread, tab title ────────────────────────────────────────
function renderNotifyBtn() {
  const btn = $("#notify");
  const blocked = "Notification" in window && Notification.permission === "denied";
  btn.textContent = notifyOn && !blocked ? "🔔" : "🔕";
  btn.title = blocked ? "Notifications are blocked for this site in the browser settings" : notifyOn ? "Desktop notifications: on" : "Desktop notifications: off";
}
$("#notify").onclick = async () => {
  if (!("Notification" in window)) return alert("This browser has no desktop notifications.");
  if (!notifyOn && Notification.permission !== "granted") {
    const p = await Notification.requestPermission();
    if (p !== "granted") return renderNotifyBtn();
  }
  notifyOn = !notifyOn;
  localStorage.setItem("notify", notifyOn ? "on" : "off");
  renderNotifyBtn();
};

function notify(m) {
  if (!notifyOn || !("Notification" in window) || Notification.permission !== "granted") return;
  if (m.chatId === current?.chatId && document.visibilityState === "visible" && document.hasFocus()) return;
  const agentId = chatAgent.get(m.chatId);
  const conv = convsByAgent.get(agentId)?.find((c) => c.chatId === m.chatId);
  const agent = agents.find((a) => a.id === agentId);
  const body = plain(m.text) || (m.media?.length ? `📎 ${m.media.map((x) => x.title || x.name).join(", ")}` : "");
  const n = new Notification(`${agent?.name ?? "Agent"} · ${conv?.title || m.chatId}`, { body, tag: m.chatId, icon: "/icon-192.png" });
  n.onclick = () => {
    window.focus();
    if (conv) open(viewOf(agentId, conv));
    n.close();
  };
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
    syncStatuses();
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
      if (m.chatId === current?.chatId) addMessage(m);
      const away = m.chatId !== current?.chatId || document.visibilityState !== "visible";
      if (m.role !== "user") {
        if (away) {
          unread.set(m.chatId, (unread.get(m.chatId) || 0) + 1);
          saveUnread();
        }
        notify(m);
      }
      touchConv(m.chatId, m.ts);
    }
    if (ev.type === "status") onStatus(ev);
    if (ev.type === "progress") onProgress(ev);
  };
}

// ── Lightbox gallery ────────────────────────────────────────────────────────
let gallery = [];
let galleryIndex = 0;
function showLightbox(i) {
  galleryIndex = (i + gallery.length) % gallery.length;
  const img = gallery[galleryIndex];
  lightbox.querySelector("img").src = img.src;
  lightbox.querySelector("figcaption").textContent = `${img.alt}  ·  ${galleryIndex + 1} / ${gallery.length}`;
  lightbox.querySelectorAll(".nav").forEach((b) => (b.hidden = gallery.length < 2));
  lightbox.hidden = false;
}
log.addEventListener("click", async (e) => {
  if (e.target.tagName === "IMG" && e.target.closest(".media")) {
    gallery = [...log.querySelectorAll(".media img")];
    showLightbox(gallery.indexOf(e.target));
  }
  const reveal = e.target.closest(".reveal");
  if (reveal) {
    try {
      await post("/api/reveal", { url: reveal.dataset.url });
    } catch (err) {
      alert(`Could not reveal: ${err.message}`);
    }
  }
});
lightbox.querySelector(".prev").onclick = (e) => (e.stopPropagation(), showLightbox(galleryIndex - 1));
lightbox.querySelector(".next").onclick = (e) => (e.stopPropagation(), showLightbox(galleryIndex + 1));
lightbox.addEventListener("click", () => (lightbox.hidden = true));

// ── Command palette (⌘K) ────────────────────────────────────────────────────
let paletteItems = [];
let paletteSel = 0;
async function openPalette() {
  await Promise.all(agents.filter((a) => !convsByAgent.has(a.id)).map((a) => loadConvs(a.id)));
  palette.hidden = false;
  const input = $("#palette-input");
  input.value = "";
  input.focus();
  renderPalette();
}
function closePalette() {
  palette.hidden = true;
  text.focus();
}
function renderPalette() {
  const q = $("#palette-input").value.trim().toLowerCase();
  const all = [];
  for (const agent of agents) {
    for (const c of convsByAgent.get(agent.id) ?? []) {
      const hay = `${c.title || ""} ${c.id} ${agent.name}`.toLowerCase();
      if (!q || q.split(/\s+/).every((w) => hay.includes(w))) all.push({ agent, c });
    }
  }
  const rank = (x) => (x.c.archived ? 2 : x.c.chatId ? 0 : 1);
  all.sort((a, b) => rank(a) - rank(b) || String(b.c.lastAt || "").localeCompare(String(a.c.lastAt || "")));
  paletteItems = all.slice(0, 50);
  paletteSel = Math.min(paletteSel, Math.max(0, paletteItems.length - 1));
  $("#palette-list").innerHTML =
    paletteItems
      .map(
        ({ agent, c }, i) =>
          `<li class="${i === paletteSel ? "sel" : ""}${c.chatId ? "" : " ro"}" data-i="${i}">${c.chatId ? "💬" : "👁"} ${esc(c.title || c.id)}<span class="pal-meta">${esc(agent.name)}${c.archived ? " · archived" : ""} · ${esc(ago(c.lastAt))}</span></li>`,
      )
      .join("") || '<li class="empty">No matches</li>';
  $("#palette-list").querySelector(".sel")?.scrollIntoView({ block: "nearest" });
}
function choosePalette(i) {
  const item = paletteItems[i];
  if (!item) return;
  closePalette();
  expanded.add(item.agent.id);
  open(viewOf(item.agent.id, item.c));
}
$("#palette-input").addEventListener("input", () => ((paletteSel = 0), renderPalette()));
$("#palette-input").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") (paletteSel = Math.min(paletteSel + 1, paletteItems.length - 1)), renderPalette(), e.preventDefault();
  else if (e.key === "ArrowUp") (paletteSel = Math.max(paletteSel - 1, 0)), renderPalette(), e.preventDefault();
  else if (e.key === "Enter") choosePalette(paletteSel), e.preventDefault();
  else if (e.key === "Escape") closePalette();
});
$("#palette-list").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-i]");
  if (li) choosePalette(Number(li.dataset.i));
});
palette.addEventListener("click", (e) => e.target === palette && closePalette());
$("#palette-btn").onclick = openPalette;

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    palette.hidden ? openPalette() : closePalette();
    return;
  }
  if (!lightbox.hidden) {
    if (e.key === "Escape") lightbox.hidden = true;
    if (e.key === "ArrowLeft") showLightbox(galleryIndex - 1);
    if (e.key === "ArrowRight") showLightbox(galleryIndex + 1);
  }
});

// ── Composer + slash commands ───────────────────────────────────────────────
let cmdItems = [];
let cmdSel = 0;
function renderCmdMenu() {
  const m = /^\/(\S*)$/.exec(text.value);
  cmdItems = m ? COMMANDS.filter(([name]) => name.startsWith(m[1].toLowerCase())) : [];
  if (!cmdItems.length || (cmdItems.length === 1 && `/${cmdItems[0][0]}` === text.value)) {
    cmdMenu.hidden = true;
    return;
  }
  cmdSel = Math.min(cmdSel, cmdItems.length - 1);
  cmdMenu.innerHTML = cmdItems.map(([name, desc], i) => `<li class="${i === cmdSel ? "sel" : ""}" data-i="${i}"><b>/${name}</b> <span>${esc(desc)}</span></li>`).join("");
  cmdMenu.hidden = false;
  cmdMenu.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
}
function pickCmd(i) {
  const item = cmdItems[i];
  if (!item) return;
  text.value = `/${item[0]}`;
  cmdMenu.hidden = true;
  text.focus();
}
cmdMenu.addEventListener("mousedown", (e) => {
  const li = e.target.closest("li[data-i]");
  if (li) (e.preventDefault(), pickCmd(Number(li.dataset.i)));
});
text.addEventListener("input", () => ((cmdSel = 0), renderCmdMenu()));
text.addEventListener("blur", () => setTimeout(() => (cmdMenu.hidden = true), 100));

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
  cmdMenu.hidden = true;
  try {
    await post("/api/send", body);
  } catch (err) {
    log.appendChild(renderMessage({ role: "system", ts: Date.now(), text: `Send failed: ${err.message}` }));
  }
}

composer.addEventListener("submit", (e) => (e.preventDefault(), send()));
text.addEventListener("keydown", (e) => {
  if (!cmdMenu.hidden) {
    if (e.key === "ArrowDown") return (cmdSel = Math.min(cmdSel + 1, cmdItems.length - 1)), renderCmdMenu(), e.preventDefault();
    if (e.key === "ArrowUp") return (cmdSel = Math.max(cmdSel - 1, 0)), renderCmdMenu(), e.preventDefault();
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) return pickCmd(cmdSel), e.preventDefault();
    if (e.key === "Escape") return (cmdMenu.hidden = true);
  }
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

// ── Boot ────────────────────────────────────────────────────────────────────
(async () => {
  renderNotifyBtn();
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
    if (c) current = { agentId: c.agentId, conversationId: c.conversationId, chatId: c.chatId, title: c.conversationId, archived: false };
  }
  if (current) {
    if (!convsByAgent.has(current.agentId)) await loadConvs(current.agentId).catch(() => {});
    const found = findConv(current.conversationId);
    if (found) current = viewOf(found.agentId, found.c);
    await open(current);
  } else renderHeader();
  connect();
})();
