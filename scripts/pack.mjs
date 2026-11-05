/**
 * 打出可安装的插件包：`dist/dsh-ledger-wealth-<version>.tgz`。
 *
 * 用 `npm pack` 打包（遵循 package.json 的 `files`），打完顺手校验三件事：
 * 1. 包内必须有 `package.json` / `lib/index.js` / `cordis.patch.yml`；
 * 2. 包里不能混进 `tests/`、`node_modules/`；
 * 3. 打印安装命令。
 * @module dsh-ledger-wealth/scripts/pack
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(here, '..')
const distDir = join(pkgDir, 'dist')
mkdirSync(distDir, { recursive: true })

const { version, name } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))

const output = execFileSync('npm', ['pack', '--pack-destination', distDir], {
  cwd: pkgDir,
  encoding: 'utf8',
  shell: process.platform === 'win32',
})
const tarball = output
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.endsWith('.tgz'))
  .pop()
if (!tarball) throw new Error(`npm pack 没有输出文件名：\n${output}`)

const archive = join(distDir, tarball)
// Windows 下 `tar -tzf D:\...` 会把盘符当成远程主机，所以切到 dist 目录用相对文件名。
const listing = execFileSync('tar', ['-tzf', tarball], { cwd: distDir, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)

const required = ['package/package.json', 'package/lib/index.js', 'package/cordis.patch.yml', 'package/README.md']
for (const entry of required) {
  if (!listing.includes(entry)) throw new Error(`打包结果缺少必需文件：${entry}`)
}
const forbidden = listing.filter((entry) => entry.startsWith('package/tests/') || entry.includes('node_modules/'))
if (forbidden.length > 0) throw new Error(`打包结果混进了不该发布的文件：\n${forbidden.join('\n')}`)

console.log(`✓ ${name}@${version}`)
console.log(`  文件：${archive}（${listing.length} 个条目，${(readFileSync(archive).length / 1024).toFixed(1)} KB）`)
console.log('')
console.log('安装方式（任选其一）：')
console.log(`  dsh plugin --profile desktop add ${archive}`)
console.log(`  # 或发布到 npm 后：dsh plugin --profile desktop add ${name}@${version}`)
if (!existsSync(join(distDir, tarball))) process.exitCode = 1
