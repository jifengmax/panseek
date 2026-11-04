import test from 'node:test';
import assert from 'node:assert/strict';
import { createPansouAdapter, parsePansouPayload, UpstreamError } from '../server/adapters/pansou.mjs';

const payload = {
  code: 0,
  message: 'success',
  data: {
    total: 3,
    merged_by_type: {
      quark: [
        {
          url: 'https://pan.quark.cn/s/334310e1c46b',
          password: '',
          note: '流浪地球(两部合集)【蓝光4K】',
          datetime: '2024-02-13T03:09:44Z',
          source: 'tg:dianying4k',
        },
      ],
      baidu: [
        {
          url: 'https://pan.baidu.com/s/1N_92btX8NSCfmiSHrsMppQ?pwd=Yu66',
          password: 'Yu66',
          note: '流浪地球2 大小：40.2GB',
          datetime: '2024-01-15T09:19:14Z',
          source: 'tg:yunpanx',
        },
      ],
    },
    results: [
      {
        channel: 'QuarkFree',
        datetime: '2024-03-01T00:00:00Z',
        title: '流浪地球2 4K 中字',
        content: '介绍很长的一段文字……\n夸克：https://pan.quark.cn/s/aaa111 提取码：qwer\n天翼：https://cloud.189.cn/t/vANJvyJjYFzq',
      },
    ],
  },
};

test('parsePansouPayload 同时解析分类结果与原始频道消息', () => {
  const { items, total } = parsePansouPayload(payload);
  assert.equal(total, 3);

  const quark = items.find((i) => i.url === 'https://pan.quark.cn/s/334310e1c46b');
  assert.ok(quark);
  assert.equal(quark.panName, '夸克网盘');
  assert.equal(quark.channel, 'dianying4k');

  const baidu = items.find((i) => i.panType === 'baidu');
  assert.equal(baidu.password, 'Yu66');
  assert.equal(baidu.size, '40.2GB');

  const fromChannel = items.filter((i) => i.source === 'channel');
  assert.equal(fromChannel.length, 2);
  assert.equal(fromChannel.find((i) => i.panType === 'quark').password, 'qwer');
  assert.equal(fromChannel[0].channel, 'QuarkFree');
});

test('频道消息标题过短时从正文补全', () => {
  const { items } = parsePansouPayload({
    code: 0,
    data: {
      results: [
        {
          channel: 'melost',
          title: '繁花',
          datetime: '2024-03-01T00:00:00Z',
          content: '繁花 (2023) 4K 全30集 内封中字 描述：九十年代上海滩的故事 夸克：https://pan.quark.cn/s/bbb222 提取码：ab12',
        },
      ],
    },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '繁花 (2023) 4K 全30集 内封中字');
  assert.equal(items[0].password, 'ab12');
});

test('createPansouAdapter 在首个接口 404 时切换到备用接口', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.startsWith('https://bad.example')) return new Response('nope', { status: 404 });
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const adapter = createPansouAdapter({
    endpoints: ['https://bad.example/api/search', 'https://good.example/api/search'],
    timeout: 2000,
    fetchImpl,
  });
  const result = await adapter.search('流浪地球');
  assert.equal(result.endpoint, 'https://good.example/api/search');
  assert.ok(result.items.length >= 4);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /kw=%E6%B5%81%E6%B5%AA%E5%9C%B0%E7%90%83/);
  assert.match(calls[1], /res=all/);
});

test('createPansouAdapter 全部失败时抛错', async () => {
  const adapter = createPansouAdapter({
    endpoints: ['https://a.example/search'],
    timeout: 500,
    fetchImpl: async () => new Response('{}', { status: 502 }),
  });
  await assert.rejects(() => adapter.search('test'), (err) => {
    assert.ok(err instanceof UpstreamError);
    assert.match(err.message, /502/);
    return true;
  });
});

test('createPansouAdapter 对限流页重试一次', async () => {
  let n = 0;
  const adapter = createPansouAdapter({
    endpoints: ['https://a.example/search'],
    timeout: 1000,
    fetchImpl: async () => {
      n += 1;
      if (n === 1) return new Response('<html>rate limited</html>', { status: 200 });
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  });
  const result = await adapter.search('x');
  assert.equal(n, 2);
  assert.ok(result.items.length > 0);
});

test('createPansouAdapter 无法识别结构时抛错', async () => {
  const adapter = createPansouAdapter({
    endpoints: ['https://a.example/search'],
    timeout: 500,
    fetchImpl: async () => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }),
  });
  await assert.rejects(() => adapter.search('x'), /结构无法识别/);
});
