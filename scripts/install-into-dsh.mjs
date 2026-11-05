#!/usr/bin/env node
/**
 * 把本仓库装进本机 DSH —— 给「拿到 zip、没有 dsh 命令」的人用。
 *
 * 做的事，顺序固定、每步可回滚：
 *   1. 找到 DSH home / profile / DSH 自带的 pnpm（不依赖全局安装）；
 *   2. 备份 profile 的 package.json 与 pnpm-lock.yaml；
 *   3. `pnpm add -w link:<本目录>`（默认）或 `file:<dist/*.tgz>`（--pack）；
 *   4. **先验证再登记**：加载装好的包、apply 到假 ctx、确认工具全部注册；
 *   5. 验证通过才写进 `dsh.profile.bundles`（--no-bundles 可跳过）。
 *
 * 用法：
 *   node scripts/install-into-dsh.mjs                 # 链接当前目录（改代码即时生效）
 *   node scripts/install-into-dsh.mjs --pack          # 先 npm pack 再用 tgz 装（自包含副本）
 *   node scripts/install-into-dsh.mjs --profile work  # 装到别的 profile
 *   node scripts/install-into-dsh.mjs --dry-run       # 只打印将要执行的命令
 *   node scripts/install-into-dsh.mjs --remove        # 卸载并移出 bundles
 *
 * 为什么默认用 link：zip 解压出来没有 dist/*.tgz，而打 tgz 需要 npm。
 * link 只需要 node + DSH 自带的 pnpm，两条都必然存在。
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_NAME = 'dsh-ledger-wealth'
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

const REQUIRED_TOOLS = ['ledger_balance', 'ledger_add_entry', 'wealth_summary', 'finance_monthly_report']

function parseArgs(argv) {
  const options = {
    profile: 'desktop',
    mode: 'auto',
    dryRun: false,
    remove: false,
    bundles: true,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--profile') options.profile = argv[++i]
    else if (arg === '--pack') options.mode = 'tgz'
    else if (arg === '--link') options.mode = 'link'
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--remove') options.remove = true
    else if (arg === '--no-bundles') options.bundles = false
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

/** npm 存在才能打 tgz。 */
function hasNpm() {
  try {
    execFileSync('npm', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' })
    return true
  } catch {
    return false
  }
}

/** DSH home：优先 DSH_HOME，否则 ~/.dsh。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME?.trim()
  return fromEnv ? resolve(fromEnv) : join(homedir(), '.dsh')
}

/** 在 DSH 运行时目录里找 pnpm（桌面版自带）。 */
function findPnpm(home) {
  const runtimes = join(home, 'dsh-runtimes')
  if (!existsSync(runtimes)) return null
  for (const entry of readdirSync(runtimes)) {
    for (const candidate of [
      join(runtimes, entry, 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'),
      join(runtimes, entry, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
    ]) {
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

function listProfiles(home) {
  const dir = join(home, 'profiles')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => existsSync(join(dir, name, 'package.json')))
}

function backup(path) {
  if (!existsSync(path)) return null
  const target = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(path, target)
  return target
}

function readProfile(profileDir) {
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) throw new Error(`不是 DSH profile 目录（没有 package.json）：${profileDir}`)
  return { manifestPath, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) }
}

/** 往 dsh.profile.bundles 里加/删插件名。 */
function updateBundles(profileDir, { add, name }) {
  const { manifestPath, manifest } = readProfile(profileDir)
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  const present = bundles.includes(name)
  if (add && !present) bundles.push(name)
  else if (!add && present) bundles.splice(bundles.indexOf(name), 1)
  else return { changed: false, bundles }
  manifest.dsh.profile.bundles = bundles
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { changed: true, bundles }
}

/** 装完真的加载一次：工具没全注册就不登记进 bundles。 */
async function verifyInstalled(profileDir) {
  const entry = join(profileDir, 'node_modules', PLUGIN_NAME, 'lib', 'index.js')
  if (!existsSync(entry)) throw new Error(`安装后找不到入口：${entry}`)
  const mod = await import(pathToFileURL(entry).href)
  const registered = new Map()
  const disposers = []
  const ctx = {
    tools: { register: (tool) => (registered.set(tool.name, tool), () => registered.delete(tool.name)) },
    effect: (setup) => {
      const dispose = setup()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    logger: { info() {}, warn() {}, error() {} },
  }
  const { mkdtempSync, rmSync } = await import('node:fs')
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-ledger-verify-'))
  try {
    mod.apply(ctx, { dbPath: join(scratch, 'verify.sqlite') })
    const names = [...registered.keys()]
    const missing = REQUIRED_TOOLS.filter((name) => !names.includes(name))
    if (missing.length > 0) throw new Error(`插件加载了，但缺少工具：${missing.join('、')}`)
    const balance = await registered.get('ledger_balance').execute({}, {})
    if (balance?.ok !== false || balance.code !== 'need_initial_balance') {
      throw new Error('工具能注册但调用异常，判定安装失败')
    }
    return { toolCount: names.length, version: mod.version ?? null }
  } finally {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 忽略 */
      }
    }
    try {
      rmSync(scratch, { recursive: true, force: true })
    } catch {
      /* Windows 上 sqlite 句柄可能晚一步释放 */
    }
  }
}

/** --pack：npm pack 出一个自包含 tgz。 */
function packTarball() {
  const distDir = join(repoRoot, 'dist')
  mkdirSync(distDir, { recursive: true })
  const output = execFileSync('npm', ['pack', '--pack-destination', distDir], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  const tarball = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.tgz'))
    .pop()
  if (!tarball) throw new Error(`npm pack 没有输出文件名：\n${output}`)
  return join(distDir, tarball)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''))
    return
  }

  const home = dshHome()
  const profileDir = join(home, 'profiles', options.profile)
  if (!existsSync(profileDir)) {
    throw new Error(
      `找不到 profile：${profileDir}\n` +
        `已安装 DSH 的话，可用 profile：${listProfiles(home).join('、') || '（无）'}\n` +
        'DSH 装在别处时，用 DSH_HOME 环境变量指过去。',
    )
  }

  const pnpm = findPnpm(home)
  const runner = pnpm ? [process.execPath, [pnpm]] : [process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', []]
  const workspaceFlag = existsSync(join(profileDir, 'pnpm-workspace.yaml')) ? ['-w'] : []

  console.log(`DSH home    : ${home}`)
  console.log(`profile     : ${profileDir}`)
  console.log(`pnpm        : ${pnpm ?? 'PATH 上的 pnpm（DSH 运行时里没找到）'}`)

  if (options.remove) {
    const argvRemove = [...runner[1], 'remove', ...workspaceFlag, PLUGIN_NAME]
    console.log(`\n将要执行：${runner[0]} ${argvRemove.join(' ')}`)
    if (options.dryRun) return
    backup(join(profileDir, 'package.json'))
    backup(join(profileDir, 'pnpm-lock.yaml'))
    execFileSync(runner[0], argvRemove, { cwd: profileDir, stdio: 'inherit' })
    const { changed } = updateBundles(profileDir, { add: false, name: PLUGIN_NAME })
    console.log(changed ? '\n✓ 已卸载，并从 bundles 移除。重启 DSH 生效。' : '\n✓ 已卸载（bundles 里本来就没有它）。')
    return
  }

  // auto：有 npm 就打 tgz（自包含副本，删了源码目录也不坏）；没有就用 link（零额外工具）。
  const mode = options.mode === 'auto' ? (hasNpm() ? 'tgz' : 'link') : options.mode
  console.log(`安装方式    : ${mode === 'tgz' ? 'tgz 自包含副本' : 'link 就地链接'}${options.mode === 'auto' ? '（自动选择）' : ''}`)

  let target = `link:${repoRoot}`
  let archiveNote = ''
  if (mode === 'tgz') {
    if (options.dryRun) {
      target = 'file:<npm pack 生成的 tgz>'
    } else {
      const tarball = packTarball()
      // `file:` 是长期引用，先复制到 DSH home 下的稳定位置：
      // 以后这个解压目录被移动或删掉，profile 里的依赖路径依然有效。
      const archiveDir = join(home, 'plugin-archives')
      mkdirSync(archiveDir, { recursive: true })
      const stableTarball = join(archiveDir, basename(tarball))
      copyFileSync(tarball, stableTarball)
      target = `file:${stableTarball}`
      archiveNote = `\n安装包      : ${stableTarball}（自包含副本，删掉本目录也不影响）`
    }
  } else {
    archiveNote = '\n提示        : link 模式会把 DSH 指向这个目录，别移动或删除它；要自包含副本用 --pack。'
  }

  const argvAdd = [...runner[1], 'add', ...workspaceFlag, target]
  console.log(`源码目录    : ${repoRoot}${archiveNote}`)
  console.log(`\n将要执行：${runner[0]} ${argvAdd.join(' ')}`)
  if (options.dryRun) {
    console.log('\n[dry-run] 未做任何改动。去掉 --dry-run 才会真的安装。')
    return
  }

  const pkgBackup = backup(join(profileDir, 'package.json'))
  const lockBackup = backup(join(profileDir, 'pnpm-lock.yaml'))
  if (pkgBackup) console.log(`已备份      : ${pkgBackup}`)
  if (lockBackup) console.log(`已备份      : ${lockBackup}`)

  // 切换安装方式时必须先卸载：pnpm 会把「link: ↔ file:」判成「已满足」，
  // 只改 package.json 里的 spec，node_modules 里仍是旧软链，最后入口找不到。
  const desiredProtocol = target.startsWith('file:') ? 'file:' : 'link:'
  const currentSpec = String(readProfile(profileDir).manifest.dependencies?.[PLUGIN_NAME] ?? '')
  if (currentSpec && !currentSpec.startsWith(desiredProtocol)) {
    console.log(`\n检测到安装方式变化（${currentSpec.slice(0, 5)} → ${desiredProtocol}），先卸载旧引用`)
    execFileSync(runner[0], [...runner[1], 'remove', ...workspaceFlag, PLUGIN_NAME], {
      cwd: profileDir,
      stdio: 'inherit',
    })
  }

  execFileSync(runner[0], argvAdd, { cwd: profileDir, stdio: 'inherit' })

  const verified = await verifyInstalled(profileDir)
  console.log(`\n✓ 安装并验证通过：${PLUGIN_NAME}${verified.version ? `@${verified.version}` : ''} 注册了 ${verified.toolCount} 个工具`)

  if (options.bundles) {
    const { changed, bundles } = updateBundles(profileDir, { add: true, name: PLUGIN_NAME })
    console.log(changed ? `✓ 已加入 dsh.profile.bundles（共 ${bundles.length} 项）` : '· bundles 里已有它，未改动')
  } else {
    console.log('· 按 --no-bundles 跳过登记（插件不会被加载）')
  }

  console.log('\n重启 DSH 后生效。会话里问「我的余额是多少」，能调用到 ledger_balance 就说明装好了。')
  console.log('卸载：node scripts/install-into-dsh.mjs --remove')
}

main().catch((error) => {
  console.error(`\n安装失败：${error.message}`)
  process.exitCode = 1
})
