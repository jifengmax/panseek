/**
 * 生成离线样例数据 data/demo.json。
 *
 *   node scripts/build-demo.mjs
 *   node scripts/build-demo.mjs --keywords 流浪地球,三体 --per-type 2 --delay 4000
 *
 * 公共实例对连续请求不太友好，脚本默认每次请求之间等待几秒，失败会重试一次。
 * 数据只保留展示必需字段（去掉图片 URL），以便随仓库分发。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINT = process.env.PANSOU_ENDPOINTS?.split(',')[0]?.trim() || 'https://so.252035.xyz/api/search';

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx > -1 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const keywords = arg(
  'keywords',
  '流浪地球,三体,繁花,奥本海默,肖申克的救赎,甄嬛传,进击的巨人,鬼灭之刃,周杰伦,Photoshop,Office,Python,Kindle,黑神话悟空,PPT模板,国家地理'
).split(',');
const perType = Number.parseInt(arg('per-type', '3'), 10);
const delay = Number.parseInt(arg('delay', '4500'), 10);
const OUT = path.join(ROOT, 'data', 'demo.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const merged = {};
const seen = new Set();
let total = 0;

async function fetchWithRetry(kw) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(`${ENDPOINT}?kw=${encodeURIComponent(kw)}`, {
        headers: { 'user-agent': 'Mozilla/5.0 PanSeek-demo-builder' },
        signal: AbortSignal.timeout(25_000),
      });
      const text = await res.text();
      const json = JSON.parse(text);
      if (json?.data?.merged_by_type) return json;
      throw new Error(`结构异常（HTTP ${res.status}）`);
    } catch (err) {
      if (attempt === 1) throw err;
      await sleep(6000);
    }
  }
  return null;
}

for (const [index, kw] of keywords.entries()) {
  process.stdout.write(`[${index + 1}/${keywords.length}] 「${kw}」… `);
  let added = 0;
  try {
    const json = await fetchWithRetry(kw);
    for (const [type, list] of Object.entries(json?.data?.merged_by_type || {})) {
      if (!Array.isArray(list)) continue;
      merged[type] ||= [];
      let taken = 0;
      for (const entry of list) {
        if (taken >= perType) break;
        if (!entry?.url || seen.has(entry.url)) continue;
        seen.add(entry.url);
        merged[type].push({
          url: entry.url,
          password: entry.password || '',
          note: String(entry.note || '').slice(0, 150),
          datetime: entry.datetime || '',
          source: entry.source || '',
        });
        taken += 1;
        total += 1;
        added += 1;
      }
    }
    console.log(`+${added} 条`);
  } catch (err) {
    console.log(`失败：${err.message}`);
  }
  if (index < keywords.length - 1) await sleep(delay);
}

for (const type of Object.keys(merged)) merged[type].sort((a, b) => (a.datetime < b.datetime ? 1 : -1));

const payload = {
  _meta: {
    generatedAt: new Date().toISOString(),
    endpoint: ENDPOINT,
    keywords,
    note: '离线样例数据，仅用于演示与上游不可用时的兜底；资源均来自第三方公开频道。',
  },
  code: 0,
  message: 'success',
  data: { total, merged_by_type: merged, results: [] },
};

await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, `${JSON.stringify(payload, null, 1)}\n`, 'utf8');
const stat = await fs.stat(OUT);
console.log(`\n已写入 ${path.relative(ROOT, OUT)}：${total} 条，${(stat.size / 1024).toFixed(1)} KB`);
