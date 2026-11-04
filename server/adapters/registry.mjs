/**
 * 数据源注册表。
 *
 * 想接新的资源站？实现同样的接口即可：
 *   { id, label, search(kw) => Promise<{items, endpoint, took, total}> }
 * 然后在 createAdapters() 里 push 进去，其余（并发、超时、去重、排序、缓存）由框架负责。
 */
import { createPansouAdapter } from './pansou.mjs';
import { createDemoAdapter } from './demo.mjs';

/**
 * @param {import('../config.mjs').config} config
 * @param {{fetchImpl?: typeof fetch, demoFile?: string|URL}} [options]
 */
export function createAdapters(config, { fetchImpl, demoFile } = {}) {
  /** @type {object[]} */
  const adapters = [
    createPansouAdapter({ endpoints: config.endpoints, timeout: config.upstreamTimeout, fetchImpl }),
  ];
  // 内置一个新源：把下面几行取消注释即可参与聚合
  // adapters.push(myAdapter);
  return adapters;
}

export { createDemoAdapter };
