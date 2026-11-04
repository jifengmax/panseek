/**
 * 上游接口体检：连续请求几次，看状态码、耗时、返回体大小与结构是否符合预期。
 *
 *   node scripts/check-upstream.mjs
 *   node scripts/check-upstream.mjs --kw 三体 --endpoint https://so.252035.xyz/api/search --times 3
 *
 * 用来快速判断“搜索结果为空”到底是上游挂了、被限流了，还是结构变了。
 */
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 && args[i + 1] ? args[i + 1] : fallback;
};

const kw = arg('kw', '流浪地球');
const endpoint = arg('endpoint', process.env.PANSOU_ENDPOINTS?.split(',')[0]?.trim() || 'https://so.252035.xyz/api/search');
const times = Number(arg('times', '3'));

console.log(`上游：${endpoint}\n关键词：${kw}\n`);

for (let i = 0; i < times; i += 1) {
  const started = Date.now();
  const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}kw=${encodeURIComponent(kw)}&res=all`;
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let summary = '';
    try {
      const json = JSON.parse(text);
      const data = json?.data || {};
      const merged = Object.keys(data.merged_by_type || {});
      summary = `code=${json.code} total=${data.total} 分类=${merged.length} 频道消息=${data.results?.length ?? 0}`;
    } catch {
      summary = `非 JSON：${text.slice(0, 60).replace(/\s+/g, ' ')}`;
    }
    console.log(`#${i + 1} ${res.status} ${Date.now() - started}ms ${(text.length / 1024).toFixed(0)}KB ${summary}`);
  } catch (err) {
    console.log(`#${i + 1} 失败 ${Date.now() - started}ms ${err.name}: ${err.message}`);
  }
  if (i < times - 1) await new Promise((r) => setTimeout(r, 4000));
}
