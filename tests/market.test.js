/**
 * 上架前的机械自查。
 *
 * 这里断言的都是「市场会在安装/收录时真的检查」的东西，不是风格偏好：
 *   - 精选列表要求仓库声明 `dsh.bundle.patch`（只声明 `dsh.client` 会被打回）
 *   - 市场把「声明了入口但文件不存在」判成 broken 并回滚，`github:` 安装不跑构建
 *   - 安装前的兼容性闸门读顶层 `engines.dsh`，宿主 boot gate 也只认这个位置
 *   - pnpm 会拦 `prepare` / `postinstall`，安装卡在构建审批上
 *   - 条目 YAML 里 description 含 ": " 必须加引号，否则解析失败
 */

import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readText = (file) => readFileSync(join(root, file), 'utf8')
const readJson = (file) => JSON.parse(readText(file))

const pkg = readJson('package.json')

describe('市场收录：仓库形态', () => {
  it('package.json 声明 dsh.bundle.patch，且文件真的在', () => {
    const patch = pkg.dsh?.bundle?.patch
    assert.equal(typeof patch, 'string', '缺少 dsh.bundle.patch，市场不会认为这是可安装插件')
    assert.ok(existsSync(join(root, patch)), `dsh.bundle.patch 指向的 ${patch} 不存在`)
  })

  it('cordis.patch.yml 的 insert 行 name 与包名一致', () => {
    const patch = readText(pkg.dsh.bundle.patch)
    assert.match(patch, /-\s*insert:/)
    assert.ok(
      patch.includes(`name: ${pkg.name}`),
      `cordis.patch.yml 里的 name 必须是 ${pkg.name}，否则装上也不注册任何工具`,
    )
  })

  it('入口文件已提交（github: 安装不跑构建）', () => {
    const entry = typeof pkg.main === 'string' ? pkg.main : pkg.exports?.['.']
    assert.equal(typeof entry, 'string')
    assert.ok(existsSync(join(root, entry)), `${entry} 不存在：声明了入口但没有文件，市场会判 broken 并回滚`)
  })

  it('没有会让 pnpm 卡在构建审批的安装脚本', () => {
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublishOnly']) {
      assert.equal(pkg.scripts?.[hook], undefined, `不该声明 ${hook}：pnpm 会拦构建脚本，市场安装会卡住`)
    }
  })
})

describe('市场收录：兼容性与元数据', () => {
  it('顶层 engines.dsh 覆盖当前宿主 0.2.1-rc.2', () => {
    const range = pkg.engines?.dsh
    assert.equal(typeof range, 'string', '安装前的兼容性闸门读顶层 engines.dsh，缺了会退回 peer 判断')
    assert.match(range, />=\s*0\.2\.1-rc\.1/)
    assert.match(range, /<\s*0\.3\.0/)
  })

  it('dsh.engines.dsh 与顶层保持一致（发现页也读这一份）', () => {
    assert.equal(pkg.dsh?.engines?.dsh, pkg.engines?.dsh)
  })

  it('repository 指向 GitHub，站点 CI 靠它把 npm 包和仓库对上', () => {
    const url = pkg.repository?.url ?? pkg.repository
    assert.match(String(url), /github\.com[/:]/, '没有 GitHub 仓库地址就生成不出 npm 映射')
  })

  it('files 覆盖运行时需要的一切', () => {
    const files = pkg.files ?? []
    for (const needed of ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
      assert.ok(files.includes(needed), `files 里缺 ${needed}`)
    }
  })
})

describe('市场收录：条目文件', () => {
  const entry = readText('docs/market-entry.yml')

  it('四个必填字段齐全', () => {
    for (const key of ['url:', 'name:', 'category:', 'description:']) {
      assert.ok(entry.includes(`\n${key}`) || entry.startsWith(key), `条目缺 ${key}`)
    }
  })

  it('description 含 ": " 时整段加引号（否则 YAML 当成嵌套键）', () => {
    const en = /^\s{2}en:\s*(.+)$/m.exec(entry)?.[1] ?? ''
    assert.ok(en.length > 0, '缺 description.en')
    if (en.includes(': ')) {
      assert.ok(en.startsWith('"') || en.startsWith("'"), 'description.en 里有 ": "，必须加引号')
    }
  })

  it('category 用的是精选列表的真实取值', () => {
    const allowed = new Set([
      'agi', 'ui', 'usage', 'theme', 'model', 'identity', 'session', 'memory', 'tools',
      'wsl', 'browser', 'vision', 'voice', 'docs', 'skill', 'workflow', 'git', 'notify',
      'dev', 'security', 'remote', 'market', 'fun',
    ])
    const category = /^category:\s*(.+)$/m.exec(entry)?.[1].trim() ?? ''
    assert.ok(allowed.has(category), `category ${category} 不在列表取值内`)
  })

  it('描述里不出现营销词（会被维护者打回）', () => {
    const banned = ['最好的', '最强', '颠覆', '革命性', 'best-in-class', 'world-class', 'revolutionary', 'blazing']
    for (const word of banned) {
      assert.equal(entry.toLowerCase().includes(word.toLowerCase()), false, `描述里出现了营销词：${word}`)
    }
  })
})

describe('CI 配置：YAML 必须是 GitHub 能解析的', () => {
  const workflow = readText('.github/workflows/ci.yml')

  // 真实踩过的坑：`run: ... console.log('入口 ok: '+f)` 里的「冒号+空格」在 YAML
  // plain scalar 中是键值分隔符，整份 workflow 被判非法，运行直接 0 个 job 失败。
  it('顶层字段与步骤值里不出现未加引号的「冒号+空格」', () => {
    const offenders = []
    workflow.split(/\r?\n/).forEach((line, index) => {
      const match = /^\s*(?:-\s+)?(?:run|name|with|uses):\s+(\S.*)$/.exec(line)
      if (!match) return
      const value = match[1]
      if (/^['"|>]/.test(value)) return
      if (value.includes(': ')) offenders.push(`第 ${index + 1} 行：${line.trim()}`)
    })
    assert.deepEqual(offenders, [], `这些行的值含未转义的「冒号+空格」，YAML 会解析失败：\n${offenders.join('\n')}`)
  })

  it('没有制表符、BOM 或 CRLF', () => {
    assert.equal(workflow.includes('\t'), false, 'workflow 里不能有制表符')
    assert.equal(workflow.charCodeAt(0) === 0xfeff, false, 'workflow 不能以 BOM 开头')
    assert.equal(workflow.includes('\r'), false, 'workflow 必须是 LF 换行')
  })

  it('必跑的三步都在：自检、测试、打包', () => {
    for (const step of ['node scripts/check.mjs', 'node tests/run.mjs', 'node scripts/pack.mjs']) {
      assert.ok(workflow.includes(step), `workflow 缺少步骤：${step}`)
    }
  })
})
