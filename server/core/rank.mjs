/**
 * 聚合后的去重、打分与排序。
 *
 * 排序目标：优先“能直接用”的结果 —— 标题命中关键词、有提取码/体积、时间新、
 * 被多个频道同时收录；磁力因为噪声大，权重略低。
 */
import { DAY, identityOf } from './normalize.mjs';

const TYPE_ORDER = ['quark', 'aliyun', 'baidu', 'pan115', 'xunlei', 'uc', 'tianyi', 'pan123', 'pikpak', 'mobile', 'lanzou', 'weiyun', 'magnet', 'other'];

/**
 * 合并同一个资源（同网盘同路径）的多条记录。
 * 以先到的记录为基准（适配器按可信度排序），补全缺失字段。
 * @param {object[]} items
 * @returns {object[]}
 */
export function dedupe(items) {
  /** @type {Map<string, object>} */
  const map = new Map();
  for (const item of items) {
    if (!item) continue;
    const key = identityOf(item.url, item.panType);
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...item, channels: item.channel ? [item.channel] : [] });
      continue;
    }
    // 补全缺失信息
    if (!prev.password && item.password) prev.password = item.password;
    if (!prev.size && item.size) prev.size = item.size;
    if (!prev.desc && item.desc) prev.desc = item.desc;
    if (item.ts > prev.ts) {
      prev.ts = item.ts;
      prev.datetime = item.datetime;
    }
    // 标题取信息量更大的那个（更长的通常包含清晰度/合集说明）
    if (item.title.length > prev.title.length + 4 && item.title.length <= 180) {
      prev.title = item.title;
    }
    if (item.channel && !prev.channels.includes(item.channel) && prev.channels.length < 4) {
      prev.channels.push(item.channel);
    }
  }
  return [...map.values()];
}

/** 归一化关键词，去掉空白并转小写（中文不受影响）。 */
export function normKeyword(kw) {
  return String(kw || '').toLowerCase().replace(/\s+/g, '');
}

/**
 * 计算相关度分数。
 * @param {object} item
 * @param {string} kw 原始关键词
 * @param {number} now
 */
export function scoreItem(item, kw, now = Date.now()) {
  const key = normKeyword(kw);
  const title = normKeyword(item.title);
  let score = 0;

  if (key) {
    if (title === key) score += 38;
    else if (title.startsWith(key)) score += 34;
    else if (title.includes(key)) score += 26;
    else {
      // 分词命中：关键词被空格拆开时按词计分
      const tokens = String(kw).toLowerCase().split(/\s+/).filter((t) => t.length > 1);
      if (tokens.length > 1) {
        const hit = tokens.filter((t) => title.includes(t)).length;
        score += (hit / tokens.length) * 20;
      }
    }
    // 标题就只有关键词本身（没有任何清晰度/集数/体积信息）时降权，
    // 让信息更全的结果排在前面
    if (title === key) score -= 10;
    else if (title.length <= key.length + 2) score -= 6;
  }

  if (item.password) score += 5;
  if (item.size) score += 4;
  if (item.panType === 'magnet' || item.panType === 'other') score -= 7;

  if (item.ts) {
    const ageDays = Math.max(0, (now - item.ts) / DAY);
    score += 26 * Math.exp(-ageDays / 150);
  }

  const channels = item.channels?.length || 1;
  score += Math.min(channels - 1, 3) * 4;

  return Math.round(score * 10) / 10;
}

/**
 * 标题命中程度：3 = 以关键词开头，2 = 包含，1 = 仅分词命中，0 = 未命中。
 * @param {string} title
 * @param {string} kw
 */
export function titleRank(title, kw) {
  const key = normKeyword(kw);
  const t = normKeyword(title);
  if (!key) return 0;
  if (t.startsWith(key)) return 3;
  if (t.includes(key)) return 2;
  const tokens = String(kw).toLowerCase().split(/\s+/).filter((x) => x.length > 1);
  if (tokens.length > 1 && tokens.every((x) => t.includes(x))) return 1;
  return 0;
}

/**
 * 排序结果。
 * @param {object[]} items 已去重
 * @param {string} kw
 * @param {'default'|'latest'|'relevance'} sort
 */
export function sortItems(items, kw, sort = 'default') {
  const now = Date.now();
  const scored = items.map((item) => ({
    ...item,
    score: scoreItem(item, kw, now),
    titleRank: titleRank(item.title, kw),
  }));
  const byLatest = (a, b) => b.ts - a.ts || b.score - a.score;
  const byRelevance = (a, b) => b.titleRank - a.titleRank || b.score - a.score || b.ts - a.ts;
  const byDefault = (a, b) => b.score - a.score || b.ts - a.ts;
  scored.sort(sort === 'latest' ? byLatest : sort === 'relevance' ? byRelevance : byDefault);
  return scored;
}

/**
 * 统计各网盘类型数量，按固定顺序返回，只保留有结果的类型。
 * @param {object[]} items
 */
export function typeCounts(items) {
  const counter = new Map();
  for (const item of items) {
    counter.set(item.panType, (counter.get(item.panType) || 0) + 1);
  }
  return TYPE_ORDER.filter((id) => counter.has(id)).map((id) => ({ id, count: counter.get(id) }));
}
