import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server/index.mjs';

/** 起一个监听随机端口的真实 HTTP 服务，走完整的请求链路。 */
async function startApp(overrides = {}) {
  const app = createApp({
    // 指向一个必然连不上的地址，让搜索走“上游失败 → 离线样例”分支
    endpoints: ['http://127.0.0.1:1/api/search'],
    upstreamTimeout: 800,
    ...overrides,
  });
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
    app,
  };
}

test('GET / 返回首页 HTML', async (t) => {
  const { base, close } = await startApp();
  t.after(close);
  const res = await fetch(`${base}/`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(html, /<title>PanSeek/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
});

test('GET /api/meta 返回网盘类型与数据源', async (t) => {
  const { base, close } = await startApp();
  t.after(close);
  const res = await fetch(`${base}/api/meta`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.ok(json.panTypes.some((t2) => t2.id === 'quark'));
  assert.ok(json.sources.length >= 1);
});

test('GET /api/search 无关键词返回 400', async (t) => {
  const { base, close } = await startApp();
  t.after(close);
  const res = await fetch(`${base}/api/search`);
  const json = await res.json();
  assert.equal(res.status, 400);
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'bad_request');
});

test('上游不可用时回退离线样例，接口仍返回 200', async (t) => {
  const { base, close } = await startApp();
  t.after(close);
  const res = await fetch(`${base}/api/search?kw=${encodeURIComponent('繁花')}`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.demo, true);
  assert.ok(json.items.length > 0);
  assert.ok(json.items[0].url.startsWith('http') || json.items[0].url.startsWith('magnet:'));
  assert.ok(json.warnings.length > 0);
});

test('关闭离线兜底且上游全挂时返回 502', async (t) => {
  const { base, close } = await startApp({ demoFallback: false });
  t.after(close);
  const res = await fetch(`${base}/api/search?kw=${encodeURIComponent('繁花')}`);
  const json = await res.json();
  assert.equal(res.status, 502);
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'upstream_unavailable');
});

test('GET /api/health 暴露缓存与数据源状态', async (t) => {
  const { base, close } = await startApp();
  t.after(close);
  const res = await fetch(`${base}/api/health`);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.ok(json.cache);
  assert.ok(Array.isArray(json.adapters));
});

test('未知接口 404，未知页面回退首页', async (t) => {
  const { base, close } = await startApp();
  t.after(close);
  const api = await fetch(`${base}/api/nope`);
  assert.equal(api.status, 404);
  assert.equal((await api.json()).error.code, 'not_found');

  const page = await fetch(`${base}/some/unknown/route`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /PanSeek/);
});

test('静态服务不会泄漏项目文件', async (t) => {
  const { base, close } = await startApp();
  t.after(close);
  const res = await fetch(`${base}/..%2Fpackage.json`);
  const body = await res.text();
  assert.ok(!body.includes('"name": "panseek"'));
});
