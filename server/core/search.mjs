/**
 * 搜索编排：并发调用所有数据源 → 去重 → 排序 → 缓存。
 * HTTP 层只负责参数校验和响应封装，业务逻辑都在这里，方便单测。
 */
import { dedupe, sortItems, typeCounts } from './rank.mjs';
import { PAN_TYPES } from './normalize.mjs';
import { HOT_WORDS } from './hot.mjs';
import { createDemoAdapter } from '../adapters/demo.mjs';

export class BadRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadRequestError';
    this.status = 400;
    this.code = 'bad_request';
  }
}

/** 所有数据源都失败、且没有兜底数据时抛出，HTTP 层转成 502。 */
export class ServiceUnavailableError extends Error {
  constructor(message = '所有数据源都暂时不可用，请稍后重试') {
    super(message);
    this.name = 'ServiceUnavailableError';
    this.status = 502;
    this.code = 'upstream_unavailable';
  }
}

const ALLOWED_SORTS = new Set(['default', 'latest', 'relevance']);

/** 给单个数据源加超时，避免一个慢源拖垮整次搜索。 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 响应超时`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {object} deps
 * @param {typeof import('../config.mjs').config} deps.config
 * @param {object[]} deps.adapters
 * @param {import('../cache.mjs').TtlCache} deps.cache
 * @param {import('../cache.mjs').Inflight} deps.inflight
 * @param {object} [deps.demoAdapter]
 * @param {Console} [deps.log]
 */
export function createSearchService({ config, adapters, cache, inflight, demoAdapter, log = console }) {
  const demo = demoAdapter || (config.demoFallback ? createDemoAdapter() : null);
  const stats = { searches: 0, cacheHits: 0, demoFallbacks: 0, errors: 0 };

  /** 把关键词规整成安全、可缓存的形态。 */
  function normalizeKeyword(input) {
    const kw = String(input ?? '')
      .replace(/[\u0000-\u001f\u007f\u200b-\u200f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!kw) throw new BadRequestError('请输入搜索关键词');
    if (kw.length > 80) throw new BadRequestError('关键词过长（最多 80 个字符）');
    return kw;
  }

  async function runAdapters(kw) {
    return Promise.all(
      adapters.map(async (adapter) => {
        const started = Date.now();
        try {
          const result = await withTimeout(adapter.search(kw), config.upstreamTimeout + 1500, adapter.label);
          return {
            id: adapter.id,
            label: adapter.label,
            ok: true,
            ms: Date.now() - started,
            count: Array.isArray(result?.items) ? result.items.length : 0,
            items: Array.isArray(result?.items) ? result.items : [],
            error: '',
          };
        } catch (err) {
          stats.errors += 1;
          log.warn?.(`[panseek] 数据源 ${adapter.id} 失败：${err?.message || err}`);
          return {
            id: adapter.id,
            label: adapter.label,
            ok: false,
            ms: Date.now() - started,
            count: 0,
            items: [],
            error: err?.message || '未知错误',
          };
        }
      })
    );
  }

  /**
   * 取某个关键词的完整结果集（走缓存）。
   * @param {string} kw
   */
  async function fetchAll(kw) {
    const key = `q:${kw.toLowerCase()}`;
    const cached = cache.get(key);
    if (cached) {
      stats.cacheHits += 1;
      return { ...cached, cached: true };
    }

    return inflight.run(key, async () => {
      stats.searches += 1;
      const started = Date.now();
      const parts = await runAdapters(kw);
      let items = dedupe(parts.flatMap((p) => p.items));
      const warnings = parts.filter((p) => !p.ok).map((p) => `${p.label} 暂时不可用（${p.error}）`);
      let usedDemo = false;
      let usedStale = false;

      // 上游全挂时：先用同一关键词的历史结果顶一下，再退到离线样例
      if (items.length === 0) {
        const stale = cache.getStale(key);
        if (stale?.items?.length) {
          usedStale = true;
          log.warn?.(`[panseek] 上游失败，使用「${kw}」的过期缓存（${stale.items.length} 条）`);
          return {
            ...stale,
            warnings: [...warnings, '上游暂时不可用，以下是上一次成功搜索的缓存结果'],
            stale: true,
            cached: false,
          };
        }
      }

      if (items.length === 0 && demo) {
        try {
          const res = await demo.search(kw);
          if (res?.items?.length) {
            items = dedupe(res.items);
            usedDemo = true;
            stats.demoFallbacks += 1;
          }
        } catch (err) {
          log.warn?.(`[panseek] 离线样例读取失败：${err?.message || err}`);
        }
      }

      // 没有任何结果且所有数据源都失败：明确告知“服务不可用”，而不是伪装成“没搜到”
      if (items.length === 0 && parts.length > 0 && parts.every((p) => !p.ok)) {
        throw new ServiceUnavailableError(parts.map((p) => `${p.label}：${p.error}`).join('；'));
      }

      const payload = {
        kw,
        items: sortItems(items, kw, 'default'),
        warnings,
        demo: usedDemo,
        stale: usedStale,
        sources: parts.map(({ items: _ignored, ...rest }) => rest),
        took: Date.now() - started,
      };
      // 离线样例不写缓存：上游一恢复就该立刻拿到真实结果
      if (!usedDemo) cache.set(key, payload);
      return { ...payload, cached: false };
    });
  }

  return {
    stats,

    /**
     * @param {string} rawKw
     * @param {{type?: string, sort?: string, limit?: number}} [options]
     */
    async search(rawKw, options = {}) {
      const kw = normalizeKeyword(rawKw);
      const type = String(options.type || 'all').toLowerCase();
      const sort = ALLOWED_SORTS.has(String(options.sort)) ? String(options.sort) : 'default';
      const rawLimit = Number.parseInt(String(options.limit ?? ''), 10);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), config.maxResults) : config.maxResults;

      const started = Date.now();
      const data = await fetchAll(kw);

      const filtered = type && type !== 'all' ? data.items.filter((item) => item.panType === type) : data.items;
      const sorted = sort === 'default' ? filtered : sortItems(filtered, kw, sort);

      return {
        kw,
        type: type || 'all',
        sort,
        total: sorted.length,
        elapsedMs: Date.now() - started,
        cached: data.cached,
        demo: data.demo,
        stale: Boolean(data.stale),
        types: typeCounts(data.items),
        upstreamTotal: data.sources.reduce((sum, s) => sum + s.count, 0),
        items: sorted.slice(0, limit),
        warnings: data.warnings,
        sources: data.sources,
        truncated: sorted.length > limit,
      };
    },

    /** 给前端渲染筛选器用的元信息。 */
    meta() {
      return {
        version: config.version,
        hot: HOT_WORDS,
        sorts: [
          { id: 'default', name: '综合排序' },
          { id: 'relevance', name: '相关度' },
          { id: 'latest', name: '最新发布' },
        ],
        panTypes: PAN_TYPES.map(({ id, name, short, color }) => ({ id, name, short, color })),
        sources: adapters.map((a) => ({ id: a.id, label: a.label })),
        demoFallback: Boolean(config.demoFallback),
      };
    },

    health() {
      return {
        ok: true,
        version: config.version,
        uptime: Math.round(process.uptime()),
        cache: { size: cache.size, hits: cache.hits, misses: cache.misses, ttlMs: config.cacheTtl },
        stats,
        adapters: adapters.map((a) => ({ id: a.id, label: a.label })),
        endpoints: config.endpoints,
      };
    },
  };
}
