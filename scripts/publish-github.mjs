/**
 * 通过 GitHub REST API 发布仓库（不需要本地安装 git）。
 *
 * 用法：
 *   node scripts/publish-github.mjs --token ghp_xxx --repo panseek --private false
 *   GH_TOKEN=ghp_xxx node scripts/publish-github.mjs --repo panseek
 *
 * 做了什么：
 *   1. GET /user 校验 token
 *   2. 仓库不存在则创建（auto_init=false），已存在则复用
 *   3. 把当前目录（排除 .git / node_modules / .env 等）打包成一棵 tree
 *   4. 生成一个 commit，创建或快进对应分支，并把它设为默认分支
 *
 * 需要的权限：
 *   - classic PAT：repo
 *   - fine-grained PAT：Contents = Read and write（建仓还需要 Administration = Read and write）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.github.com';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 && args[i + 1] ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const token = arg('token', process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '');
const repo = arg('repo', 'panseek');
const ownerArg = arg('owner', '');
const branch = arg('branch', 'main');
const isPrivate = String(arg('private', 'false')).toLowerCase() === 'true';
const message = arg('message', 'feat: PanSeek 网盘资源聚合搜索');
const dryRun = flag('dry-run');

const IGNORE_DIRS = new Set(['.git', 'node_modules', '.idea', '.vscode', 'coverage']);
const IGNORE_FILES = new Set(['.env', '.env.local', '.DS_Store', 'Thumbs.db']);

if (!token && !dryRun) {
  console.error('缺少 token：--token ghp_xxx 或环境变量 GH_TOKEN');
  process.exit(2);
}

class GitHubError extends Error {
  constructor(method, url, status, payload) {
    const detail = payload?.message || '';
    const errs = Array.isArray(payload?.errors) ? ` ${JSON.stringify(payload.errors)}` : '';
    super(`${method} ${url} → ${status} ${detail}${errs}`);
    this.status = status;
    this.payload = payload;
  }
}

async function gh(method, urlPath, body, { allow = [] } = {}) {
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'panseek-publisher',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  if (!res.ok && !allow.includes(res.status)) throw new GitHubError(method, urlPath, res.status, json);
  return { status: res.status, json };
}

/**
 * 用哪个分支提交：
 *  - 空仓库（default_branch 为空）→ 用 --branch，默认 main
 *  - 已有内容的仓库 → 跟随它当前的默认分支，避免为了改名去要 Administration 权限
 */
function resolveBranch(repoInfo, branch) {
  return repoInfo?.default_branch || branch;
}

/** 递归收集要发布的文件（相对路径 + 内容）。 */async function collectFiles(dir = ROOT, base = '', out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.git')) continue;
    const abs = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      await collectFiles(abs, rel, out);
    } else if (!IGNORE_FILES.has(entry.name)) {
      out.push({ rel, abs, size: (await fs.stat(abs)).size });
    }
  }
  return out;
}

async function main() {
  const files = (await collectFiles()).sort((a, b) => a.rel.localeCompare(b.rel));
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  console.log(`准备发布 ${files.length} 个文件（${(totalBytes / 1024 / 1024).toFixed(2)} MB）→ ${repo}${isPrivate ? ' (private)' : ''}`);
  if (dryRun) {
    for (const f of files) console.log(`  ${f.rel} (${(f.size / 1024).toFixed(1)} KB)`);
    return;
  }

  const me = (await gh('GET', '/user')).json;
  const owner = ownerArg || me.login;
  console.log(`身份：${me.login}；目标仓库：${owner}/${repo}`);

  // 1) 仓库不存在就建
  let repoInfo = (await gh('GET', `/repos/${owner}/${repo}`, null, { allow: [404] })).json;
  if (!repoInfo) {
    console.log('仓库不存在，正在创建…');
    repoInfo = (
      await gh('POST', me.login === owner ? '/user/repos' : `/orgs/${owner}/repos`, {
        name: repo,
        private: isPrivate,
        description: '一个搜索框搜遍全网网盘 · 零依赖自托管的网盘资源聚合搜索',
        homepage: '',
        auto_init: false,
        has_issues: true,
        has_wiki: false,
        has_projects: false,
      })
    ).json;
    console.log(`已创建：${repoInfo.html_url}`);
  } else {
    console.log(`仓库已存在：${repoInfo.html_url}（${repoInfo.default_branch || '空仓库'}）`);
  }

  // 2) 每个文件建 blob
  const tree = [];
  for (const [index, file] of files.entries()) {
    const content = await fs.readFile(file.abs);
    const blob = (await gh('POST', `/repos/${owner}/${repo}/git/blobs`, {
      content: content.toString('base64'),
      encoding: 'base64',
    })).json;
    tree.push({ path: file.rel, mode: '100644', type: 'blob', sha: blob.sha });
    process.stdout.write(`\r  blob ${index + 1}/${files.length} ${file.rel}`.padEnd(80));
  }
  console.log('\n  blob 全部上传完成');

  // 3) 已有分支则基于其 tree 做增量，保留仓库里其他文件
  //    空仓库没有分支，就沿用它默认分支的名字，避免为了改名再要 Administration 权限
  const targetBranch = resolveBranch(repoInfo, branch);
  const ref = (await gh('GET', `/repos/${owner}/${repo}/git/ref/heads/${targetBranch}`, null, { allow: [404, 409] })).json;
  let parentSha = null;
  let baseTree = null;
  if (ref?.object?.sha) {
    parentSha = ref.object.sha;
    const commit = (await gh('GET', `/repos/${owner}/${repo}/git/commits/${parentSha}`)).json;
    baseTree = commit.tree.sha;
    console.log(`  基于已有分支 ${targetBranch}（${parentSha.slice(0, 7)}）提交`);
  }

  const newTree = (await gh('POST', `/repos/${owner}/${repo}/git/trees`, {
    tree,
    ...(baseTree ? { base_tree: baseTree } : {}),
  })).json;

  const newCommit = (await gh('POST', `/repos/${owner}/${repo}/git/commits`, {
    message,
    tree: newTree.sha,
    ...(parentSha ? { parents: [parentSha] } : { parents: [] }),
  })).json;

  // 4) 创建或快进分支
  if (parentSha) {
    await gh('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${targetBranch}`, { sha: newCommit.sha, force: true });
  } else {
    await gh('POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${targetBranch}`, sha: newCommit.sha });
  }

  // 5) 默认分支指向它（空仓库首次推送时尤其需要）。
  //    fine-grained token 只有 Contents 权限时这里会 403，属于预期，给出提示即可。
  if (repoInfo.default_branch !== targetBranch) {
    const res = await gh('PATCH', `/repos/${owner}/${repo}`, { default_branch: targetBranch }, { allow: [403, 422] });
    if (res.status !== 200) {
      console.warn(`  提示：默认分支仍为 ${repoInfo.default_branch}，请在仓库 Settings → Branches 手动切到 ${targetBranch}`);
    }
  }

  console.log(`\n完成：${repoInfo.html_url}（commit ${newCommit.sha.slice(0, 7)}，分支 ${targetBranch}）`);
}

main().catch((err) => {
  console.error(`\n发布失败：${err.message}`);
  if (err.status === 401) console.error('  → token 无效或已过期');
  if (err.status === 403) console.error('  → 权限不足：classic PAT 需要 repo 权限；fine-grained 需要 Contents(+Administration) 读写');
  if (err.status === 404) console.error('  → 仓库/接口不存在：确认 owner 拼写与 token 的仓库范围');
  process.exit(1);
});
