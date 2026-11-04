import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildItem,
  cleanTitle,
  cleanUrl,
  detectPanType,
  extractLinks,
  extractPassword,
  extractSize,
  identityOf,
  mapUpstreamType,
  parseTime,
} from '../server/core/normalize.mjs';

test('detectPanType 识别常见网盘域名', () => {
  const cases = [
    ['https://pan.quark.cn/s/334310e1c46b', 'quark'],
    ['https://www.aliyundrive.com/s/qPkPCAqA2XZ', 'aliyun'],
    ['https://www.alipan.com/s/abc', 'aliyun'],
    ['https://pan.baidu.com/s/1N_92btX8NSCfmiSHrsMppQ', 'baidu'],
    ['https://115cdn.com/s/swwm6qr3zrk?password=k442', 'pan115'],
    ['https://pan.xunlei.com/s/VOfe', 'xunlei'],
    ['https://drive.uc.cn/s/e627907604fd4', 'uc'],
    ['https://cloud.189.cn/t/vANJvyJjYFzq', 'tianyi'],
    ['https://123865.com/s/RWJUVv-02Iq', 'pan123'],
    ['https://caiyun.139.com/m/i?abc', 'mobile'],
    ['https://toapp.mypikpak.com/toapp?x=1', 'pikpak'],
    ['magnet:?xt=urn:btih:65eac78944f5acbc4e2df7305a1cf05a6eea6721', 'magnet'],
    ['https://example.com/file', 'other'],
    ['not a url', 'other'],
  ];
  for (const [url, expected] of cases) {
    assert.equal(detectPanType(url), expected, url);
  }
});

test('cleanUrl 去标点、去跟踪参数、保留提取码', () => {
  assert.equal(cleanUrl('https://pan.quark.cn/s/abc。'), 'https://pan.quark.cn/s/abc');
  assert.equal(
    cleanUrl('https://pan.baidu.com/s/1x?pwd=abcd&utm_source=tg&utm_medium=x'),
    'https://pan.baidu.com/s/1x?pwd=abcd'
  );
  assert.equal(cleanUrl('pan.quark.cn/s/xyz'), 'https://pan.quark.cn/s/xyz');
  assert.equal(cleanUrl('https://pan.quark.cn/s/abc#section'), 'https://pan.quark.cn/s/abc');
  assert.equal(
    cleanUrl('magnet:?xt=urn:btih:65EAC78944F5ACBC4E2DF7305A1CF05A6EEA6721&dn=x'),
    'magnet:?xt=urn:btih:65EAC78944F5ACBC4E2DF7305A1CF05A6EEA6721'
  );
  assert.equal(cleanUrl('javascript:alert(1)'), '');
  assert.equal(cleanUrl(''), '');
});

test('extractPassword 支持链接参数与正文提取码', () => {
  assert.equal(extractPassword('https://pan.baidu.com/s/1x?pwd=Yu66'), 'Yu66');
  assert.equal(extractPassword('https://pan.xunlei.com/s/VOfe?pwd=6kiy'), '6kiy');
  assert.equal(extractPassword('https://pan.quark.cn/s/abc', '资源名 提取码：k442'), 'k442');
  assert.equal(extractPassword('https://pan.quark.cn/s/abc', '密码: 8x9z'), '8x9z');
  // 少标点时提取码会和后面的 URL 粘在一起
  assert.equal(extractPassword('https://pan.baidu.com/s/abc', '提取码：8888https://pan.baidu.com/s/def'), '8888');
  assert.equal(extractPassword('https://pan.quark.cn/s/abc', '没有密码'), '');
});

test('extractSize 归一化体积单位', () => {
  assert.equal(extractSize('大小：40.2GB'), '40.2GB');
  assert.equal(extractSize('73.3 G 蓝光'), '73.3GB');
  assert.equal(extractSize('[2.81G]'), '2.81GB');
  assert.equal(extractSize('约 900 MB'), '900MB');
  assert.equal(extractSize('无'), '');
});

test('cleanTitle 去掉表情与“名称：”前缀', () => {
  assert.equal(cleanTitle('🎬 电影｜流浪地球 (2019) 4K'), '电影｜流浪地球 (2019) 4K');
  assert.equal(cleanTitle('资源名称：[流浪地球2]'), '[流浪地球2]');
  assert.equal(cleanTitle('   \n  '), '未命名资源');
  assert.ok(cleanTitle('x'.repeat(400)).length <= 181);
});

test('cleanTitle 剔除标题里混入的链接', () => {
  assert.equal(
    cleanTitle('10月22日短剧更新72.戈壁繁花 (145集) https://pan.quark.cn/s/2fc901acd1c6 https://pan.baidu.com/s/1QSA'),
    '10月22日短剧更新72.戈壁繁花 (145集)'
  );
  assert.equal(
    cleanTitle('流浪地球2 magnet:?xt=urn:btih:AAA111 4K'),
    '流浪地球2 4K'
  );
});

test('parseTime 丢弃占位与未来时间', () => {
  assert.equal(parseTime('0001-01-01T00:00:00Z'), 0);
  assert.equal(parseTime(''), 0);
  assert.equal(parseTime('不是时间'), 0);
  assert.ok(parseTime('2024-03-05T06:28:00Z') > 0);
  assert.equal(parseTime('2999-01-01T00:00:00Z'), 0);
});

test('identityOf 忽略提取码差异，按资源路径归并', () => {
  const a = identityOf('https://pan.quark.cn/s/abc?pwd=1234', 'quark');
  const b = identityOf('https://pan.quark.cn/s/abc', 'quark');
  assert.equal(a, b);
  const m = identityOf('magnet:?xt=urn:btih:ABC123&dn=x', 'magnet');
  assert.equal(m, 'magnet:abc123');
});

test('extractLinks 从频道正文里抖出多条链接', () => {
  const text =
    '名称：繁花 4K\n夸克：https://pan.quark.cn/s/334310e1c46b 提取码：k442\n' +
    '迅雷：https://pan.xunlei.com/s/VOfeEubAtnvSGbvf7cW1otHnA1?pwd=6kiy\n' +
    '百度网盘：https://pan.baidu.com/s/1N_92btX8NSCfmiSHrsMppQ 提取码：Yu66\n' +
    '磁力：magnet:?xt=urn:btih:65eac78944f5acbc4e2df7305a1cf05a6eea6721';
  const links = extractLinks(text);
  assert.equal(links.length, 4);
  assert.equal(links[0].url, 'https://pan.quark.cn/s/334310e1c46b');
  assert.equal(links[0].password, 'k442');
  assert.equal(links[2].password, 'Yu66');
  assert.equal(detectPanType(links[3].url), 'magnet');
});

test('buildItem 生成统一结构', () => {
  const item = buildItem(
    {
      url: 'https://pan.baidu.com/s/1N_92btX8NSCfmiSHrsMppQ?pwd=Yu66',
      note: '🗄 流浪地球/流浪地球2 合集 大小：40.2GB',
      datetime: '2026-01-15T09:19:14Z',
      source: 'tg:yunpanx',
    },
    { source: 'pansou' }
  );
  assert.ok(item);
  assert.equal(item.panType, 'baidu');
  assert.equal(item.panName, '百度网盘');
  assert.equal(item.password, 'Yu66');
  assert.equal(item.size, '40.2GB');
  assert.equal(item.channel, 'yunpanx');
  assert.equal(item.source, 'pansou');
  assert.ok(item.ts > 0);
  assert.ok(item.id.length >= 4);
  assert.deepEqual(buildItem({ url: 'javascript:1' }), null);
});

test('mapUpstreamType 映射上游分类', () => {
  assert.equal(mapUpstreamType('115'), 'pan115');
  assert.equal(mapUpstreamType('123'), 'pan123');
  assert.equal(mapUpstreamType('quark'), 'quark');
  assert.equal(mapUpstreamType('unknown'), 'other');
});
