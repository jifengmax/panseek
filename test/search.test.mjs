import test from 'node:test';
import assert from 'node:assert/strict';
import { TtlCache, Inflight } from '../server/cache.mjs';
import { createSearchService, BadRequestError } from '../server/core/search.mjs';
import { config as baseConfig } from '../server/config.mjs';

const item = (over = {}) => ({
  id: Math.random().toString(36).slice(2),
  title: '流浪地球',
  url: 'https://pan.quark.cn/s/abc',
  panType: 'quark',
  panName: '夸克网盘',
  password: '',
  size: '',
  ts: 0,
  datetime: '',
  channel: 'demo',
  source: 'test',
  desc: '',
  ...over,
});

function makeService({ adapters, demoAdapter = null, overrides = {} }) {
  const config = { ...baseConfig, demoFallback: false, ...overrides };
  const cache = new TtlCache(config.cacheTtl, config.cacheMax);
  const inflight = new Inflight();
  const service = createSearchService({
    config,
    adapters,
    cache,
    inflight,
    demoAdapter,
    log: { warn() {} },
  });
  return { service, cache };
}

test('相同关键词命中缓存，只打一次上游', async () => {
  let calls = 0;
  const adapter = {
    id: 'stub',
    label: '测试源',
    async search() {
      calls += 1;
      return { items: [item(), item({ url: 'https://pan.baidu.com/s/xyz', panType: 'baidu' })], took: 1, total: 2 };
    },
  };
  const { service } = makeService({ adapters: [adapter] });

  const first = await service.search('流浪地球');
  const second = await service.search('流浪地球');

  assert.equal(calls, 1);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(first.total, 2);
  assert.deepEqual(
    first.types.map((t) => t.id).sort(),
    ['baidu', 'quark']
  );
});

test('按网盘类型筛选与条数限制', async () => {
  const adapter = {
    id: 'stub',
    label: '测试源',
    async search() {
      return {
        items: [
          item({ title: 'A', panType: 'quark', url: 'https://pan.quark.cn/s/a' }),
          item({ title: 'B', panType: 'baidu', url: 'https://pan.baidu.com/s/b' }),
          item({ title: 'C', panType: 'quark', url: 'https://pan.quark.cn/s/c' }),
        ],
        took: 1,
        total: 3,
      };
    },
  };
  const { service } = makeService({ adapters: [adapter] });

  const quark = await service.search('A', { type: 'quark' });
  assert.equal(quark.total, 2);
  assert.ok(quark.items.every((i) => i.panType === 'quark'));

  const limited = await service.search('A', { limit: 1 });
  assert.equal(limited.items.length, 1);
  assert.equal(limited.truncated, true);
});

test('sort=latest 返回按时间倒序的结果', async () => {
  const now = Date.now();
  const adapter = {
    id: 'stub',
    label: '测试源',
    async search() {
      return {
        items: [
          item({ title: 'old', ts: now - 50 * 86400000, url: 'https://pan.quark.cn/s/1' }),
          item({ title: 'new', ts: now - 86400000, url: 'https://pan.quark.cn/s/2' }),
        ],
        took: 1,
        total: 2,
      };
    },
  };
  const { service } = makeService({ adapters: [adapter] });
  const res = await service.search('x', { sort: 'latest' });
  assert.equal(res.items[0].title, 'new');
});

test('上游失败时回退离线样例并给出告警', async () => {
  const adapter = {
    id: 'broken',
    label: '坏掉的数据源',
    async search() {
      throw new Error('connect ECONNREFUSED');
    },
  };
  const demoAdapter = {
    id: 'demo',
    label: '离线样例',
    async search() {
      return { items: [item({ title: '离线数据' })], took: 0, total: 1 };
    },
  };
  const { service } = makeService({ adapters: [adapter], demoAdapter });

  const res = await service.search('孤独');
  assert.equal(res.demo, true);
  assert.equal(res.items.length, 1);
  assert.ok(res.warnings.some((w) => w.includes('坏掉的数据源')));
  assert.equal(res.sources[0].ok, false);
});

test('所有数据源失败且样例也没结果时，抛 502 语义的错误', async () => {
  const adapter = {
    id: 'broken',
    label: '坏掉的数据源',
    async search() {
      throw new Error('boom');
    },
  };
  const demoAdapter = { id: 'demo', label: '离线样例', async search() {
    return { items: [], took: 0, total: 0 };
  } };
  const { service } = makeService({ adapters: [adapter], demoAdapter });
  await assert.rejects(
    () => service.search('完全不存在的关键词'),
    (err) => {
      assert.equal(err.status, 502);
      assert.match(err.message, /坏掉的数据源/);
      return true;
    }
  );
});

test('离线样例结果不写缓存，上游恢复后立刻拿真实数据', async () => {
  let calls = 0;
  const adapter = {
    id: 'flaky',
    label: '不稳定数据源',
    async search() {
      calls += 1;
      throw new Error('timeout');
    },
  };
  const demoAdapter = {
    id: 'demo',
    label: '离线样例',
    async search() {
      return { items: [item({ title: '样例' })], took: 0, total: 1 };
    },
  };
  const { service } = makeService({ adapters: [adapter], demoAdapter });
  const first = await service.search('离线');
  const second = await service.search('离线');
  assert.equal(first.demo, true);
  assert.equal(second.demo, true);
  assert.equal(second.cached, false);
  assert.equal(calls, 2);
});

test('关键词为空或过长时报 400', async () => {
  const { service } = makeService({ adapters: [] });
  await assert.rejects(() => service.search('   '), BadRequestError);
  await assert.rejects(() => service.search('x'.repeat(100)), BadRequestError);
});

test('meta 暴露网盘类型与热门词', () => {
  const { service } = makeService({ adapters: [] });
  const meta = service.meta();
  assert.ok(meta.panTypes.length >= 10);
  assert.ok(meta.hot.length > 0);
  assert.equal(meta.sorts.length, 3);
});

test('TtlCache 过期后不再命中', async () => {
  const cache = new TtlCache(20, 10);
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(cache.get('a'), undefined);
});
