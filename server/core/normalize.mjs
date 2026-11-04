/**
 * 结果归一化：把各数据源里形态各异的一条记录，变成前端可以直接渲染的统一结构。
 *
 * 统一结构：
 * {
 *   id, title, url, panType, panName, password, size,
 *   datetime, ts, channel, source, images, desc
 * }
 */

/** 支持的网盘类型。detect 用域名后缀匹配，越靠前优先级越高。 */
export const PAN_TYPES = [
  { id: 'quark', name: '夸克网盘', short: '夸克', color: '#2d6df6', domains: ['pan.quark.cn', 'quark.cn'] },
  { id: 'aliyun', name: '阿里云盘', short: '阿里', color: '#6d4aff', domains: ['aliyundrive.com', 'alipan.com'] },
  { id: 'baidu', name: '百度网盘', short: '百度', color: '#2b6ef2', domains: ['pan.baidu.com', 'yun.baidu.com', 'eyun.baidu.com'] },
  { id: 'pan115', name: '115网盘', short: '115', color: '#00a0e9', domains: ['115.com', '115cdn.com', 'anxia.com'] },
  { id: 'xunlei', name: '迅雷云盘', short: '迅雷', color: '#1f8fff', domains: ['pan.xunlei.com', 'xunlei.com'] },
  { id: 'uc', name: 'UC网盘', short: 'UC', color: '#ff7a00', domains: ['drive.uc.cn'] },
  { id: 'tianyi', name: '天翼云盘', short: '天翼', color: '#d7000f', domains: ['cloud.189.cn'] },
  { id: 'mobile', name: '移动云盘', short: '移动', color: '#0066ff', domains: ['caiyun.139.com', 'yun.139.com'] },
  { id: 'pan123', name: '123网盘', short: '123', color: '#0aa06e', domains: ['123pan.com', '123684.com', '123865.com', '123912.com', '123592.com'] },
  { id: 'pikpak', name: 'PikPak', short: 'PikPak', color: '#6c47ff', domains: ['mypikpak.com', 'pikpak.com'] },
  { id: 'lanzou', name: '蓝奏云', short: '蓝奏', color: '#3b82f6', domains: ['lanzou.com', 'lanzoui.com', 'lanzoux.com', 'lanzn.com'] },
  { id: 'weiyun', name: '腾讯微云', short: '微云', color: '#12b7f5', domains: ['share.weiyun.com', 'weiyun.com'] },
  { id: 'magnet', name: '磁力链接', short: '磁力', color: '#64748b', domains: [] },
  { id: 'other', name: '其他链接', short: '其他', color: '#94a3b8', domains: [] },
];

const TYPE_BY_ID = new Map(PAN_TYPES.map((t) => [t.id, t]));

/** 上游 merged_by_type 的 key → 我们的类型 id */
const UPSTREAM_TYPE_MAP = {
  quark: 'quark',
  aliyun: 'aliyun',
  baidu: 'baidu',
  '115': 'pan115',
  xunlei: 'xunlei',
  uc: 'uc',
  tianyi: 'tianyi',
  mobile: 'mobile',
  '123': 'pan123',
  pikpak: 'pikpak',
  lanzou: 'lanzou',
  weiyun: 'weiyun',
  magnet: 'magnet',
};

/** 归一化时丢弃的跟踪参数 */
const DROP_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'spm', 'from', 'share_source', 'share_medium', 'scene', 'clicktime', '_t', 'ref', 'referer',
]);

const LINK_RE = /(?:https?:\/\/[^\s"'<>，。、；）)】\]|}]+|magnet:\?xt=urn:btih:[a-zA-Z0-9]+[^\s"'<>，。、；）)】\]|}]*)/gi;
const PWD_TEXT_RE = /(?:提取码|提取碼|访问码|訪問碼|密码|密\s*码|口令|pwd|password)\s*[:：=]?\s*([a-zA-Z0-9]{4,10})/i;
const SIZE_RE = /(\d+(?:\.\d{1,2})?)\s*(TB|TiB|GB|GiB|MB|MiB|T|G|M)(?![a-zA-Z])/i;

/** 取类型元信息，未知类型回落到 other。 */
export function panTypeInfo(id) {
  return TYPE_BY_ID.get(id) || TYPE_BY_ID.get('other');
}

/**
 * 从 URL 判断网盘类型。
 * @param {string} url
 * @returns {string} 类型 id
 */
export function detectPanType(url) {
  const s = String(url || '');
  if (/^magnet:/i.test(s)) return 'magnet';
  let host = '';
  try {
    host = new URL(s).hostname.toLowerCase();
  } catch {
    return 'other';
  }
  for (const type of PAN_TYPES) {
    for (const domain of type.domains) {
      if (host === domain || host.endsWith(`.${domain}`)) return type.id;
    }
  }
  return 'other';
}

/** 去掉链接末尾常见的标点和引号（上游文本里很常见）。 */
function trimLink(url) {
  return String(url)
    .trim()
    .replace(/&amp;/g, '&')
    .replace(/[)\]】》>,.;:'"“”‘’。，、；：]+$/u, '');
}

/**
 * 规整链接：补协议、去跟踪参数、去片段。保留 pwd 等必要参数。
 * @param {string} raw
 * @returns {string} 合法 URL，无法解析时返回空串
 */
export function cleanUrl(raw) {
  const s = trimLink(raw);
  if (!s) return '';
  if (/^magnet:/i.test(s)) {
    const m = /xt=urn:btih:([a-zA-Z0-9]+)/i.exec(s);
    return m ? `magnet:?xt=urn:btih:${m[1]}` : s;
  }
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (!/^https?:$/.test(u.protocol)) return '';
    if (!u.hostname.includes('.')) return '';
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (DROP_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return '';
  }
}

/**
 * 提取码清洗：正文里经常写成“提取码：8888https://pan.baidu.com/...”，
 * 正则会把后面的 url 协议头一起吃进来，这里把尾巴截掉。
 * @param {string} raw
 */
function sanitizePassword(raw) {
  let s = String(raw || '').replace(/[^a-zA-Z0-9]/g, '');
  const stripped = s.replace(/(https?|htt|ftp|www)$/i, '');
  if (stripped.length >= 4) s = stripped;
  return s.length >= 4 && s.length <= 10 ? s : '';
}

/**
 * 提取提取码：先看链接参数，再看文本里的“提取码：xxxx”。
 * @param {string} url
 * @param {string} [text]
 */
export function extractPassword(url, text = '') {
  try {
    const u = new URL(trimLink(url));
    for (const key of ['pwd', 'password', 'passcode', 'p']) {
      const v = u.searchParams.get(key);
      if (v && /^[a-zA-Z0-9]{1,10}$/.test(v)) return v;
    }
  } catch {
    /* 忽略非标准链接 */
  }
  const m = PWD_TEXT_RE.exec(String(text || ''));
  return m ? sanitizePassword(m[1]) : '';
}

/** 从文本里找体积，如 “大小：40.2GB”。 */
export function extractSize(text) {
  const m = SIZE_RE.exec(String(text || ''));
  if (!m) return '';
  const unit = m[2].toUpperCase().replace(/IB$/, 'B').replace(/^T$/, 'TB').replace(/^G$/, 'GB').replace(/^M$/, 'MB');
  return `${m[1]}${unit}`;
}

const LEADING_NOISE = /^[\s\u200b·•\-—_=*#>|/\\]+/u;
const TITLE_PREFIX = /^(?:资源名称|名称|标题|片名|剧名)\s*[:：]\s*/;

/**
 * 清洗标题：去掉开头的表情/符号与“名称：”前缀，压缩空白。
 * @param {string} raw
 * @param {number} [maxLen]
 */
export function cleanTitle(raw, maxLen = 180) {
  let s = String(raw || '')
    .replace(/\r?\n/g, ' ')
    // 标题里混进来的网盘链接和磁力链，直接去掉（正文抽取时很常见）
    .replace(/(?:https?:\/\/|magnet:\?)+\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // 去掉开头的 emoji 与装饰符号（保留中文、字母、数字）
  s = s.replace(/^[^\p{L}\p{N}]+/u, '');
  s = s.replace(TITLE_PREFIX, '');
  s = s.replace(LEADING_NOISE, '').trim();
  if (!s) s = '未命名资源';
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

const DAY = 86_400_000;

/**
 * 把上游时间字符串转成毫秒时间戳；"0001-01-01" 这类占位值视为未知。
 * @param {string} value
 * @returns {number} 0 表示未知
 */
export function parseTime(value) {
  if (!value) return 0;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return 0;
  const year = new Date(ts).getUTCFullYear();
  if (year < 2000) return 0;
  // 未来的时间（上游时区错误）也不算数，避免“最新”排序被污染
  if (ts > Date.now() + 2 * DAY) return 0;
  return ts;
}

/** 稳定的短 id（FNV-1a），用于前端 key。 */
export function shortId(input) {
  let h = 0x811c9dc5;
  const s = String(input);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * 去重用的资源身份：同一网盘下的同一路径视为同一资源。
 * 磁力按 infoHash 归一。
 * @param {string} url
 * @param {string} panType
 */
export function identityOf(url, panType = detectPanType(url)) {
  if (/^magnet:/i.test(url)) {
    const m = /xt=urn:btih:([a-zA-Z0-9]+)/i.exec(url);
    return `magnet:${(m ? m[1] : url).toLowerCase()}`;
  }
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '');
    return `${panType}:${u.hostname.toLowerCase()}${path}`;
  } catch {
    return `${panType}:${url}`;
  }
}

/**
 * 从一段频道文本里抖出所有网盘链接（含相邻的提取码）。
 * 上游的 results[] 是原始频道消息，很多链接没有进入 merged_by_type，这里做二次抽取。
 * @param {string} text
 * @returns {{url: string, password: string}[]}
 */
export function extractLinks(text) {
  const out = [];
  const seen = new Set();
  const src = String(text || '');
  LINK_RE.lastIndex = 0;
  let m;
  while ((m = LINK_RE.exec(src)) !== null) {
    const url = cleanUrl(m[0]);
    if (!url) continue;
    const type = detectPanType(url);
    if (type === 'other') continue;
    // 链接后 40 个字符内如果紧跟“提取码”，一并取走
    const tail = src.slice(m.index, m.index + m[0].length + 40);
    const password = extractPassword(url, tail);
    const id = identityOf(url, type);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ url, password });
  }
  return out;
}

/**
 * 频道标识去掉 "tg:" / "plugin:" 前缀，方便直接展示。
 * @param {string} value
 */
export function cleanChannel(value) {
  return String(value || '')
    .trim()
    .replace(/^(tg|telegram|plugin|site|web):/i, '')
    .slice(0, 60);
}

/**
 * 构造统一结果对象。
 * @param {object} raw
 * @param {object} [meta]
 * @returns {object|null}
 */
export function buildItem(raw, meta = {}) {
  const url = cleanUrl(raw?.url);
  if (!url) return null;
  const panType = raw?.panType || meta.panType || detectPanType(url);
  const info = panTypeInfo(panType);
  const text = `${raw?.note || ''} ${raw?.title || ''} ${raw?.content || ''}`;
  const title = cleanTitle(raw?.title || raw?.note || raw?.content || '');
  const ts = parseTime(raw?.datetime || raw?.time || '');
  const password = raw?.password || extractPassword(url, text);

  return {
    id: shortId(identityOf(url, panType)),
    title,
    url,
    panType: info.id,
    panName: info.name,
    password: password ? String(password).slice(0, 10) : '',
    size: raw?.size || extractSize(text),
    datetime: ts ? new Date(ts).toISOString() : '',
    ts,
    channel: cleanChannel(raw?.channel || raw?.source || meta.channel),
    source: meta.source || '',
    desc: String(raw?.desc || '').replace(/\s+/g, ' ').trim().slice(0, 200),
  };
}

/** 上游 merged_by_type 的 key 转成我们的类型 id。 */
export function mapUpstreamType(key) {
  return UPSTREAM_TYPE_MAP[String(key).toLowerCase()] || 'other';
}

export { DAY };
