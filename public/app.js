/**
 * PanSeek 前端（原生 ES Module，无构建步骤）。
 *
 * 数据流：
 *   runSearch(kw) → loadResults(type) → state.items / state.types / state.total → render
 *
 * 说明：
 *  - 每个网盘类型单独向服务端要数据（服务端有缓存，切换很快），这样「夸克 1999 条」这种计数
 *    和实际展示的条数不会自相矛盾；
 *  - 排序、分页全部在本地完成；
 *  - 所有插入文本都用 textContent，避免 XSS（资源标题来自第三方频道，不可信）。
 */

const HISTORY_KEY = 'panseek:history';
const THEME_KEY = 'panseek:theme';
const PAGE_SIZE = 20;
const MAX_HISTORY = 8;

const $ = (sel) => document.querySelector(sel);

const els = {
  form: $('#searchForm'),
  kw: $('#kw'),
  clearBtn: $('#clearBtn'),
  hotChips: $('#hotChips'),
  recentBlock: $('#recentBlock'),
  recentChips: $('#recentChips'),
  clearHistory: $('#clearHistory'),
  results: $('#results'),
  toolbar: $('.toolbar'),
  tabs: $('#typeTabs'),
  sort: $('#sortSelect'),
  statText: $('#statText'),
  notice: $('#notice'),
  list: $('#list'),
  empty: $('#empty'),
  emptyHint: $('#emptyHint'),
  emptySuggest: $('#emptySuggest'),
  error: $('#error'),
  errorText: $('#errorText'),
  retry: $('#retryBtn'),
  more: $('#moreBtn'),
  toast: $('#toast'),
  themeBtn: $('#themeBtn'),
  toTop: $('#toTop'),
  version: $('#versionText'),
  sourceText: $('#sourceText'),
  statTypes: $('#statTypes'),
};

const state = {
  kw: '',
  type: 'all',
  sort: 'default',
  items: [],
  types: [],
  allCount: 0,
  total: 0,
  truncated: false,
  warnings: [],
  demo: false,
  stale: false,
  elapsed: 0,
  page: 1,
  loading: false,
  reqId: 0,
  meta: null,
};

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const ICONS = {
  disk: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6"/><path d="M4.5 12v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6"/></svg>',
  clock:
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M6.5 15H5.5A1.5 1.5 0 0 1 4 13.5v-8A1.5 1.5 0 0 1 5.5 4h8A1.5 1.5 0 0 1 15 5.5v1"/></svg>',
  open: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18.5 14.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V7A1.5 1.5 0 0 1 5 5.5h4.5"/></svg>',
  magnet:
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4v8a6 6 0 0 0 12 0V4"/><path d="M6 4h3.5v5H6zM14.5 4H18v5h-3.5z"/></svg>',
};

function icon(name) {
  const span = el('span', 'ico');
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = ICONS[name] || '';
  span.style.display = 'inline-flex';
  return span;
}

/** 相对时间：刚刚 / 3 小时前 / 5 天前 / 2025-08-14 */
function relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < 5 * min) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove('show'), 1900);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = el('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    return true;
  } catch {
    return false;
  }
}

/** 关键词高亮（大小写不敏感，支持多词）。 */
function appendHighlighted(parent, text, kw) {
  const keys = [...new Set(String(kw).toLowerCase().split(/\s+/).filter((k) => k.length > 0))];
  if (!keys.length) {
    parent.append(document.createTextNode(text));
    return;
  }
  const lower = text.toLowerCase();
  const marks = new Array(text.length).fill(false);
  for (const key of keys) {
    let from = 0;
    while (from <= lower.length - key.length) {
      const idx = lower.indexOf(key, from);
      if (idx === -1) break;
      for (let i = idx; i < idx + key.length; i += 1) marks[i] = true;
      from = idx + key.length;
    }
  }
  let buffer = '';
  let bufferMarked = false;
  const flush = () => {
    if (!buffer) return;
    if (bufferMarked) {
      const mark = el('mark');
      mark.textContent = buffer;
      parent.append(mark);
    } else {
      parent.append(document.createTextNode(buffer));
    }
    buffer = '';
  };
  for (let i = 0; i < text.length; i += 1) {
    if (marks[i] !== bufferMarked) {
      flush();
      bufferMarked = marks[i];
    }
    buffer += text[i];
  }
  flush();
}

/* ------------------------------------------------------------------ */
/* 主题                                                                */
/* ------------------------------------------------------------------ */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#070a13' : '#f5f7fc');
}

function initTheme() {
  const fromUrl = new URLSearchParams(location.search).get('theme');
  const saved = fromUrl === 'dark' || fromUrl === 'light' ? fromUrl : localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
  if (fromUrl === 'dark' || fromUrl === 'light') localStorage.setItem(THEME_KEY, fromUrl);
  els.themeBtn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
}

/* ------------------------------------------------------------------ */
/* 搜索历史                                                            */
/* ------------------------------------------------------------------ */

function readHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(list) ? list.filter((s) => typeof s === 'string').slice(0, MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

function pushHistory(kw) {
  const list = [kw, ...readHistory().filter((k) => k !== kw)].slice(0, MAX_HISTORY);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  renderHistory();
}

function renderHistory() {
  const list = readHistory();
  els.recentBlock.hidden = list.length === 0 || document.body.classList.contains('searching');
  els.recentChips.replaceChildren();
  for (const kw of list) {
    const chip = el('button', 'chip', kw);
    chip.type = 'button';
    chip.addEventListener('click', () => runSearch(kw));
    els.recentChips.append(chip);
  }
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function typeInfo(id) {
  return state.meta?.panTypes?.find((t) => t.id === id) || { id, name: id, short: id, color: '#94a3b8' };
}

function renderTabs() {
  els.tabs.replaceChildren();
  const makeTab = (id, name, count) => {
    const tab = el('button', 'tab');
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(state.type === id));
    tab.append(document.createTextNode(name));
    tab.append(el('b', null, String(count)));
    tab.addEventListener('click', () => selectType(id));
    return tab;
  };

  els.tabs.append(makeTab('all', '全部', state.allCount));
  for (const t of state.types) {
    const info = typeInfo(t.id);
    els.tabs.append(makeTab(t.id, info.short || info.name, t.count));
  }
}

function sortedItems() {
  let list = state.items;
  if (state.sort === 'latest') {
    list = [...list].sort((a, b) => (b.ts || 0) - (a.ts || 0) || (b.score || 0) - (a.score || 0));
  } else if (state.sort === 'relevance') {
    list = [...list].sort((a, b) => (b.score || 0) - (a.score || 0) || (b.ts || 0) - (a.ts || 0));
  }
  return list;
}

function buildCard(item) {
  const card = el('article', 'card');
  const main = el('div', 'card-main');

  const title = el('h3', 'card-title');
  title.title = item.title;
  appendHighlighted(title, item.title, state.kw);
  main.append(title);

  const meta = el('div', 'card-meta');
  const info = typeInfo(item.panType);
  const badge = el('span', 'badge', info.name);
  badge.style.setProperty('--c', info.color);
  meta.append(badge);

  if (item.size) {
    const size = el('span', 'meta-item');
    size.append(icon('disk'), document.createTextNode(item.size));
    meta.append(size);
  }
  if (item.ts) {
    const time = el('span', 'meta-item');
    time.append(icon('clock'), document.createTextNode(relTime(item.ts)));
    meta.append(time);
  }
  if (item.channel) {
    const ch = el('span', 'channel');
    ch.textContent = item.channel;
    ch.title = `来源频道：${item.channel}`;
    meta.append(ch);
  }
  if (Array.isArray(item.channels) && item.channels.length > 1) {
    meta.append(el('span', 'meta-item', `${item.channels.length} 个频道收录`));
  }
  main.append(meta);

  const side = el('div', 'card-side');
  if (item.password) {
    const pwd = el('button', 'pwd');
    pwd.type = 'button';
    pwd.title = '点击复制提取码';
    pwd.append(el('span', null, '提取码'), document.createTextNode(item.password));
    pwd.addEventListener('click', async () => {
      const ok = await copyText(item.password);
      toast(ok ? `提取码 ${item.password} 已复制` : '复制失败，请手动选择');
    });
    side.append(pwd);
  }

  const isMagnet = item.panType === 'magnet';
  const copyBtn = el('button', 'act');
  copyBtn.type = 'button';
  copyBtn.append(icon(isMagnet ? 'magnet' : 'copy'), document.createTextNode(isMagnet ? '复制磁力' : '复制链接'));
  copyBtn.addEventListener('click', async () => {
    const ok = await copyText(item.url);
    toast(ok ? '链接已复制，去网盘打开吧' : '复制失败，请手动选择');
  });
  side.append(copyBtn);

  if (!isMagnet) {
    const open = el('a', 'act primary', '打开');
    open.href = item.url;
    open.target = '_blank';
    open.rel = 'noopener noreferrer nofollow';
    open.append(icon('open'));
    side.append(open);
  }

  card.append(main, side);
  return card;
}

function renderSkeleton() {
  els.list.replaceChildren();
  for (let i = 0; i < 5; i += 1) {
    const row = el('div', 'skeleton');
    const col = el('div', 'sk-col');
    col.append(el('div', 'sk-line'));
    const short = el('div', 'sk-line');
    short.style.width = `${45 + ((i * 13) % 30)}%`;
    col.append(short);
    row.append(col);
    els.list.append(row);
  }
  els.list.setAttribute('aria-busy', 'true');
}

function renderList() {
  const list = sortedItems();
  const shown = list.slice(0, state.page * PAGE_SIZE);

  els.list.replaceChildren();
  els.list.removeAttribute('aria-busy');
  const fragment = document.createDocumentFragment();
  for (const item of shown) fragment.append(buildCard(item));
  els.list.append(fragment);

  els.empty.hidden = list.length !== 0;
  if (list.length === 0) {
    els.emptyHint.textContent =
      state.type === 'all'
        ? '换个关键词试试，或者用更常见的译名 / 英文名。'
        : '这个网盘下没有结果，切回“全部”看看别的网盘。';
  }

  const remain = list.length - shown.length;
  els.more.hidden = remain <= 0;
  els.more.textContent = remain > 0 ? `加载更多（剩余 ${remain} 条）` : '';

  const parts = [];
  if (state.kw) parts.push(`共 ${state.total} 条`);
  if (state.truncated) parts.push(`已显示前 ${state.items.length} 条`);
  if (state.elapsed) parts.push(state.elapsed >= 1000 ? `${(state.elapsed / 1000).toFixed(1)}s` : `${state.elapsed}ms`);
  if (state.demo) parts.push('离线样例');
  els.statText.textContent = parts.join(' · ');
}

function renderNotice() {
  const messages = [...state.warnings];
  if (state.demo) messages.unshift('上游数据源暂时不可用，以下是内置离线样例数据（仅用于演示，可稍后重试）');
  els.notice.replaceChildren();
  if (!messages.length) {
    els.notice.hidden = true;
    return;
  }
  const ul = el('ul');
  for (const m of [...new Set(messages)]) ul.append(el('li', null, m));
  els.notice.append(ul);
  if (state.demo || state.stale) {
    const retry = el('button', 'notice-retry', '重新检索');
    retry.type = 'button';
    retry.addEventListener('click', () => loadResults(state.type, { skeleton: true }));
    els.notice.append(retry);
  }
  els.notice.hidden = false;
}

function renderSuggestions() {
  els.emptySuggest.replaceChildren();
  for (const word of (state.meta?.hot || []).slice(0, 6)) {
    const chip = el('button', 'chip', word);
    chip.type = 'button';
    chip.addEventListener('click', () => runSearch(word));
    els.emptySuggest.append(chip);
  }
}

/* ------------------------------------------------------------------ */
/* 数据加载                                                            */
/* ------------------------------------------------------------------ */

function setLoading(on) {
  state.loading = on;
  els.form.classList.toggle('loading', on);
  els.form.querySelector('.search-btn').disabled = on;
}

function syncUrl(mode = 'replace') {
  const params = new URLSearchParams();
  if (state.kw) params.set('kw', state.kw);
  if (state.type !== 'all') params.set('type', state.type);
  if (state.sort !== 'default') params.set('sort', state.sort);
  const search = params.toString();
  const url = search ? `?${search}` : location.pathname;
  if (mode === 'push') history.pushState({ kw: state.kw }, '', url);
  else history.replaceState({ kw: state.kw }, '', url);
}

/**
 * 拉取某个网盘类型的结果。
 * @param {string} type
 * @param {{skeleton?: boolean}} [options]
 */
async function loadResults(type, { skeleton = false } = {}) {
  const reqId = ++state.reqId;
  const started = performance.now();
  state.type = type;
  state.page = 1;

  if (skeleton) renderSkeleton();
  else els.list.setAttribute('aria-busy', 'true');
  setLoading(true);

  try {
    const params = new URLSearchParams({ kw: state.kw, type, sort: 'default', limit: '400' });
    const res = await fetch(`/api/search?${params}`, { headers: { accept: 'application/json' } });
    const json = await res.json().catch(() => null);
    if (reqId !== state.reqId) return; // 有更新的请求，丢弃本次响应
    if (!res.ok || !json?.ok) throw new Error(json?.error?.message || `请求失败（HTTP ${res.status}）`);

    state.items = Array.isArray(json.items) ? json.items : [];
    state.types = Array.isArray(json.types) ? json.types : [];
    state.total = Number(json.total) || 0;
    state.allCount = state.types.reduce((sum, t) => sum + t.count, 0) || state.total;
    state.truncated = Boolean(json.truncated);
    state.warnings = Array.isArray(json.warnings) ? json.warnings : [];
    state.demo = Boolean(json.demo);
    state.stale = Boolean(json.stale);
    state.elapsed = Math.round(performance.now() - started);

    els.error.hidden = true;
    els.toolbar.hidden = false;
    renderTabs();
    renderNotice();
    renderList();
    renderSuggestions();
    renderHistory();
  } catch (err) {
    if (reqId !== state.reqId) return;
    els.list.replaceChildren();
    els.list.removeAttribute('aria-busy');
    els.empty.hidden = true;
    els.toolbar.hidden = true;
    els.more.hidden = true;
    els.error.hidden = false;
    els.errorText.textContent = err?.message || '网络或数据源暂时不可用，请稍后重试。';
    els.statText.textContent = '';
  } finally {
    if (reqId === state.reqId) setLoading(false);
  }
}

async function selectType(type) {
  if (state.type === type && !state.loading) return;
  state.type = type;
  renderTabs();
  syncUrl('replace');
  if (type === 'all') {
    await loadResults('all');
  } else {
    await loadResults(type);
  }
}

/* ------------------------------------------------------------------ */
/* 搜索                                                                */
/* ------------------------------------------------------------------ */

async function runSearch(rawKw, { push = true, updateUrl = true, applyType = null, applySort = null } = {}) {
  const kw = String(rawKw || '').trim();
  if (!kw) {
    els.kw.focus();
    toast('先输入要搜索的关键词');
    return;
  }

  state.kw = kw;
  state.type = 'all';
  state.sort = applySort && applySort !== 'default' ? applySort : 'default';
  state.page = 1;
  els.kw.value = kw;
  els.sort.value = state.sort;
  els.clearBtn.hidden = false;

  document.body.classList.add('searching');
  els.results.hidden = false;
  els.error.hidden = true;
  els.empty.hidden = true;
  els.notice.hidden = true;
  els.statText.textContent = '';
  els.tabs.replaceChildren();
  els.more.hidden = true;

  if (push) pushHistory(kw);
  if (updateUrl) syncUrl('push');
  window.scrollTo({ top: 0, behavior: 'auto' });

  await loadResults(applyType && applyType !== 'all' ? applyType : 'all', { skeleton: true });
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

function bindEvents() {
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch(els.kw.value);
  });

  els.kw.addEventListener('input', () => {
    els.clearBtn.hidden = !els.kw.value;
  });

  els.clearBtn.addEventListener('click', () => {
    els.kw.value = '';
    els.clearBtn.hidden = true;
    els.kw.focus();
  });

  els.sort.addEventListener('change', () => {
    state.sort = els.sort.value;
    state.page = 1;
    renderList();
    syncUrl('replace');
  });

  els.more.addEventListener('click', () => {
    state.page += 1;
    renderList();
  });

  els.retry.addEventListener('click', () => {
    if (state.kw) loadResults(state.type, { skeleton: true });
  });

  els.clearHistory.addEventListener('click', () => {
    localStorage.removeItem(HISTORY_KEY);
    renderHistory();
    toast('已清除搜索历史');
  });

  els.toTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

  window.addEventListener(
    'scroll',
    () => {
      els.toTop.classList.toggle('show', window.scrollY > 560);
    },
    { passive: true }
  );

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (e.key === '/' && !typing) {
      e.preventDefault();
      els.kw.focus();
      els.kw.select();
    }
    if (e.key === 'Escape' && document.activeElement === els.kw) {
      els.kw.blur();
    }
  });

  window.addEventListener('popstate', () => {
    const params = new URLSearchParams(location.search);
    const kw = params.get('kw') || '';
    if (!kw) {
      document.body.classList.remove('searching');
      els.results.hidden = true;
      els.kw.value = '';
      renderHistory();
      return;
    }
    runSearch(kw, {
      push: false,
      updateUrl: false,
      applyType: params.get('type'),
      applySort: params.get('sort'),
    });
  });
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  initTheme();
  bindEvents();
  renderHistory();

  try {
    const res = await fetch('/api/meta');
    const meta = await res.json();
    if (meta?.ok) {
      state.meta = meta;
      els.hotChips.replaceChildren();
      for (const word of (meta.hot || []).slice(0, 14)) {
        const chip = el('button', 'chip', word);
        chip.type = 'button';
        chip.addEventListener('click', () => runSearch(word));
        els.hotChips.append(chip);
      }
      els.sort.replaceChildren();
      for (const s of meta.sorts || []) {
        const opt = el('option', null, s.name);
        opt.value = s.id;
        els.sort.append(opt);
      }
      if (meta.panTypes?.length) els.statTypes.textContent = String(meta.panTypes.length - 1);
      if (meta.sources?.length) els.sourceText.textContent = meta.sources.map((s) => s.label).join('、');
      if (meta.version) els.version.textContent = `v${meta.version}`;
    }
  } catch {
    /* 元信息失败不影响搜索 */
  }

  const params = new URLSearchParams(location.search);
  const kw = params.get('kw');
  if (kw) {
    await runSearch(kw, {
      push: false,
      updateUrl: false,
      applyType: params.get('type'),
      applySort: params.get('sort'),
    });
  } else {
    els.kw.focus({ preventScroll: true });
  }
}

boot();
