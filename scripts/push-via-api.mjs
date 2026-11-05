#!/usr/bin/env node
/**
 * 用 GitHub REST API 把本地仓库推上去（绕开 github.com，只用 api.github.com）。
 *
 * 适用场景：网络只能访问 api.github.com、git push 被代理拦掉（CONNECT 502）。
 * 代价：历史被压成一个 commit（API 一次建一棵树）。
 *
 * 用法:
 *   GITHUB_TOKEN=ghp_xxx node scripts/push-via-api.mjs
 *   GITHUB_TOKEN=ghp_xxx node scripts/push-via-api.mjs --topics dsh-plugin,bookkeeping \
 *     --description "本地优先的记账 + 理财持仓 DSH 插件" --homepage https://example.com
 *   node scripts/push-via-api.mjs --dry-run          # 不需要 token，只看要传什么
 *
 * Token 需要：classic PAT 勾 repo / public_repo（改 topics 需要 repo 权限），
 * 或 fine-grained PAT 给该仓库 Contents: Read and write + Administration: Read and write。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const API = 'https://api.github.com'

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const argOf = (flag, fallback = null) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const DRY = has('--dry-run')
const TOKEN = process.env.GITHUB_TOKEN || argOf('--token')
const MESSAGE = argOf('--message')
const TOPICS = (argOf('--topics') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const DESCRIPTION = argOf('--description')
const HOMEPAGE = argOf('--homepage')

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
}

/** 从 origin 推断 owner/repo，允许 --repo 覆盖。 */
function resolveRepo() {
  const override = argOf('--repo')
  if (override && override.includes('/')) {
    const [owner, repo] = override.split('/')
    return { owner, repo }
  }
  let url = ''
  try {
    url = git('remote', 'get-url', 'origin').trim()
  } catch {
    throw new Error('没有 origin 远程，请加 --repo owner/repo')
  }
  const m = url.match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (!m) throw new Error(`无法从 origin 解析仓库：${url}`)
  return { owner: m[1], repo: m[2] }
}

/** 取被跟踪文件及其 git 权限位。 */
function listFiles() {
  const raw = execFileSync('git', ['ls-files', '-sz'], { cwd: ROOT, maxBuffer: 64 << 20 })
  return raw
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t')
      const meta = line.slice(0, tab).split(' ')
      return { mode: meta[0] === '100755' ? '100755' : '100644', path: line.slice(tab + 1) }
    })
}

async function api(method, path, body, { allowStatus = [] } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-ledger-wealth-push',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  if (!res.ok && !allowStatus.includes(res.status)) {
    const detail = json?.message ?? text.slice(0, 300)
    throw new Error(`${method} ${path} → ${res.status} ${detail}`)
  }
  return { status: res.status, json }
}

/** 小并发跑任务，避免 47 个 blob 请求把连接打满。 */
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      out[i] = await worker(items[i], i)
    }
  })
  await Promise.all(runners)
  return out
}

async function main() {
  const { owner, repo } = resolveRepo()
  const files = listFiles()
  const totalBytes = files.reduce((sum, f) => sum + statSync(join(ROOT, f.path)).size, 0)

  console.log(`仓库        : ${owner}/${repo}`)
  console.log(`本地分支    : ${git('rev-parse', '--abbrev-ref', 'HEAD').trim()}`)
  console.log(`文件        : ${files.length} 个，合计 ${(totalBytes / 1024).toFixed(1)} KB`)
  console.log(`本地 git 历史: ${git('rev-list', '--count', 'HEAD').trim()} 个提交（将压成 1 个）`)

  if (DRY) {
    console.log('\n[dry-run] 将要上传：')
    for (const f of files) console.log(`  ${f.mode}  ${f.path}`)
    if (TOPICS.length) console.log(`\n[dry-run] topics → ${TOPICS.join(', ')}`)
    if (DESCRIPTION) console.log(`[dry-run] description → ${DESCRIPTION}`)
    console.log('\n[dry-run] 未发任何请求。去掉 --dry-run 并设置 GITHUB_TOKEN 才会真的推。')
    return
  }

  if (!TOKEN) throw new Error('缺少 GITHUB_TOKEN 环境变量（或 --token）')

  const me = await api('GET', '/user')
  console.log(`\n认证账号    : ${me.json.login}`)
  if (me.json.login.toLowerCase() !== owner.toLowerCase()) {
    console.warn(`⚠ 登录账号与仓库所有者不一致（${me.json.login} ≠ ${owner}），若没有写权限会失败`)
  }

  console.log('\n1/4 上传文件内容（blob）…')
  const blobs = await mapLimit(files, 6, async (f) => {
    const content = readFileSync(join(ROOT, f.path)).toString('base64')
    const { json } = await api('POST', `/repos/${owner}/${repo}/git/blobs`, {
      content,
      encoding: 'base64',
    })
    return { ...f, sha: json.sha }
  })
  console.log(`     ✓ ${blobs.length} 个 blob`)

  console.log('2/4 建立目录树（tree）…')
  const { json: tree } = await api('POST', `/repos/${owner}/${repo}/git/trees`, {
    tree: blobs.map((b) => ({ path: b.path, mode: b.mode, type: 'blob', sha: b.sha })),
  })
  console.log(`     ✓ tree ${tree.sha.slice(0, 7)}`)

  console.log('3/4 建立提交（commit）…')
  const branches = await api('GET', `/repos/${owner}/${repo}/branches`, null, { allowStatus: [] })
  const branchName = argOf('--branch', 'main')
  const existing = branches.json.find((b) => b.name === branchName)
  const headSha = existing?.commit?.sha ?? null

  const commitBody = {
    message: MESSAGE || git('log', '-1', '--pretty=%B').trim() || 'chore: 初始提交',
    tree: tree.sha,
    ...(headSha ? { parents: [headSha] } : {}),
  }
  const { json: commit } = await api('POST', `/repos/${owner}/${repo}/git/commits`, commitBody)
  console.log(`     ✓ commit ${commit.sha.slice(0, 7)}（${headSha ? '基于现有 head' : '首个提交'}）`)

  console.log(`4/4 更新分支 ${branchName} …`)
  if (headSha) {
    await api('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branchName}`, {
      sha: commit.sha,
      force: false,
    })
  } else {
    await api('POST', `/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${branchName}`,
      sha: commit.sha,
    })
  }
  console.log(`     ✓ refs/heads/${branchName} → ${commit.sha.slice(0, 7)}`)

  if (DESCRIPTION || HOMEPAGE || TOPICS.length) {
    console.log('\n附加：仓库信息与 topics')
    const patch = {
      ...(DESCRIPTION ? { description: DESCRIPTION } : {}),
      ...(HOMEPAGE ? { homepage: HOMEPAGE } : {}),
    }
    if (Object.keys(patch).length) {
      try {
        await api('PATCH', `/repos/${owner}/${repo}`, patch)
        console.log('     ✓ 描述 / 主页已更新')
      } catch (e) {
        console.warn(`     ⚠ 描述未更新：${e.message}`)
      }
    }
    if (TOPICS.length) {
      try {
        const r = await api('PUT', `/repos/${owner}/${repo}/topics`, { names: TOPICS })
        console.log(`     ✓ topics → ${(r.json?.names ?? TOPICS).join(', ')}`)
      } catch (e) {
        console.warn(`     ⚠ topics 未设置（token 缺 repo/Administration 权限）：${e.message}`)
        console.warn(`       网页手动加：仓库首页 → About 右侧齿轮 → Topics 输入 ${TOPICS.join(', ')}`)
      }
    }
  }

  console.log(`\n完成：https://github.com/${owner}/${repo}`)
  console.log(`校验：https://api.github.com/repos/${owner}/${repo}/commits?per_page=1`)
}

main().catch((e) => {
  console.error(`\n失败：${e.message}`)
  if (/401/.test(e.message)) console.error('→ token 无效或过期，重新生成一个')
  if (/403/.test(e.message)) console.error('→ token 权限不够，classic token 需勾 repo（或 public_repo）')
  if (/404/.test(e.message)) console.error('→ 仓库不存在，或 token 对该仓库没有访问权限')
  process.exit(1)
})
