# 安装 dsh-ledger-wealth

三条路，按「想要多省事」排序。核心区别只有一个：**想在插件市场里被别人一键装到，得先被精选列表收录**（收录的完整步骤见 [PUBLISH.md](PUBLISH.md)）。

| 方式 | 需要什么 | 适合谁 |
| --- | --- | --- |
| A. 插件市场 | 包进精选列表（建议同时发布 npm） | 想像装其他插件一样点一下 |
| B. 本地 tgz | 只要有这个 `.tgz` 文件 | 自己用、不想发 npm |
| C. link 源码 | 仓库在本机 | 想改代码 |

环境要求：DSH ≥ `0.2.1-rc.1`；Node ≥ 22.5（插件用内置 `node:sqlite`，没有任何 npm 运行期依赖）。

---

## A. 插件市场

市场只列出 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 精选列表里的插件，
列表数据是 `data/plugins/*.yml`，一个插件一个文件。收录前先在市场里搜不到你，属正常现象。

```bash
# 1) 发布到 npm（建议——市场优先用 npm 装：快、锁精确版本、能提示更新）
cd packages/dsh-ledger-wealth
npm login                      # 只需一次
npm publish --access public    # 包名 dsh-ledger-wealth

# 2) 把条目提给精选列表（一个 YAML 文件，就是全部投稿）
#    文件：data/plugins/<owner>__dsh-ledger-wealth.yml
#    内容：docs/market-entry.yml（先跑 node scripts/prepare-release.mjs --owner <账号> 填好占位符）
```

合并后站点与市场自动刷新（通常一天内），之后：

- **图形化**：DSH → 插件 → 发现 → 搜「记账」或 `dsh-ledger-wealth` → 安装；
- **命令行**：`dsh plugin --profile desktop add dsh-ledger-wealth@1.0.0`

> 桌面端安装要精确版本（`name@1.0.0`），`@latest` 不被接受。
> 没发布 npm 也能被装：条目没有 npm 映射时市场退回 `pnpm add github:<owner>/<repo>`，只是慢一些、按 commit 更新。

## B. 本地 tgz（不需要 npm 账号）

```bash
# 1) 打包
cd packages/dsh-ledger-wealth
node scripts/pack.mjs
#   -> dist/dsh-ledger-wealth-1.0.0.tgz

# 2) 装进 profile（二选一）
dsh plugin --profile desktop add "file:D:/路径/dsh-ledger-wealth-1.0.0.tgz"

# 没有 dsh 命令时，用仓库里的安装脚本（内部用 DSH 自带的 pnpm，无需全局 pnpm）
node scripts/install-plugin.mjs
```

`install-plugin.mjs` 的顺序是刻意的：**先装、再验证、验证通过才登记**。

1. 备份 profile 的 `package.json` 与 `pnpm-lock.yaml`；
2. `pnpm add -w file:<tgz>` 装进 `<profile>/node_modules`；
3. 真正 `import` 一次装好的包、`apply()` 到假 ctx，确认 20 个工具全部注册、`ledger_balance` 调用正常；
4. 通过后才把 `dsh-ledger-wealth` 写进 `dsh.profile.bundles`；
5. 任何一步失败都停下并打印原因，**不会把坏包装进启动列表**。

常用参数：

```bash
node scripts/install-plugin.mjs --dry-run      # 只打印将执行的命令
node scripts/install-plugin.mjs --tgz <路径>    # 装指定的 tgz
node scripts/install-plugin.mjs --profile <名>  # 装到别的 profile
node scripts/install-plugin.mjs --remove       # 卸载（pnpm remove + 移出 bundles）
```

## C. link 源码（开发用）

```bash
dsh plugin --profile desktop add "link:D:/DSH_WorkPlace/记账理财插件/packages/dsh-ledger-wealth"
```

改完 `lib/*.js` 重启 DSH 即生效，不用重新打包。

---

## 装完怎么确认

1. **重启 DSH**（bundles 是启动时读的）。
2. 新开会话问一句「我的余额是多少」：
   - 被调用到 `ledger_balance` 并回答「还没设置初始余额」→ 装好了（这是设计：初始余额必须你亲口给，不默认 0）；
   - 完全没有这个工具 → 看下面的排错。
3. 想更直接：让它调用 `finance_status`，会打印数据库路径、时区、数据源开关、最近任务。

数据默认落在 `~/.dsh/ledger-wealth/ledger.sqlite`（可用 `dbPath` 改）。

## 配置覆盖

不要改包里的 `cordis.patch.yml`（升级会被覆盖）。在 **profile 自己的** `cordis.patch.yml` 里加同 id 条目：

```yaml
- id: ledger-wealth
  config:
    timeZone: Asia/Shanghai
    dailyJobCron: '0 20 * * *'
    fundApiEnabled: true
    bankApiEnabled: true
    dbPath: ''
```

改完重启。`dbPath` 指向已有文件即可接管旧数据。

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 会话里看不到 `ledger_*` / `wealth_*` 工具 | 没重启；或 bundles 里没有 `dsh-ledger-wealth`。重跑一次 `node scripts/install-plugin.mjs`，看它是否打印「已加入 dsh.profile.bundles」 |
| 启动报 `node:sqlite` 不可用 | DSH 自带的 Node 太低。要求 Node ≥ 22.5，Desktop 0.2.1-rc 系列自带 Node 24，正常不会遇到 |
| `finance_setup_schedules` 报 `schedule_unavailable` | DSH 没有提供定时服务。收益同步改用 `finance_run_daily_job` 手动触发，或挂系统计划任务 |
| 理财收益显示「沿用上次值（非实时）」 | 数据源当天取不到（周末/网络/基金代码错）。这是设计行为，不会编数字 |
| `ledger_scan_receipt` 报 `no_ocr_provider` | 本机没有 OCR。装 `rapidocr_onnxruntime` 到一个 venv，把 `ocrVenvPython` 指过去；或者直接文字记账 |
| 基金代码填错 | 只能是 6 位数字（如 `000001`），非 6 位会直接拒绝 |
| 想换个地方放数据库 | 配置 `dbPath`，重启后生效；老数据复制过去即可 |

## 卸载

```bash
node scripts/install-plugin.mjs --remove
# 或：dsh plugin --profile desktop remove dsh-ledger-wealth
```

卸载**不会**删除数据。想彻底清掉：删掉 `~/.dsh/ledger-wealth/` 目录（先备份）。
