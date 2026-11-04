/**
 * 用 Chrome DevTools Protocol 做页面验收：测量布局溢出、抓图。
 *
 *   node scripts/cdp-shot.mjs --url "http://127.0.0.1:8790/?kw=繁花" --out shots/a.png --width 390 --height 860 --mobile
 *
 * 需要先手动起一个带调试端口的 Chrome：
 *   chrome.exe --headless=new --remote-debugging-port=9333 --user-data-dir=%TEMP%\cdp-profile about:blank
 */
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 && args[i + 1] ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const PORT = Number(arg('port', '9333'));
const url = arg('url', 'http://127.0.0.1:8790/');
const out = arg('out', 'shots/cdp.png');
const width = Number(arg('width', '1280'));
const height = Number(arg('height', '900'));
const mobile = flag('mobile');
const scrollY = Number(arg('scroll', '0'));
const waitMs = Number(arg('wait', '25000'));

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('没有可用的 page target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
/** 页面侧的 JS 异常与 console.error，截图时一并核对 */
const pageErrors = [];
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    pageErrors.push(`exception: ${d.exception?.description || d.text}`);
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    pageErrors.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
  }
});
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
  return res.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', {
  width,
  height,
  deviceScaleFactor: mobile ? 2 : 1,
  mobile,
  screenWidth: width,
  screenHeight: height,
});
await send('Page.navigate', { url });

// 等待结果渲染出来（或出现错误态）
const deadline = Date.now() + waitMs;
let ready = false;
while (Date.now() < deadline) {
  const state = await evaluate(`(() => {
    const cards = document.querySelectorAll('.card').length;
    const err = document.querySelector('#error:not([hidden])');
    const empty = document.querySelector('#empty:not([hidden])');
    const loading = document.querySelector('.searchbar.loading');
    return { cards, err: !!err, empty: !!empty, loading: !!loading, title: document.title };
  })()`);
  if (state.err || state.empty || (state.cards > 0 && !state.loading)) {
    ready = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 250));
}

if (scrollY > 0) {
  await evaluate(`window.scrollTo(0, ${scrollY})`);
  await new Promise((r) => setTimeout(r, 400));
}

const metrics = await evaluate(`(() => {
  const vw = window.innerWidth;
  const de = document.documentElement;
  const hero = document.querySelector('#hero');
  const offenders = [];
  for (const node of document.querySelectorAll('body *')) {
    const r = node.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > vw + 1.5 || r.left < -1.5) {
      offenders.push({
        tag: node.tagName.toLowerCase(),
        cls: String(node.className || '').slice(0, 40),
        left: Math.round(r.left),
        right: Math.round(r.right),
        w: Math.round(r.width),
      });
    }
  }
  return {
    vw,
    scrollWidth: de.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    scrollTop: Math.round(window.scrollY),
    heroTop: hero ? Math.round(hero.getBoundingClientRect().top) : null,
    cards: document.querySelectorAll('.card').length,
    fontFamily: getComputedStyle(document.body).fontFamily.slice(0, 60),
    offenders: offenders.slice(0, 12),
  };
})()`);

console.log(JSON.stringify({ url, width, height, mobile, ready, pageErrors, ...metrics }, null, 2));

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const fs = await import('node:fs/promises');
await fs.mkdir(new URL('../docs/', import.meta.url), { recursive: true });
const target = out.startsWith('docs/') ? out : `docs/${out}`;
await fs.writeFile(target, Buffer.from(shot.data, 'base64'));
console.log(`saved ${target}`);
ws.close();
if (pageErrors.length) process.exitCode = 1;
