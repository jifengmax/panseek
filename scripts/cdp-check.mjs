/**
 * 前端功能自检：切换网盘类型、加载更多、统计文案是否一致。
 *
 *   node scripts/cdp-check.mjs --url "http://127.0.0.1:8790/?kw=繁花"
 *
 * 依赖一个开着 --remote-debugging-port=9333 的 Chrome。
 */
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(arg('port', '9333'));
const url = arg('url', 'http://127.0.0.1:8790/?kw=%E7%B9%81%E8%8A%B1');

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
});
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
const send = (method, params = {}) => {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
};
const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error(`${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description ?? ''}`);
  return res.result.value;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(expression, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true;
    await sleep(200);
  }
  return false;
}

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await waitFor(`document.querySelectorAll('.card').length > 0 || !document.querySelector('#error').hidden`);

const snapshot = () =>
  evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.tab')].map((t) => ({
      text: t.textContent.trim(),
      active: t.getAttribute('aria-selected') === 'true',
    }));
    const badges = [...document.querySelectorAll('.card .badge')].map((b) => b.textContent.trim());
    const uniq = [...new Set(badges)];
    return {
      cards: document.querySelectorAll('.card').length,
      stat: document.querySelector('#statText').textContent.trim(),
      tabs,
      activeTab: (tabs.find((t) => t.active) || {}).text || '',
      badges: uniq,
      passwords: document.querySelectorAll('.card .pwd').length,
      moreText: document.querySelector('#moreBtn').hidden ? '' : document.querySelector('#moreBtn').textContent.trim(),
      notice: document.querySelector('#notice').hidden ? '' : document.querySelector('#notice').textContent.trim().slice(0, 120),
      error: document.querySelector('#error').hidden ? '' : document.querySelector('#errorText').textContent.trim(),
    };
  })()`);

const report = { url, steps: [], problems: [] };
const first = await snapshot();
report.steps.push({ step: '初始结果', ...first });
if (first.error) report.problems.push(`搜索失败：${first.error}`);
if (first.cards === 0) report.problems.push('首页没有任何结果卡片');

// 切到第二个网盘类型
const target = first.tabs[1];
if (target) {
  const typeName = target.text.replace(/\s*\d+$/, '');
  const clicked = await evaluate(`(() => {
    const tab = [...document.querySelectorAll('.tab')].find((t) => t.textContent.trim() === ${JSON.stringify(target.text)});
    if (!tab) return false;
    tab.click();
    return true;
  })()`);
  if (clicked) {
    await waitFor(
      `[...document.querySelectorAll('.tab')].some((t) => t.getAttribute('aria-selected') === 'true' && t.textContent.trim() === ${JSON.stringify(target.text)})`
    );
    await sleep(600);
    const after = await snapshot();
    report.steps.push({ step: `切换到「${typeName}」`, ...after });
    if (after.cards === 0) report.problems.push(`「${typeName}」筛选后没有卡片`);
    if (after.badges.length > 1) report.problems.push(`筛选「${typeName}」后仍混有其他网盘：${after.badges.join('/')}`);
  }
}

// 加载更多
const moreBefore = await snapshot();
if (moreBefore.moreText) {
  await evaluate(`document.querySelector('#moreBtn').click()`);
  await sleep(300);
  const after = await snapshot();
  report.steps.push({ step: '加载更多', ...after });
  if (!(after.cards > moreBefore.cards)) report.problems.push('点击「加载更多」后卡片数没有增加');
}

// 切回全部
await evaluate(`(() => {
  const tab = [...document.querySelectorAll('.tab')].find((t) => t.textContent.trim().startsWith('全部'));
  if (tab) tab.click();
})()`);
await waitFor(`[...document.querySelectorAll('.tab')].some((t) => t.getAttribute('aria-selected') === 'true' && t.textContent.trim().startsWith('全部'))`);
await sleep(500);
const back = await snapshot();
report.steps.push({ step: '切回全部', ...back });

// 检查 URL 是否同步
report.urlAfter = await evaluate('location.search');
report.title = await evaluate('document.title');

console.log(JSON.stringify(report, null, 2));
ws.close();
process.exit(report.problems.length ? 1 : 0);
