/**
 * 运行时配置。全部可通过环境变量覆盖，便于 Docker / 面板部署时调参。
 */

/** 读取正整数环境变量，非法值回落到默认值。 */
function int(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 读取布尔环境变量，"0/false/off/no" 视为 false。 */
function bool(value, fallback) {
  if (value == null || value === '') return fallback;
  return !/^(0|false|off|no)$/i.test(String(value).trim());
}

const endpoints = String(process.env.PANSOU_ENDPOINTS || 'https://so.252035.xyz/api/search')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const config = {
  /** 监听地址：默认只监听本机，部署到公网时用 HOST=0.0.0.0 */
  host: process.env.HOST?.trim() || '127.0.0.1',
  port: int(process.env.PORT, 8787),

  /** 上游 PanSou 兼容接口列表，按顺序故障转移 */
  endpoints,

  /** 单个上游请求超时（毫秒） */
  upstreamTimeout: int(process.env.UPSTREAM_TIMEOUT_MS, 15_000),

  /** 结果缓存时长 / 条数 */
  cacheTtl: int(process.env.CACHE_TTL_MS, 5 * 60_000),
  cacheMax: int(process.env.CACHE_MAX, 400),

  /** 每个 IP 的限流窗口 */
  rateLimitMax: int(process.env.RATE_LIMIT_MAX, 40),
  rateLimitWindow: int(process.env.RATE_LIMIT_WINDOW_MS, 60_000),

  /** 单次返回结果上限（内存与前端渲染保护） */
  maxResults: int(process.env.MAX_RESULTS, 400),

  /** 上游全部失败时是否回退到内置离线样例数据 */
  demoFallback: bool(process.env.DEMO_FALLBACK, true),

  /** 是否信任反向代理传来的 X-Forwarded-For */
  trustProxy: bool(process.env.TRUST_PROXY, false),

  version: '1.0.0',
};
