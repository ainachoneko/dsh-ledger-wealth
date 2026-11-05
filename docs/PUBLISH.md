# 上架到 DSH 插件市场：还需要做什么

先说结论：**市场没有「上传」入口**。DSH 桌面端的插件市场（`dshmarket`）不托管插件，它只读一份精选列表；列表的数据在一个 GitHub 仓库里，一个插件一个 YAML 文件。所以「上架」这个动作 = **给你的插件建一个公开 GitHub 仓库，然后往列表仓库提一个加文件的 PR**，通常一天内生效。

npm 发布是可选项，但强烈建议做，理由见下面第 2 节。

---

## 0. 市场到底是怎么装你的插件的

市场打开时实时拉取 `https://awesome-dsh-plugin.com/plugins.json`（数据源就是 `awesome-dsh-plugin` 仓库的 `data/plugins/*.yml`）。点「安装」时，它按这个顺序挑安装目标（`dshmarket` 内部 `installTargetFor`）：

| 顺序 | 条目里有 | 实际执行的安装 |
| --- | --- | --- |
| 1 | `npm` 字段（站点 CI 自动补，来自你仓库的 `package.json`） | `pnpm add <npm 包名>@<精确版本>` |
| 2 | `tarball` 字段（你自己 GitHub Release 的 `.tgz`） | 该 release 压缩包 |
| 3 | 都没有 | `pnpm add github:<owner>/<repo>` |

第三条意味着 **不上 npm 也能被市场安装**，只是会拉整仓 tarball、装不了「精确版本」、更新检测靠 commit 比 HEAD。上 npm 之后前两条生效，快得多，也能被 `dsh plugin add dsh-ledger-wealth@1.0.0` 直接装。

另一个硬约束：市场只允许安装**精选列表里出现过的来源**，列表外的 npm 包或仓库链接一律拒绝。所以「提 PR」不是走形式，是唯一入口。

---

## 1. 公开 GitHub 仓库（必需）

`dsh.plugin.json` 那套不是 DSH 插件；DSH 插件就是 npm 包形态的 cordis 插件，装进 profile 的 `node_modules` 并由 `dsh.profile.bundles` 激活。列表条目校验的是**仓库**，所以先把仓库建对：

- 仓库名用 `dsh-ledger-wealth`（不要用现在本地目录的中文名）；
- **仓库根就是插件包根**：`package.json`、`cordis.patch.yml`、`lib/` 都在根目录。现在本地是 `packages/dsh-ledger-wealth`，推送时把它作为仓库根，或者用 subpath 条目（见文末「monorepo」）；
- `package.json` 里必须有 `dsh.bundle.patch`，且指向真实存在的 `cordis.patch.yml`——**只声明 `dsh.client` 是最常见的被拒原因**，那玩意儿装不上；
- `lib/` 必须提交进仓库：市场会把「声明了入口但文件不存在」判成 broken 并回滚，`github:` 安装不跑构建，靠 `prepare` 生成 `lib/` 等于装不上；
- **不要加 `prepare` / `postinstall` / `preinstall`**：pnpm 会拦构建脚本（市场要弹审批），`github:` 安装一跑 prepare 就卡在审批上。本项目零运行期依赖、`lib/` 是源码，天然满足；
- 仓库**创建满 1 天**（CI 自动查，刚建就提 PR 必挂）；
- 加 GitHub topic **`dsh-plugin`**；
- 描述只能陈述功能，写数字就得对得上（我们会写「20 个工具」，代码里就是 20 个）。

本地这一份已经补好了市场需要的元数据，直接推就行：

```bash
cd packages/dsh-ledger-wealth
git init -b main
git add -A
git commit -m "feat: dsh-ledger-wealth 1.0.0"
git remote add origin https://github.com/<owner>/dsh-ledger-wealth.git
git push -u origin main
```

推之前把 `<owner>` 换成你的 GitHub 账号，`package.json` 里的 `repository` / `homepage` / `bugs`、`README.md` 里的链接、`docs/market-entry.yml` 里的 `OWNER` 都用这条命令一次替换：

```bash
node scripts/prepare-release.mjs --owner <你的GitHub账号>
```

`package.json` 现在同时写了顶层 `engines.dsh` 和 `dsh.engines.dsh`。原因：市场安装前的兼容性闸门读的是**顶层 `engines.dsh`**（`@deepseek-ai/dsh-app-boot` 的 `unmetRequirements` 也只认这个位置），只有 `dsh.engines.dsh` 时它会退回去看 peer 范围。两个都写，才不会出现「装上就被判 incompatible」或漏判。

---

## 2. 发布到 npm（可选，建议做）

`dsh-ledger-wealth` 这个名字在 npm 上目前是空的（查过 `registry.npmjs.org` 返回 404），可以直接用。

```bash
cd packages/dsh-ledger-wealth
npm login                     # 首次
node scripts/pack.mjs         # 本地先验证打包内容
npm publish --access public   # 无 scope，public 可省
```

发布前确认 `npm view dsh-ledger-wealth version` 能查到、`npm view dsh-ledger-wealth repository.url` 指向你的仓库——站点 CI 就是靠仓库里的 `package.json` 把 npm 包名和仓库对应起来，对不上就不会生成 `npm` 字段（市场于是退回 `github:` 安装）。

后续每次改版：`npm version patch && npm publish`，市场会在卡片上给出「更新」提示。

---

## 3. 提 PR 到精选列表（真正上架）

仓库：[`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

只加**一个文件**，路径和文件名严格照抄：

```
data/plugins/<owner>__dsh-ledger-wealth.yml
```

内容用 `docs/market-entry.yml`，把 `OWNER` 换成你的账号（`prepare-release.mjs` 已经替换过）。字段就四个：`url`（必须与仓库完全一致）、`name`（`owner/repo`）、`category`、`description`（`en` 必填、`zh` 可选），可选 `icon`。

- `category` 用了 `tools`：这个插件装进 agent 的是 20 个 `ledger_*` / `wealth_*` / `finance_*` 工具，归 `tools` 最贴。选偏了维护者会直接改，不会因此打回。
- 描述里出现 `": "`（冒号+空格）**必须加引号**，否则 YAML 当成嵌套键，CI 直接红。
- 不要动两个 README，它们由 `data/plugins/*.yml` 生成；也不要顺手改别人的条目。

PR 通过 CI（校验 manifest、仓库年龄、YAML 格式、README 能否重新生成）后由维护者人工读一遍代码。合并后站点与市场自动刷新，通常在一天内。之后别人在「插件 → 发现」里搜「记账」就能看到并一键装上。

---

## 4. 提 PR 前的自查

```bash
cd packages/dsh-ledger-wealth
node scripts/check.mjs                 # 全部模块可导入
node tests/run.mjs                     # 20 个工具 + 领域逻辑用例
node scripts/pack.mjs                  # 打包内容齐全（lib/、cordis.patch.yml 都在）
npm pack --dry-run                     # 发布前看一眼文件清单
```

外加三项人工确认：仓库是公开的、有 `dsh-plugin` topic、创建满一天。

---

## 5. monorepo 的写法（如果不想拆仓库）

条目里 `url` 指向子目录，`name` 带 `#` 后缀，文件名也要跟着变：

```yaml
url: https://github.com/<owner>/dsh-plugins/tree/main/packages/dsh-ledger-wealth
name: <owner>/dsh-plugins#dsh-ledger-wealth
```

文件名：`data/plugins/<owner>__dsh-plugins--packages-dsh-ledger-wealth.yml`

市场会装成 `github:<owner>/dsh-plugins#path:/packages/dsh-ledger-wealth`。能上架，但安装要拉整个 monorepo，比独立仓库或 npm 慢；能用独立仓库就别用这条。

---

## 常见退回原因（对着排）

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| CI 红：manifest | 只有 `dsh.client`，没有 `dsh.bundle.patch` | 补 `dsh.bundle` + `cordis.patch.yml` |
| CI 红：repo age | 仓库刚建就提 PR | 等满 24 小时重提，不影响下次 |
| CI 红：YAML | 描述含 `": "` 没加引号 | 整段加引号 |
| 装上但没工具 | `lib/` 没提交，或 patch 里的 `name` 与包名不一致 | 提交 `lib/`，核对 `cordis.patch.yml` 的 `name: dsh-ledger-wealth` |
| 装上就被判 incompatible | 只写了 `dsh.engines.dsh`，宿主读顶层 `engines.dsh` | 补顶层 `engines.dsh` |
| 市场里搜不到 | 只推了仓库，没提列表 PR | 提 PR，等合并 |
