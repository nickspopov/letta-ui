// Smoke check for the Letta UI page over the Chrome DevTools Protocol.
//
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
//     --remote-debugging-port=9333 --user-data-dir=/tmp/letta-ui-cdp about:blank &
//   bun scripts/cdp-smoke.mjs [http://127.0.0.1:4610/]
//
// Loads the page, waits for the sidebar, screenshots it (/tmp/letta-ui-a.png), then
// opens the first read-only conversation it can find and screenshots that
// (/tmp/letta-ui-b.png). Plain `chrome --screenshot` snaps before async fetches
// finish, which is why this goes through CDP.

const url = process.argv[2] || "http://127.0.0.1:4610/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let targets;
for (let i = 0; i < 40 && !targets; i++) {
  try {
    targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
  } catch {
    await sleep(250);
  }
}
if (!targets) throw new Error("No Chrome on :9333 (start it with --remote-debugging-port=9333)");
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let seq = 0;
const waits = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waits.has(m.id)) {
    waits.get(m.id)(m);
    waits.delete(m.id);
  }
  if (m.method === "Runtime.exceptionThrown") console.log("PAGE EXCEPTION", JSON.stringify(m.params.exceptionDetails).slice(0, 400));
};
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = ++seq;
    waits.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evalJs = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const shot = async (file) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  await Bun.write(file, Buffer.from(r.result.data, "base64"));
};

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1300, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url });
await sleep(3000);
await shot("/tmp/letta-ui-a.png");
console.log("sidebar:", await evalJs(`[...document.querySelectorAll('.agent-head,.conv,.group')].map(e=>e.textContent.replace(/\\s+/g,' ').trim()).slice(0,20).join(' | ')`));

// Expand every agent and its read-only group, then open the first read-only conversation.
await evalJs(`[...document.querySelectorAll('.agent-head')].forEach(h => h.querySelector('.caret').textContent === '▸' && h.click())`);
await sleep(1500);
await evalJs(`[...document.querySelectorAll('.group')].forEach(g => g.textContent.startsWith('▸') && g.click())`);
await sleep(500);
const opened = await evalJs(`(() => { const c = document.querySelector('.conv.ro'); if (!c) return null; c.click(); return c.textContent.trim(); })()`);
if (opened) {
  await sleep(2000);
  console.log("read-only:", opened, await evalJs(`JSON.stringify({composerHidden: document.querySelector('#composer').hidden, banner: !document.querySelector('#readonly').hidden, messages: document.querySelectorAll('#log .msg').length})`));
  await shot("/tmp/letta-ui-b.png");
} else console.log("read-only: none found");
process.exit(0);
