/**
 * 离线样例数据源。
 *
 * 用途：上游不可达 / 被限流时仍能让页面可用（演示、内网部署、首次试用）。
 * 数据是抓取真实结果后裁剪保存的，结构与 PanSou 响应一致，因此走同一套解析逻辑。
 */
import fs from 'node:fs';
import { parsePansouPayload } from './pansou.mjs';

const DEFAULT_FILE = new URL('../../data/demo.json', import.meta.url);

/**
 * @param {{file?: string|URL}} [options]
 */
export function createDemoAdapter({ file = DEFAULT_FILE } = {}) {
  /** @type {object[]|null} */
  let cached = null;

  function load() {
    if (cached) return cached;
    const raw = fs.readFileSync(file, 'utf8');
    cached = parsePansouPayload(JSON.parse(raw)).items;
    return cached;
  }

  return {
    id: 'demo',
    label: '离线样例',

    /**
     * @param {string} kw
     */
    async search(kw) {
      const all = load();
      const key = String(kw).toLowerCase().trim();
      const tokens = key.split(/\s+/).filter(Boolean);
      const matched = all.filter((item) => {
        const title = item.title.toLowerCase();
        if (title.includes(key)) return true;
        return tokens.length > 1 && tokens.every((t) => title.includes(t));
      });
      return { items: matched, endpoint: 'demo', took: 0, total: matched.length };
    },
  };
}
