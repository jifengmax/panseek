/**
 * PanSeek HTTP 服务入口（零依赖，Node >= 20）。
 *
 *   node server/index.mjs
 *   PORT=8080 HOST=0.0.0.0 node server/index.mjs
 */
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config as defaultConfig } from './config.mjs';
import { TtlCache, Inflight } from './cache.mjs';
import { RateLimiter } from './ratelimit.mjs';
import { createAdapters } from './adapters/registry.mjs';
import { createSearchService, BadRequestError } from './core/search.mjs';
import { serveStatic } from './static.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
};

/**
 * 取客户端 IP，用于限流。
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} trustProxy
 */
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

/**
 * 发送响应，文本类自动 gzip。
 * @param {import('node:http').ServerResponse} res
 */
function send(req, res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const type = headers['content-type'] || 'text/plain; charset=utf-8';
  const outHeaders = { ...SECURITY_HEADERS, ...headers };

  const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  if (acceptsGzip && buf.length > 1024 && /^(text\/|application\/(json|manifest\+json)|image\/svg)/.test(type)) {
    const gz = zlib.gzipSync(buf, { level: 6 });
    outHeaders['content-encoding'] = 'gzip';
    outHeaders.vary = 'accept-encoding';
    outHeaders['content-length'] = String(gz.length);
    res.writeHead(status, outHeaders);
    res.end(req.method === 'HEAD' ? undefined : gz);
    return;
  }
  outHeaders['content-length'] = String(buf.length);
  res.writeHead(status, outHeaders);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

function sendJson(req, res, status, payload, extra = {}) {
  const body = JSON.stringify(payload);
  send(req, res, status, body, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    ...extra,
  });
}

/**
 * 组装服务（导出便于测试直接调用 handler）。
 * @param {object} [overrides] 覆盖配置，测试用
 */
export function createApp(overrides = {}) {
  const config = { ...defaultConfig, ...overrides };
  const adapters = createAdapters(config);
  const cache = new TtlCache(config.cacheTtl, config.cacheMax);
  const inflight = new Inflight();
  const limiter = new RateLimiter(config.rateLimitMax, config.rateLimitWindow);
  const service = createSearchService({ config, adapters, cache, inflight });

  /** @type {import('node:http').RequestListener} */
  async function handler(req, res) {
    const started = Date.now();
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // 所有响应（含静态文件）统一带上安全头
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);

    res.on('finish', () => {
      if (process.env.NODE_ENV !== 'test') {
        console.log(`${req.method} ${pathname}${url.search} ${res.statusCode} ${Date.now() - started}ms`);
      }
    });

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          ...SECURITY_HEADERS,
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, HEAD, OPTIONS',
          'access-control-max-age': '86400',
        });
        res.end();
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(req, res, 405, { ok: false, error: { code: 'method_not_allowed', message: '只支持 GET' } });
        return;
      }

      // ---- 接口 ----
      if (pathname === '/api/search') {
        const ip = clientIp(req, config.trustProxy);
        const gate = limiter.take(ip);
        if (!gate.ok) {
          sendJson(
            req,
            res,
            429,
            { ok: false, error: { code: 'rate_limited', message: `请求过于频繁，请 ${gate.retryAfter} 秒后重试` } },
            { 'retry-after': String(gate.retryAfter) }
          );
          return;
        }

        const kw = url.searchParams.get('kw') || url.searchParams.get('q') || url.searchParams.get('keyword') || '';
        const result = await service.search(kw, {
          type: url.searchParams.get('type') || 'all',
          sort: url.searchParams.get('sort') || 'default',
          limit: url.searchParams.get('limit') || undefined,
        });

        sendJson(req, res, 200, { ok: true, ...result }, {
          'x-ratelimit-limit': String(config.rateLimitMax),
          'x-ratelimit-remaining': String(gate.remaining),
          'cache-control': 'public, max-age=30',
        });
        return;
      }

      if (pathname === '/api/meta') {
        sendJson(req, res, 200, { ok: true, ...service.meta() }, { 'cache-control': 'public, max-age=600' });
        return;
      }

      if (pathname === '/api/health') {
        sendJson(req, res, 200, service.health());
        return;
      }

      if (pathname.startsWith('/api/')) {
        sendJson(req, res, 404, { ok: false, error: { code: 'not_found', message: '接口不存在' } });
        return;
      }

      if (pathname === '/robots.txt') {
        send(req, res, 200, 'User-agent: *\nDisallow: /api/\nAllow: /\n', {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'public, max-age=86400',
        });
        return;
      }

      // ---- 静态资源 ----
      const served = await serveStatic(req, res, PUBLIC_DIR, pathname);
      if (served) return;

      // 单页应用回退：未知路径返回首页，交由前端路由处理
      const fallback = await serveStatic(req, res, PUBLIC_DIR, '/index.html');
      if (fallback) return;
      send(req, res, 404, 'Not Found', { 'content-type': 'text/plain; charset=utf-8' });
    } catch (err) {
      if (err instanceof BadRequestError) {
        sendJson(req, res, 400, { ok: false, error: { code: 'bad_request', message: err.message } });
        return;
      }
      if (err?.status === 502) {
        sendJson(req, res, 502, { ok: false, error: { code: 'upstream_unavailable', message: err.message } });
        return;
      }
      console.error('[panseek] 未捕获错误：', err);
      if (!res.headersSent) {
        sendJson(req, res, 502, {
          ok: false,
          error: { code: 'upstream_error', message: '搜索服务暂时不可用，请稍后重试' },
        });
      } else {
        res.end();
      }
    }
  }

  return { handler, service, config, cache, adapters };
}

/** 直接运行本文件时启动服务。 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { handler, config } = createApp();
  const server = http.createServer(handler);
  server.listen(config.port, config.host, () => {
    const shown = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
    console.log(`\n  PanSeek 已启动 → http://${shown}:${config.port}`);
    console.log(`  数据源：${config.endpoints.join(' , ')}`);
    console.log(`  离线回退：${config.demoFallback ? '开启' : '关闭'} | 缓存：${config.cacheTtl / 1000}s\n`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`端口 ${config.port} 已被占用，可用 PORT=xxxx node server/index.mjs 换一个端口`);
      process.exit(1);
    }
    throw err;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      console.log(`\n收到 ${signal}，正在关闭…`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}
