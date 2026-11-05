/**
 * 把发布材料里的 OWNER 占位符一次性替换成真实 GitHub 账号，并生成可直接拖进 PR 的条目文件。
 *
 * 用法：
 *   node scripts/prepare-release.mjs --owner yourname
 *   node scripts/prepare-release.mjs --owner yourname --repo dsh-ledger-wealth
 *
 * 改动的文件（原地替换，可重复执行）：
 *   package.json            author / repository / homepage / bugs
 *   docs/market-entry.yml   条目模板（url / name / icon）
 *
 * 产物：
 *   dist/catalog/<owner>__<repo>.yml   提 PR 时放进 awesome-dsh-plugin 的 data/plugins/
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function argOf(flag, fallback) {
  const index = process.argv.indexOf(flag)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  return value === undefined || value.startsWith('--') ? fallback : value
}

const owner = argOf('--owner', null)
const repo = argOf('--repo', 'dsh-ledger-wealth')

if (owner === null || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
  console.error('缺少或非法的 --owner。用法：node scripts/prepare-release.mjs --owner <GitHub 用户名>')
  process.exit(1)
}

const read = (file) => readFileSync(join(root, file), 'utf8')
const write = (file, text) => writeFileSync(join(root, file), text, 'utf8')

// 1. package.json：作者与仓库三件套（站点 CI 靠 repository 把 npm 包和仓库对上）
const pkgFile = 'package.json'
const pkg = JSON.parse(read(pkgFile))
pkg.author = owner
pkg.repository = { type: 'git', url: `git+https://github.com/${owner}/${repo}.git` }
pkg.homepage = `https://github.com/${owner}/${repo}#readme`
pkg.bugs = { url: `https://github.com/${owner}/${repo}/issues` }
write(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`)

// 2. 条目模板
const entryFile = 'docs/market-entry.yml'
const entry = read(entryFile)
  // 三个出现位置（url / name / icon）都含 "/OWNER/dsh-ledger-wealth"
  .replaceAll('name: OWNER/dsh-ledger-wealth', `name: ${owner}/${repo}`)
  .replaceAll('/OWNER/dsh-ledger-wealth', `/${owner}/${repo}`)
write(entryFile, entry)

// 3. 产出可直接提交的条目文件
const catalogDir = join(root, 'dist', 'catalog')
mkdirSync(catalogDir, { recursive: true })
const catalogName = `${owner}__${repo}.yml`
writeFileSync(join(catalogDir, catalogName), read(entryFile), 'utf8')

// 4. 打印下一步
const name = pkg.name
const version = pkg.version
console.log(`owner      : ${owner}`)
console.log(`repo       : https://github.com/${owner}/${repo}`)
console.log(`npm 包     : ${name}@${version}`)
console.log(`条目文件   : dist/catalog/${catalogName}`)
console.log('')
console.log('接下来三步：')
console.log(`  1) git init -b main && git add -A && git commit -m "feat: ${name} ${version}"`)
console.log(`     git remote add origin https://github.com/${owner}/${repo}.git && git push -u origin main`)
console.log('     （仓库要公开、加 dsh-plugin topic、建满 1 天后才能过 CI）')
console.log(`  2) npm publish --access public    # 可选，但市场会优先用 npm 装`)
console.log(`  3) 在 awesome-dsh-plugin 仓库加 data/plugins/${catalogName}，提 PR`)
