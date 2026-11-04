/**
 * 静态资源服务：路径穿越防护 + ETag + gzip + 长缓存。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json)|image\/svg)/;

/** 已压缩内容缓存：etag -> Buffer，省掉重复 gzip 的 CPU。 */
const gzipCache = new Map();

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} rootDir public 目录绝对路径
 * @param {string} urlPath 解码后的请求路径
 * @returns {Promise<boolean>} 是否已处理
 */
export async function serveStatic(req, res, rootDir, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  // 目录请求给 index.html
  if (rel.endsWith('/')) rel += 'index.html';

  const target = path.resolve(rootDir, `.${rel}`);
  const rootResolved = path.resolve(rootDir);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    return false;
  }

  let stat;
  try {
    stat = await fs.stat(target);
    if (!stat.isFile()) return false;
  } catch {
    return false;
  }

  const ext = path.extname(target).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const etag = `W/"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': 'public, max-age=0, must-revalidate' });
    res.end();
    return true;
  }

  const body = await fs.readFile(target);
  const headers = {
    'content-type': type,
    etag,
    // 前端没有构建步骤，改完文件就该立刻生效：靠 ETag 走 304，而不是让浏览器吃 1 小时旧缓存
    'cache-control': COMPRESSIBLE.test(type) || ext === '.html' ? 'no-cache' : 'public, max-age=86400',
    'x-content-type-options': 'nosniff',
  };

  const acceptEncoding = String(req.headers['accept-encoding'] || '');
  if (COMPRESSIBLE.test(type) && body.length > 1024 && /\bgzip\b/.test(acceptEncoding)) {
    let gz = gzipCache.get(etag);
    if (!gz) {
      gz = zlib.gzipSync(body, { level: 6 });
      if (gzipCache.size > 60) gzipCache.clear();
      gzipCache.set(etag, gz);
    }
    headers['content-encoding'] = 'gzip';
    headers.vary = 'accept-encoding';
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : gz);
    return true;
  }

  headers['content-length'] = String(body.length);
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}
