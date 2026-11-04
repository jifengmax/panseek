/**
 * PanSou 兼容接口适配器。
 *
 * 接口返回形如：
 * { code: 0, data: { total, merged_by_type: { quark: [{url,password,note,datetime,source,images}] }, results: [...] } }
 *
 * 做两路抽取：
 *   1. merged_by_type —— 上游已完成网盘分类与合并，质量最高；
 *   2. results[]      —— 原始频道消息，很多链接没进 merged，用正则在正文里二次抓取。
 */
import { buildItem, cleanTitle, extractLinks, mapUpstreamType } from '../core/normalize.mjs';

export class UpstreamError extends Error {
  constructor(message, { status = 0, endpoint = '' } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.endpoint = endpoint;
  }
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

/**
 * 频道消息常常把 title 写成一句关键词，真正有用的信息（清晰度、集数、体积）都在正文里。
 * 标题太短时从正文前缀里补一个更有信息量的标题。
 * @param {{title?: string, content?: string}} record
 */
function deriveTitle(record) {
  const base = cleanTitle(record.title || '');
  if (base.length >= 12) return base;
  const content = String(record.content || '').replace(/\s+/g, ' ').trim();
  if (!content) return base;
  const cut = content.search(/(?:描述|简介|介绍|链接|地址|网盘|夸克|迅雷|百度|阿里|天翼|UC|115|提取码)\s*[:：|]/);
  const head = cut > 6 ? content.slice(0, cut) : content.slice(0, 120);
  const fromContent = cleanTitle(head, 120);
  return fromContent.length > base.length + 6 ? fromContent : base;
}

/**
 * 把 PanSou 响应体解析成统一结果。独立出来便于离线样例与单测复用。
 * @param {any} json
 * @returns {{items: object[], total: number}}
 */
export function parsePansouPayload(json) {
  const data = json?.data || {};
  const items = [];

  // 1) 已合并、已分类的结果
  for (const [key, list] of Object.entries(data.merged_by_type || {})) {
    if (!Array.isArray(list)) continue;
    const panType = mapUpstreamType(key);
    for (const entry of list) {
      const item = buildItem({ ...entry, panType }, { source: 'pansou', priority: 0 });
      if (item) items.push(item);
    }
  }

  // 2) 原始频道消息二次抽取
  if (Array.isArray(data.results)) {
    for (const record of data.results) {
      if (!record) continue;
      const text = `${record.title || ''}\n${record.content || ''}`;
      const links = extractLinks(text);
      if (!links.length) continue;
      const title = deriveTitle(record);
      for (const link of links) {
        const item = buildItem(
          {
            url: link.url,
            password: link.password,
            title: title.slice(0, 100),
            datetime: record.datetime,
            channel: record.channel,
          },
          { source: 'channel', priority: 1 }
        );
        if (item) items.push(item);
      }
    }
  }

  return { items, total: Number(data.total) || items.length };
}

/**
 * @param {{endpoints: string[], timeout: number, fetchImpl?: typeof fetch}} options
 */
export function createPansouAdapter({ endpoints, timeout, fetchImpl = globalThis.fetch }) {
  return {
    id: 'pansou',
    label: 'PanSou 聚合',

    /**
     * @param {string} kw
     * @returns {Promise<{items: object[], endpoint: string, took: number, total: number}>}
     */
    async search(kw) {
      let lastError = null;

      for (const endpoint of endpoints) {
        const started = Date.now();
        // 公共实例偶发返回限流页/网关页，重试一次通常就能拿到 JSON
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}kw=${encodeURIComponent(kw)}&res=all`;
            const res = await fetchImpl(url, {
              headers: {
                'user-agent': UA,
                accept: 'application/json, text/plain, */*',
                'accept-language': 'zh-CN,zh;q=0.9',
              },
              signal: AbortSignal.timeout(timeout),
            });
            if (!res.ok) {
              throw new UpstreamError(`上游 HTTP ${res.status}`, { status: res.status, endpoint });
            }
            const text = await res.text();
            let json;
            try {
              json = JSON.parse(text);
            } catch {
              throw new UpstreamError('上游返回的不是 JSON（可能被限流）', { endpoint });
            }
            if (!json || typeof json !== 'object') throw new UpstreamError('上游返回为空', { endpoint });
            if (json.code != null && json.code !== 0) {
              throw new UpstreamError(`上游业务错误：${json.message || json.code}`, { endpoint });
            }

            const { items, total } = parsePansouPayload(json);
            const data = json.data || {};
            if (items.length === 0 && !data.merged_by_type && !data.results) {
              throw new UpstreamError('上游结构无法识别', { endpoint });
            }
            return { items, endpoint, took: Date.now() - started, total };
          } catch (err) {
            // 把底层网络错误翻译成人话，前端会直接展示
            const friendly =
              err?.name === 'TypeError'
                ? new UpstreamError('无法连接上游服务', { endpoint })
                : err?.name === 'TimeoutError'
                  ? new UpstreamError('响应超时', { endpoint })
                  : err;
            lastError = friendly;
            const retryable =
              friendly?.name === 'UpstreamError'
                ? /不是 JSON|超时|HTTP 5\d\d|上游返回为空|无法连接/.test(friendly.message)
                : false;
            if (!retryable || attempt === 1) break;
            await sleep(400);
          }
        }
      }

      throw lastError || new UpstreamError('没有配置可用的上游接口');
    },
  };
}
