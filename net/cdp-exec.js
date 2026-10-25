/* cdp-exec.js — 在页面内 fetch game.js 并实际执行，验证内容可执行性 */
const DEBUG_PORT = 9222;

(async () => {
  const url = process.argv[2] || "http://127.0.0.1:8899/index.html";
  const jsUrl = process.argv[3] || "http://127.0.0.1:8899/js/game.js";
  const waitMs = Number(process.argv[4] || 3000);

  const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
  const page = list.find(t => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    setTimeout(() => rej(new Error("timeout " + method)), 20000);
  });
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url });
  await new Promise(r => setTimeout(r, waitMs));

  /* 在页面上下文 fetch + 执行 game.js，捕获任何错误 */
  const expr = `(async () => {
    try {
      const src = await (await fetch(${JSON.stringify(jsUrl)})).text();
      const fn = new Function(src + "; return { G: typeof G, Room: typeof Room, startGame: typeof startGame, ARENA: typeof ARENA, canvas: typeof canvas };");
      const r = fn();
      return "EXEC-OK " + JSON.stringify(r);
    } catch (e) {
      return "EXEC-FAIL " + (e && e.stack ? e.stack.split("\\n").slice(0,4).join(" | ") : String(e));
    }
  })()`;
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  console.log("RESULT:", r.result && r.result.result && r.result.result.value);
  ws.close();
  process.exit(0);
})().catch(e => { console.error("FATAL", e.message); process.exit(1); });
