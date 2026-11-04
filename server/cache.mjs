/**
 * 带 TTL 的 LRU 缓存 + 请求合并（同一 key 并发只打一次上游）。
 *
 * 除了正常 TTL，还保留一份“过期但仍可用”的数据：上游抖动时可以把上一次
 * 成功的结果先顶上去（stale-while-error），比直接给用户一个空页面好得多。
 */
export class TtlCache {
  /**
   * @param {number} ttlMs 有效期
   * @param {number} max 最大条数
   * @param {number} [staleTtlMs] 过期后仍保留多久
   */
  constructor(ttlMs, max = 500, staleTtlMs = 24 * 60 * 60_000) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.staleTtlMs = staleTtlMs;
    /** @type {Map<string, {value: any, expiresAt: number, staleUntil: number}>} */
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) {
      this.misses += 1;
      return undefined;
    }
    if (hit.expiresAt <= Date.now()) {
      this.misses += 1;
      return undefined;
    }
    // 命中后重新插入，维持 LRU 顺序
    this.map.delete(key);
    this.map.set(key, hit);
    this.hits += 1;
    return hit.value;
  }

  /** 取过期数据（不超过 staleTtl），用于上游失败时的兜底。 */
  getStale(key) {
    const hit = this.map.get(key);
    if (!hit || hit.staleUntil <= Date.now()) return undefined;
    return hit.value;
  }

  set(key, value) {
    const now = Date.now();
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: now + this.ttlMs, staleUntil: now + this.staleTtlMs });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
    return value;
  }

  delete(key) {
    return this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  /** 清掉超过 staleTtl 的僵尸条目。 */
  sweep(now = Date.now()) {
    for (const [key, hit] of this.map) {
      if (hit.staleUntil <= now) this.map.delete(key);
    }
  }

  get size() {
    return this.map.size;
  }
}

/**
 * 请求合并：相同 key 的并发调用共享同一个 Promise，避免缓存击穿。
 */
export class Inflight {
  constructor() {
    /** @type {Map<string, Promise<any>>} */
    this.map = new Map();
  }

  /**
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  run(key, fn) {
    const existing = this.map.get(key);
    if (existing) return existing;
    const p = Promise.resolve()
      .then(fn)
      .finally(() => {
        this.map.delete(key);
      });
    this.map.set(key, p);
    return p;
  }
}
