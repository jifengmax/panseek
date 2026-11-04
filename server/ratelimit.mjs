/**
 * 极简滑动窗口限流（内存版，单进程足够；多实例部署请换 Redis）。
 */
export class RateLimiter {
  /**
   * @param {number} max 窗口内最大请求数
   * @param {number} windowMs 窗口长度
   */
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    /** @type {Map<string, number[]>} */
    this.buckets = new Map();
    this.lastSweep = Date.now();
  }

  /**
   * @param {string} key 通常是客户端 IP
   * @returns {{ok: boolean, remaining: number, retryAfter: number}}
   */
  take(key) {
    const now = Date.now();
    this.sweep(now);
    const cut = now - this.windowMs;
    const list = (this.buckets.get(key) || []).filter((t) => t > cut);
    if (list.length >= this.max) {
      const retryAfter = Math.max(1, Math.ceil((list[0] + this.windowMs - now) / 1000));
      this.buckets.set(key, list);
      return { ok: false, remaining: 0, retryAfter };
    }
    list.push(now);
    this.buckets.set(key, list);
    return { ok: true, remaining: this.max - list.length, retryAfter: 0 };
  }

  /** 定期清理空桶，避免内存随 IP 数量无限增长。 */
  sweep(now = Date.now()) {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    const cut = now - this.windowMs;
    for (const [key, list] of this.buckets) {
      const alive = list.filter((t) => t > cut);
      if (alive.length === 0) this.buckets.delete(key);
      else this.buckets.set(key, alive);
    }
  }
}
