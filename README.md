<img src="assets/icon-180.png" width="88" align="right" alt="dsh-ledger-wealth">

# dsh-ledger-wealth · 记账 + 理财

DSH（DeepSeek Harness）插件。把「今天花了多少」和「理财今天赚了多少」放进同一个会话里，
但**两笔钱永远是两本账**：分表存、分节报、任何地方都不相加。

- **A 记账**：一句话/一张小票 → 结构化账目 → 用户确认 → 落库；余额 = 初始余额 + 累计收入 − 累计支出；
  月末报告给支出、收入、净结余、分类占比（前 5）、最大单笔、环比。
- **B 理财**：持仓录入 → 每日收益按**严格降级链**取数 → 每个数字都带来源标注；月末理财报告单独一节。
- **物理隔离**：`ledger_entries` / `wealth_*` 两张表，报告用分隔线切开，没有跨模块合计。
- **纯本地**：数据就是你自己机器上的一个 SQLite 文件，不经过任何服务器。

## 安装

三种方式，选一种即可。详见 [docs/INSTALL.md](docs/INSTALL.md)。

```bash
# 1) 已发布到 npm 之后（市场里能搜到，或直接按名字装）
dsh plugin --profile desktop add dsh-ledger-wealth

# 2) 用本地打好的 tgz 装（不需要 npm 账号）
dsh plugin --profile desktop add ./dsh-ledger-wealth-1.0.0.tgz

# 3) 源码开发（改代码即时生效）
dsh plugin --profile desktop add link:/绝对路径/packages/dsh-ledger-wealth
```

装完重启 DSH，会话里就能看到下面这些工具。数据库默认落在 `~/.dsh/ledger-wealth/ledger.sqlite`。

> 想让它出现在 **DSH 插件市场**里被别人一键安装，缺的不是代码，而是「收录」：
> 市场只列出精选列表 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 里的插件。
> 步骤（建公开仓库 → 可选发布 npm → 提一个 YAML 的 PR）见 [docs/PUBLISH.md](docs/PUBLISH.md)。

## 配置

配置文件在插件包的 `cordis.patch.yml`；要覆盖就在 **profile 自己的** `cordis.patch.yml` 里加一条同 id 的
`config`（不要改包里的文件，升级会被覆盖）：

```yaml
- id: ledger-wealth
  config:
    timeZone: Asia/Shanghai
    dbPath: ''                 # 空 = ~/.dsh/ledger-wealth/ledger.sqlite
    dailyJobCron: '0 20 * * *'
    monthlyJobCron: '0 21 28-31 * *'
    fetchTimeoutMs: 8000
    fundApiEnabled: true       # 关掉 = 基金也走「沿用上次值」
    bankApiEnabled: true       # 银行理财目前没有免费源，恒 not_covered
    ocrProvider: auto          # auto | command | rapidocr | none
    ocrCommand: ''             # 自定义 OCR CLI，stdout 出文字
    ocrVenvPython: ''          # 装了 rapidocr_onnxruntime 的 python
```

## 工具清单

| 工具 | 作用 |
| --- | --- |
| `ledger_set_initial_balance` | 设置初始余额（必填，**不会默认按 0 处理**） |
| `ledger_add_entry` | 记一笔账：先预览，`confirm:true` 才落库 |
| `ledger_list_entries` | 按月份/类型列账目 |
| `ledger_delete_entry` | 删账目：先预览，`confirm:true` 才删 |
| `ledger_balance` | 当前可支配余额 + 本月收支 |
| `ledger_month_summary` | 月度汇总：分类占比、最大单笔、每日明细 |
| `ledger_scan_receipt` | 小票图片 → 草稿（识别不到就留空，不猜） |
| `wealth_add_product` | 录入持仓：先预览，`confirm:true` 才写 |
| `wealth_update_product` | 改持仓/份额/手动收益/日期/归档 |
| `wealth_list_products` | 列出持仓（含已归档可选项） |
| `wealth_record_profit` | 手填某天收益（同日重记幂等覆盖） |
| `wealth_refresh_profit` | 按降级链刷新收益，缺失的产品明确报缺失 |
| `wealth_summary` | 理财月度汇总：本月/累计收益、来源、到期提醒 |
| `finance_monthly_report` | 月末双节报告（记账 + 理财，中间分隔线，无合并总额） |
| `finance_run_daily_job` / `finance_run_month_end_job` | 手动触发定时任务（幂等） |
| `finance_setup_schedules` / `finance_schedule_status` | 注册/查看两条定时任务 |
| `finance_alerts` / `finance_status` | 数据源告警 / 插件自检 |

## 收益降级链（B 模块的核心）

按顺序尝试，每一步都留在返回值的 `attempts` 里：

1. `manual` —— 你手填的当日收益；
2. `api` —— 基金真实净值差：`份额 × (今日单位净值 − 上一交易日单位净值)`；
3. `estimated` —— 只有涨跌幅时，用 `持仓金额 × 涨跌幅` 估算，**明确标注是估算**；
4. `not_covered` —— 银行理财没有免费数据源，直接说不可用（不爬登录态页面）；
5. `stale` —— 全都失败就沿用上次记录，并写明「非实时」；
6. `unavailable` —— 连历史值都没有，如实报缺失，**不落库、不编数字**。

**任何情况下都不会用「年化收益率 ÷ 365」去推算昨日收益。** 七日年化只用于展示。

## 数据放在哪

```
~/.dsh/ledger-wealth/ledger.sqlite     # 记账与理财共用同一个文件，但分表
```

- 记账表：`ledger_entries`；理财表：`wealth_products`、`wealth_daily_profit`；
  运维表：`meta`、`job_runs`、`monthly_reports`、`alerts`。
- 金额一律以**整数分**落库（`*_cents`），只有对外 JSON 和文案才转成「元 + 两位小数」。
- 备份 = 复制那个 `.sqlite` 文件；删插件不会删数据，想彻底清干净自己删目录。

## 开发

```bash
cd packages/dsh-ledger-wealth
node tests/run.mjs      # 64 个用例，全内存库，不联网
node scripts/check.mjs  # 语法 + 清单自检
```

仓库里 `docs/INTERFACES.md` 是内部接口契约（表结构、签名、错误码、工具名单），改动前先读它。

## 隐私

- 没有遥测，没有账号，没有云端同步。
- 唯一的网络请求是查基金净值（东方财富公开接口），可以在配置里关掉。
- 银行理财不做任何抓取。

## License

MIT
