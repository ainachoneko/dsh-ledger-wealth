# 安装 dsh-ledger-wealth

四条路。如果你是**从别人那儿拿到一个 zip**，直接看 A，一条命令的事。

| 方式 | 需要什么 | 适合谁 |
| --- | --- | --- |
| A. zip / 源码目录 | 解压后的文件夹 + Node | **默认选这个**，零额外工具 |
| B. 本地 tgz | 一个 `.tgz` 文件 | 想装一份自包含副本 |
| C. 插件市场 | 插件被精选列表收录 | 想像装其他插件一样点一下 |
| D. 改代码 | 仓库在本机 | 开发 |

环境要求：DSH（Desktop 或 CLI 均可）≥ `0.2.1-rc.1`；Node ≥ 22.5。
插件用 Node 内置的 `node:sqlite`，**没有任何 npm 运行期依赖**，不需要 `pip install`，不需要编译。

---

## A. 从 zip 装（推荐）

### A-1 解压到一个不会被删的地方

```
D:\dsh-plugins\dsh-ledger-wealth\      ← 解压到这里
├─ package.json
├─ cordis.patch.yml
├─ lib\  docs\  scripts\  tests\
```

两个注意点：

- **路径别带中文和空格**。`D:\插件\记账 理财\` 这种会让 pnpm 的路径处理出岔子；
- **别解压到「下载」目录**。link 模式下 DSH 会一直指向这个文件夹，你清空下载目录插件就坏了。
  想装一份「删了源码也不影响」的副本，用 B 方式。

### A-2 跑安装脚本

```powershell
cd D:\dsh-plugins\dsh-ledger-wealth
node scripts/install-into-dsh.mjs
```

它做的事，每一步都可回滚：

1. 找到 DSH home（`~/.dsh`）与要装的 profile（默认 `desktop`）；
2. 备份 profile 的 `package.json` 与 `pnpm-lock.yaml`（`.bak-时间戳`）；
3. 用 **DSH 自带的 pnpm** 把插件装进 profile 的 `node_modules`（不需要你全局装 pnpm，也不需要 `dsh` 命令）；
4. **先验证再登记**：真的 `import` 一次装好的包、`apply()` 到假 ctx，确认 20 个工具全部注册、`ledger_balance` 调用返回 `need_initial_balance`；
5. 验证通过才把 `dsh-ledger-wealth` 写进 `dsh.profile.bundles`。

任何一步失败都会停下并打印原因，**不会把坏包装进启动列表**。

看到这几行就是成功：

```
安装方式    : tgz 自包含副本（自动选择）
✓ 安装并验证通过：dsh-ledger-wealth@1.0.0 注册了 20 个工具
✓ 已加入 dsh.profile.bundles（共 8 项）
```

然后**重启 DSH**。

### A-3 常用参数

```powershell
node scripts/install-into-dsh.mjs --dry-run       # 只打印将执行的命令，不改任何东西
node scripts/install-into-dsh.mjs --pack          # 打 tgz 再装（自包含副本）
node scripts/install-into-dsh.mjs --link          # 就地链接（改代码即时生效）
node scripts/install-into-dsh.mjs --profile work   # 装到别的 profile
node scripts/install-into-dsh.mjs --no-bundles     # 只装不登记（插件不会被加载）
node scripts/install-into-dsh.mjs --remove         # 卸载
```

默认 `--auto`：**有 npm 就打 tgz 装副本，没有就 link 当前目录**。两者都试过，装完都会验证。
安装方式可以来回切换（脚本会先卸载旧引用再装，不会留下坏软链）。

### A-4 如果你的机器上有 `dsh` 命令

等价一步：

```powershell
dsh plugin --profile desktop add "link:D:/dsh-plugins/dsh-ledger-wealth"
```

> `dsh plugin` 的目标串只接受 ASCII 且不含空格（正则 `[A-Za-z0-9@:./_#+~^=-]+`），
> 路径带中文或空格会被判 unsafe 直接拒绝——这也是 A-1 要求路径干净的原因。

## B. 本地 tgz（自包含副本）

```powershell
cd D:\dsh-plugins\dsh-ledger-wealth
node scripts/pack.mjs
#   -> dist/dsh-ledger-wealth-1.0.0.tgz

node scripts/install-into-dsh.mjs --pack
# 或：dsh plugin --profile desktop add "file:D:/dsh-plugins/dsh-ledger-wealth/dist/dsh-ledger-wealth-1.0.0.tgz"
```

tgz 会被复制到 `~/.dsh/plugin-archives/`，profile 引用的是那份副本。
所以**装完之后源码目录可以删**，插件照常工作。

## C. 插件市场

市场只列出 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 精选列表里的插件，
列表数据是 `data/plugins/*.yml`，一个插件一个文件。收录前在市场里搜不到，属正常现象。
收录流程见 [PUBLISH.md](PUBLISH.md)。

收录之后：

- **图形化**：DSH → 插件 → 发现 → 搜「记账」或 `dsh-ledger-wealth` → 安装；
- **命令行**：`dsh plugin --profile desktop add dsh-ledger-wealth@1.0.0`

> 桌面端安装要精确版本（`name@1.0.0`），`@latest` 不被接受。
> 没发布 npm 也能被装：条目没有 npm 映射时市场退回 `pnpm add github:<owner>/<repo>`，只是慢一些、按 commit 更新。

## D. 改代码（开发）

```powershell
node scripts/install-into-dsh.mjs --link
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
| `找不到 profile：...profiles\desktop` | DSH 装在非默认位置。用 `DSH_HOME` 指过去，例如 `$env:DSH_HOME="D:\dsh-home"; node scripts/install-into-dsh.mjs` |
| 脚本报 `PATH 上的 pnpm（DSH 运行时里没找到）` | 说明 DSH 没装在 `~/.dsh`。要么设 `DSH_HOME`，要么先 `npm i -g pnpm` |
| 脚本报 `安装后找不到入口` | 上一次装的是另一种方式（link ↔ tgz），脚本会自动先卸载重装；若仍失败，手动 `--remove` 后重跑 |
| 会话里看不到 `ledger_*` / `wealth_*` 工具 | 没重启；或 bundles 里没有 `dsh-ledger-wealth`。重跑脚本，看是否打印「已加入 dsh.profile.bundles」 |
| `dsh plugin ... add link:D:\插件\...` 报 `unsafe plugin target rejected` | 路径含中文或空格。换成纯英文路径，或直接用 `install-into-dsh.mjs`（不过 `dsh plugin` 的正则） |
| 启动报 `node:sqlite` 不可用 | Node 太低。要求 ≥ 22.5，Desktop 0.2.1-rc 系列自带 Node 24，正常不会遇到 |
| `finance_setup_schedules` 报 `schedule_unavailable` | DSH 没有提供定时服务。收益同步改用 `finance_run_daily_job` 手动触发，或挂系统计划任务 |
| 理财收益显示「沿用上次值（非实时）」 | 数据源当天取不到（周末/网络/基金代码错）。这是设计行为，不会编数字 |
| `ledger_scan_receipt` 报 `no_ocr_provider` | 本机没有 OCR。装 `rapidocr_onnxruntime` 到一个 venv，把 `ocrVenvPython` 指过去；或者直接文字记账 |
| 基金代码填错 | 只能是 6 位数字（如 `000001`），非 6 位会直接拒绝 |
| 想换个地方放数据库 | 配置 `dbPath`，重启后生效；老数据复制过去即可 |

## 卸载

```powershell
node scripts/install-into-dsh.mjs --remove
# 或：dsh plugin --profile desktop remove dsh-ledger-wealth
```

卸载**不会**删除数据。想彻底清掉：删掉 `~/.dsh/ledger-wealth/` 目录（先备份）。
