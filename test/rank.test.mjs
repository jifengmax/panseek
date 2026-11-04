import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupe, scoreItem, sortItems, titleRank, typeCounts } from '../server/core/rank.mjs';

const item = (over = {}) => ({
  id: over.id || Math.random().toString(36).slice(2),
  title: '流浪地球',
  url: 'https://pan.quark.cn/s/abc',
  panType: 'quark',
  panName: '夸克网盘',
  password: '',
  size: '',
  ts: 0,
  datetime: '',
  channel: '',
  source: 'pansou',
  desc: '',
  ...over,
});

test('dedupe 合并同一资源的多条记录', () => {
  const merged = dedupe([
    item({ url: 'https://pan.quark.cn/s/abc', channel: 'chanA', ts: 1000 }),
    item({ url: 'https://pan.quark.cn/s/abc?pwd=1234', password: '1234', channel: 'chanB', ts: 5000, title: '流浪地球 4K HDR 合集' }),
    item({ url: 'https://pan.baidu.com/s/xyz', panType: 'baidu', channel: 'chanC' }),
  ]);
  assert.equal(merged.length, 2);
  const quark = merged.find((i) => i.panType === 'quark');
  assert.equal(quark.password, '1234');
  assert.equal(quark.ts, 5000);
  assert.deepEqual(quark.channels.sort(), ['chanA', 'chanB']);
  assert.ok(quark.title.includes('4K'));
});

test('dedupe 保留磁力 infoHash 不同的条目', () => {
  const merged = dedupe([
    item({ url: 'magnet:?xt=urn:btih:AAA111', panType: 'magnet' }),
    item({ url: 'magnet:?xt=urn:btih:BBB222', panType: 'magnet' }),
  ]);
  assert.equal(merged.length, 2);
});

test('titleRank 区分开头命中与包含命中', () => {
  assert.equal(titleRank('流浪地球2 4K', '流浪地球'), 3);
  assert.equal(titleRank('【合集】流浪地球', '流浪地球'), 2);
  assert.equal(titleRank('三体 全集', '流浪地球'), 0);
  assert.equal(titleRank('The Wandering Earth', 'earth'), 2);
});

test('sortItems latest 按时间倒序', () => {
  const now = Date.now();
  const sorted = sortItems(
    [
      item({ title: 'a', ts: now - 10 * 86400000 }),
      item({ title: 'b', ts: now - 86400000 }),
      item({ title: 'c', ts: now - 100 * 86400000 }),
    ],
    'a',
    'latest'
  );
  assert.deepEqual(
    sorted.map((i) => i.title),
    ['b', 'a', 'c']
  );
});

test('sortItems relevance 把开头命中排前面', () => {
  const now = Date.now();
  const sorted = sortItems(
    [
      item({ title: '【4K】流浪地球 蓝光', ts: now - 86400000 }),
      item({ title: '流浪地球2 高清', ts: now - 200 * 86400000, password: '1234' }),
    ],
    '流浪地球',
    'relevance'
  );
  assert.equal(sorted[0].title, '流浪地球2 高清');
});

test('scoreItem 有提取码与更新的结果得分更高', () => {
  const now = Date.now();
  const base = scoreItem(item({ title: '流浪地球2', ts: now - 300 * 86400000 }), '流浪地球', now);
  const better = scoreItem(item({ title: '流浪地球2', ts: now - 86400000, password: 'x', size: '4GB' }), '流浪地球', now);
  assert.ok(better > base, `${better} > ${base}`);
});

test('scoreItem 对“标题只有关键词”的结果降权', () => {
  const now = Date.now();
  const bare = scoreItem(item({ title: '繁花', ts: now - 86400000 }), '繁花', now);
  const rich = scoreItem(item({ title: '繁花 (2023) 4K 全30集 内封中字', ts: now - 86400000 }), '繁花', now);
  assert.ok(rich > bare, `rich=${rich} bare=${bare}`);
});

test('typeCounts 按固定顺序统计', () => {
  const counts = typeCounts([
    item({ panType: 'baidu' }),
    item({ panType: 'quark' }),
    item({ panType: 'quark' }),
    item({ panType: 'magnet' }),
    item({ panType: 'other' }),
  ]);
  assert.deepEqual(counts, [
    { id: 'quark', count: 2 },
    { id: 'baidu', count: 1 },
    { id: 'magnet', count: 1 },
    { id: 'other', count: 1 },
  ]);
});
