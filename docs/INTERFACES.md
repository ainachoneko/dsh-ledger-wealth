# dsh-ledger-wealth 内部接口契约（所有 teammate 必读）

> 本文件是团队并行开发的唯一契约。**任何签名、字段名、工具名、文案标题的改动都必须先改本文件**，
> 并同步给 Lead；不要在各自文件里另立一套命名。

## 0. 硬约束（来自需求 m00001，违反即返工）

1. 记账金额与理财金额**物理隔离**：`ledger_entries` 一张表、`wealth_*` 另两张表；报告分两节，
   中间用分隔线，**任何地方禁止把记账结余与理财收益相加**。
2. 金额落库一律 **整数分（fen）**，字段名后缀 `_cents`；只有对外 JSON / 文案才转元，两位小数。
3. 初始余额必填：未设置时任何记账写入都必须报 `need_initial_balance`，**不得默认 0**。
4. 不编造：理财数据取不到就降级（见 §6），报告标注「数据源暂不可用 / 上次更新值」；
   **禁止用年化收益率 ÷ 365 伪造昨日收益**。
5. 写账目/改持仓必须经过用户确认：工具参数 `confirm`（boolean，默认 false），
   false 时只返回预览 `{ ok: true, status: 'needs_confirmation', draft: {...} }`，不落库。
6. 不爬需要登录/反爬严格的银行页面。银行理财无免费源时就返回 `not_covered`。
7. 依赖只用 Node 内置（`node:sqlite`、`node:fs`、`node:test`、全局 `fetch`）。
   **不得新增运行期 npm 依赖**；`@deepseek-ai/dsh-tools` / `@deepseek-ai/cordis` 是 peerDependency。
8. 所有导出 ESM（`export function ...`），文件头有 `@module` JSDoc，中文注释为主。

## 1. 文件归属（写作用域互斥，别碰别人的文件）

| 文件 | 负责人 | 说明 |
| --- | --- | --- |
| `lib/money.js` `lib/dates.js` `lib/errors.js` `lib/db.js` | Lead（已完成，只读） | 公共基础，**不要改**，需要改动找 Lead |
| `lib/config.js` `lib/toolkit.js` `lib/report.js` `lib/index.js`<br>`lib/tools/report.js` `docs/*` `tests/integration.test.js` | Lead | 集成层 |
| `lib/ledger.js` `lib/tools/ledger.js` `tests/ledger.test.js` | **A-记账** | A 模块领域逻辑 + 工具 |
| `lib/wealth.js` `lib/profit.js` `lib/sources/fund.js` `lib/sources/bank.js`<br>`lib/tools/wealth.js` `tests/wealth.test.js` `tests/sources.test.js` | **B-理财** | B 模块领域逻辑 + 数据源 + 工具 |
| `lib/ocr.js` `lib/tools/ocr.js` `lib/jobs.js` `lib/tools/jobs.js`<br>`scripts/*.ps1` `README.md` `tests/ocr.test.js` `tests/jobs.test.js` | **C-运维/OCR** | OCR、定时任务、安装脚本、README |

`packages/dsh-ledger-wealth/lib/index.js` 只由 Lead 写：它 import 各模块的 `register*Tools()`。
若你的模块需要新增导出，先在本文件登记。

## 2. 金额 / 日期 / 错误 工具（`lib/money.js` `lib/dates.js` `lib/errors.js`）

```js
// money.js —— 直接 import 使用，不要自己写一套换算
CATEGORIES                          // ['餐饮','交通','购物','居住','娱乐','医疗','工资','理财赎回','其他']
toCents(yuan, field?)               // 元 -> 整数分，拒绝 NaN/负/超两位小数；抛 TypeError
toPositiveCents(yuan, field?)       // 同上，且必须 > 0
toSignedCents(yuan, field?)         // 允许负（收益可为负）
fromCents(cents)                    // -> 元 number（两位）
centsToPlain(cents)                 // -> '1234.56'
formatCny(cents)                    // -> '¥1,234.56'（负数为 '-¥1,234.56'）
formatDeltaCny(cents)               // -> '+¥1,234.56' / '-¥…'
percentOf(part, total)              // -> '37.4%'，total 为 0 时 null
optionalCents(v, field?)            // undefined/null/'' -> null，否则 toPositiveCents
optionalSignedCents(v, field?)      // undefined/null/'' -> null，否则 toSignedCents

// dates.js
dateInZone(now?, timeZone?)         // 'YYYY-MM-DD'（默认 Asia/Shanghai）
nowIso(now?)                        // ISO 审计时间
assertDate(s, field?) / monthKeyOf(date) / assertMonth(m) / daysInMonth(m)
monthRange(m)                       // { start, end }
isMonthEnd(date) / previousMonth(m) / addDays(date, n) / daysBetween(a, b) / currentMonth(now?, tz?)

// errors.js
CODES.{...}                         // 见 §7 错误码表
LedgerError(code, message, details) // 领域层 throw 这个
fail(code, message, details)        // new LedgerError 的简写
toToolError(error)                  // -> { ok:false, code, message, ...details }；非 LedgerError 归为 internal_error
```

**布尔/枚举校验**用 `TypeError`（`money.js` 风格）不合适的地方请 throw `fail('invalid_argument', '中文说明', { field })`。
工具层会统一 `toToolError`，所以领域函数**该 throw 就 throw**，不要自己拼 `{ok:false}`。

## 3. 数据库（`lib/db.js`，已建好，schema 不再改）

```sql
meta(key PK, value, updated_at)                        -- 初始余额等
ledger_entries(id PK, entry_date, type, amount_cents, category, merchant, note, source, created_at)
   type ∈ ('expense','income')；source ∈ ('text','ocr')；amount_cents > 0
wealth_products(id PK, product_name, product_type, identifier, holding_amount_cents, shares,
   cost_nav, manual_daily_profit_cents, manual_total_profit_cents, buy_date, redeem_date,
   active, last_updated, created_at)
   product_type ∈ ('fund','bank_wealth','other')；UNIQUE(product_type, identifier)
wealth_daily_profit(id PK, product_id FK, profit_date, amount_cents, source, nav_date, detail,
   fetched_at, UNIQUE(product_id, profit_date))
   source ∈ ('manual','api','estimated','stale')
job_runs(job_key PK, kind, status, summary, ran_at)
monthly_reports(month PK, ledger_json, wealth_json, rendered, created_at)
alerts(id PK, created_at, module, level, message, resolved)
```

- 打开：`openDb(path)`（自动迁移 + WAL）。测试用 `openDb(':memory:')`。
- 事务：`transaction(db, () => {...})`；**不要嵌套事务**。
- ID：`newId('entry' | 'product' | 'profit' | 'alert')`。
- meta 键：`initial_balance_cents`、`initial_balance_set_at`（由 `lib/ledger.js` 独占读写）。
- `node:sqlite` 用法：`db.prepare(sql).get(...)` / `.all(...)` / `.run(...)`；`run` 返回 `{ changes, lastInsertRowid }`。

## 4. A 模块：`lib/ledger.js`（A-记账 负责）

```js
export function getInitialBalance(db)                 // { cents, set_at } | null
export function setInitialBalance(db, { amountYuan, today, nowIso })  // 已设置过则抛 already_initialized（除非 { overwrite:true }）
export function requireInitialBalance(db)             // 无初值抛 need_initial_balance
export function recordEntry(db, { type, amountYuan, category, merchant, note, date, source })
// 校验：type 枚举、category ∈ CATEGORIES、date 真实日期、source ∈ ('text','ocr')、
//       amountYuan > 0；返回 { entry, balances, month_summary }
export function listEntries(db, { month, type, limit = 50, offset = 0 })
// -> { entries: Entry[], total }
export function deleteEntry(db, { id })               // -> { deleted: Entry }
export function getBalances(db)
// -> { initial_balance_cents, income_cents, expense_cents, balance_cents }
export function getMonthSummary(db, month, { topCategories = 5 } = {})
export function serializeEntry(row)  // -> { id, type, amount, category, merchant, date, note, source, created_at }
```

`Entry` 是数据库行；`serializeEntry` 负责转成 §需求 A1 的对外 JSON（`amount` 是元 number）。

`getMonthSummary(db, '2026-10')` 返回：

```js
{
  month: '2026-10',
  entry_count: 12,                    // 当月总笔数
  expense_entry_count: 11,            // 支出笔数（报告用）
  income_entry_count: 1,              // 收入笔数（报告用）
  expense_cents: 345000, income_cents: 1200000, net_cents: 855000,   // net = income - expense
  categories: [ { category: '餐饮', expense_cents: 120000, share: '34.8%' }, ... ], // 仅支出，倒序，前 5
  largest_expense: { id, date, merchant, category, note, amount_cents } | null,
  daily: [ { date: '2026-10-03', expense_cents: 2800, income_cents: 0 }, ... ] // 按日期升序，仅本月
}
```

`getBalances`：`balance_cents = initial + Σincome − Σexpense`（全历史）。`requireInitialBalance` 未设时抛错。

## 5. B 模块：`lib/wealth.js` + `lib/profit.js` + `lib/sources/*`（B-理财 负责）

### 5.1 `lib/wealth.js`（持久化与汇总）

```js
export function addProduct(db, payload)
// payload: { product_name, product_type, identifier, holdingAmountYuan, shares, costNav,
//            manualDailyProfitYuan, manualTotalProfitYuan, buyDate, redeemDate, today }
// -> { product }（序列化后的 §需求 B1 JSON + id）
// 校验：product_type 枚举；holdingAmountYuan > 0；基金类若有 shares 与 costNav 要能对上（仅存，不校验误差）；
//       redeemDate >= buyDate；UNIQUE(product_type, identifier) 冲突抛 duplicate_product
export function updateProduct(db, { id, patch, today })   // patch 只允许可改字段：名称/金额/份额/成本净值/手动收益/日期/active
export function listProducts(db, { active = true } = {})  // -> { products: Product[] }
export function findProduct(db, { id, identifier })       // -> Product | null
export function archiveProduct(db, { id, today })         // -> { product }（active = 0）
export function serializeProduct(row)                     // -> §需求 B1 JSON（元；日期字符串；null 保留）
export function recordDailyProfit(db, { productId, profitDate, amountCents, source, navDate = null, detail = null })
// -> { profit, replaced: boolean }；UNIQUE 冲突时覆盖（同日重跑幂等），source 必须合法
export function getProfitForDate(db, productId, profitDate)      // -> Profit | null
export function getLatestProfit(db, productId, { onOrBefore = null } = {}) // -> Profit | null
export function listProfits(db, { productId, month })            // -> { profits: Profit[] }
export function getWealthSummary(db, { month, today })
```

`getWealthSummary` 返回（**只给理财模块用，绝不与记账数字合并**）：

```js
{
  month: '2026-10',
  products: [{
    id, product_name, product_type, identifier,
    holding_amount_cents,
    month_profit_cents,            // 本月已记录收益合计（含 stale 值）
    month_data_days,               // 本月有数据的天数
    total_profit_cents,            // manual_total_profit 优先，否则累计求和
    total_profit_source,           // 'manual' | 'sum'
    last_profit: { profit_date, amount_cents, source } | null,
    stale: boolean,                // 最新数据 source === 'stale' 或 profit_date < today-1
    redeem_date,
    days_to_redeem: number | null, // 距今天数，正数=未到期
  }],
  totals: { holding_cents, month_profit_cents, total_profit_cents },
  missing_product_count,           // 本月无任何记录的产品数
  missing_products: [ { id, product_name, reason } ],
  expiring: [ { id, product_name, redeem_date, days_left } ]  // 0 <= days_left <= 7，含已到期(负数?)只列 0..7
}
```

### 5.2 `lib/profit.js`（降级链，核心）

```js
export async function resolveDailyProfit({ product, profitDate, config, fetchImpl = fetch, signal })
// -> { status: 'ok'|'unavailable'|'missing_manual', profit: { amount_cents, source, nav_date, detail }|null,
//      reason: string|null, attempts: [{ source, ok, reason }] }
export async function refreshDailyProfits(db, { profitDate, config, fetchImpl = fetch, signal })
// -> { profit_date, updated: [{ product_id, amount_cents, source }], missing: [{ product_id, product_name, reason }],
//      alerts: [{ level, message }], all_failed: boolean }
```

降级链（严格按序，逐条记录 attempts）：

1. `manual_daily_profit_cents != null` → `source: 'manual'`，`nav_date = profitDate`。
2. `product_type === 'fund'` 且 `config.fundApiEnabled` → `fetchFundSnapshot(identifier)`：
   - 有 `shares != null` 且 `prevUnitNav` 与 `unitNav`：`profit = round(shares × (unitNav − prevUnitNav) × 100)` 分，`source: 'api'`，`nav_date = navDate`。
   - 只有涨跌幅 `changePct`（无 nav 差/无 shares）：`profit = round(holding_amount_cents × changePct / 100)`，`source: 'estimated'`。
   - 注意：**只取"昨日/最近交易日"的真实净值差**，不要拿估算涨跌幅当官方收益；estimated 必须标出来。
3. `product_type === 'bank_wealth'` 且 `config.bankApiEnabled` → `fetchBankSnapshot(identifier)`；当前实现必然返回 `not_covered`（无免费源），不允许硬爬网页。
4. 全部失败 → 若 `getLatestProfit` 有历史值：`source: 'stale'`，保留上次金额，`detail` 写明 "沿用 YYYY-MM-DD 数据，非实时"。若无历史值 → `status:'unavailable'`，`profit: null`，不落库，计入 `missing`。
5. 任何情况下**不得**用「年化收益率 ÷ 365」推算。

`refreshDailyProfits` 应为写操作：逐产品 `resolveDailyProfit` → `recordDailyProfit`（stale 也落库，但 detail 说明），
全失败时返回一条 alert（`{ level: 'warning', message: '理财数据源暂不可用：…' }`），由 C 的 jobs 写入 `alerts` 表。

### 5.3 `lib/sources/fund.js`

```js
export async function fetchFundSnapshot(identifier, { timeoutMs = 8000, fetchImpl = fetch, signal } = {})
// -> { ok:true, data: { code, name, navDate, unitNav, prevNavDate, prevUnitNav, changePct,
//                       estNav, estChangePct, estTime } }
//  | { ok:false, reason: 'timeout'|'network'|'http_404'|'not_found'|'parse_error'|'invalid_identifier', detail }
export function parsePingzhongData(text, code)   // 纯函数：东财 pingzhongdata/*.js（实测可用，764KB，含 Data_netWorthTrend）
export function parseFundGz(text)                // 纯函数：fundgz jsonp（如接口可用）
```

数据源实测结论（2026-11-05）：
- `https://fundgz.1234567.com.cn/js/<code>.js?rt=1` 对 000001 返回的是 HTTP 200 的**HTML 404 页**（不是 jsonp）→ 必须校验 `jsonpgz(` 前缀，否则视为 `not_found`。
- `http://fund.eastmoney.com/pingzhongdata/<code>.js` 可用，返回 `var fS_name = "华夏成长混合"; var fS_code = "000001"; ... var Data_netWorthTrend = [{x:1262620800000,y:1.14,...}, ...]`（x 为毫秒时间戳，y 为单位净值）。**这是主源**。
- 备选：`https://api.fund.eastmoney.com/f10/lsjz?fundCode=<code>&pageIndex=1&pageSize=10`（需要 `Referer: http://fundf10.eastmoney.com/`）。
- 解析要防御：字段缺失返回 `parse_error`；基金代码校验 `^\d{6}$`。

### 5.4 `lib/sources/bank.js`

```js
export const BANK_COVERAGE = {}   // 已知覆盖：空。明确 "no free source"
export async function fetchBankSnapshot(identifier, { timeoutMs, signal } = {})
// -> 恒为 { ok:false, reason:'not_covered', detail:'银行理财暂无可用免费数据源（psbcwm-mcp 需本地服务）' }
```

## 6. C 模块：OCR / jobs / 安装脚本（C-运维 负责）

### 6.1 `lib/ocr.js`

```js
export async function detectOcrProvider(config)   // -> { provider: 'rapidocr'|'command'|null, detail }
export async function ocrReceiptImage(imagePath, { config, timeoutMs = 30000, signal })
// -> { ok:true, text, provider } | { ok:false, code:'no_ocr_provider'|'not_found'|'ocr_failed', message, hint? }
export function parseReceiptText(text, { today })
// -> { drafts: [{ type, amount, category, merchant, date, note, source:'ocr', warnings: [] }], raw_text }
```

- 实测本机 **没有** 任何 OCR 依赖（`rapidocr_onnxruntime`/`paddleocr`/`cnocr`/`easyocr` 均未安装；`PIL` 有）。
  → 方案：`scripts/setup-ocr.ps1` 在 `.venv-ocr/` 里 `pip install rapidocr_onnxruntime`；
  `config.ocrVenvPython` 指向该 venv 的 python，`config.ocrCommand` 允许用户自定义 CLI（stdout 出文本）。
- `detectOcrProvider` 顺序：`config.ocrCommand`（存在则 'command'）→ `config.ocrVenvPython` 可执行且能 `import rapidocr_onnxruntime`（'rapidocr'）→ null。
- 识别失败/未安装时返回 `no_ocr_provider` + 安装提示，**不要抛异常**；工具层提示用户改用文字输入或先跑安装脚本。
- **只提取明确可见字段**：金额、日期解析不出就是 `null`，`warnings` 里说明「未能识别金额/日期」。多商品小票只取总金额（`合计/实付/总计` 优先）。
- 记账工具（A 的 `ledger_add_entry`）负责最终确认与落库；OCR 工具只产出 draft，不写库。

### 6.2 `lib/jobs.js`

```js
export const JOB = { daily: 'daily_profit', monthly: 'month_end_report' }
export function jobKey(kind, dateOrMonth)         // 'daily_profit:2026-10-31'
export async function runDailyProfitJob({ db, config, profitDate, today })   // 幂等：job_runs 有成功记录则 skipped
// -> { skipped: boolean, profit_date, updated_count, missing_count, alerts: [...] }
export async function runMonthEndJob({ db, config, month, today, report })   // report = buildMonthlyReport 结果
// 幂等：monthly_reports 已有该月 或 job_runs 成功 -> skipped；写入 monthly_reports + job_runs
// -> { skipped, month, report? }
export function setupSchedules(ctx, { db, config, sessionId })   // 需要 ctx.schedule
// 创建/复用两个 schedule：每日 config.dailyJobCron；月末用 "0 21 28-31 * *"（每日跑，靠 isMonthEnd 判定）
// -> { created: [ids], reused: [ids], prompts: { daily, monthly } }
export function schedulePrompts(config)            // 纯函数，返回两段自包含 prompt 文本（供 schedule.create）
```

prompt 必须自包含（定时任务唤起的是新 turn）：写明「调用 `finance_run_daily_job` 工具，然后简要汇报」等。
若 `ctx.schedule` 不存在 → throw `fail('schedule_unavailable', ...)`，工具层提示用户。

### 6.3 脚本与文档

- `scripts/install.ps1`：把 `packages/dsh-ledger-wealth` 以 `link:` 方式装进指定 profile
  （默认 desktop）：`dsh plugin --profile <p> add link:<abs>`，失败时打印手工步骤；打印重启提示。
- `scripts/setup-ocr.ps1`：建 `.venv-ocr`、`pip install rapidocr_onnxruntime`、自检 import、打印配置片段。
- `scripts/smoke.ps1`：跑 `node --test` 全量测试 + 打印安装提示。
- `README.md`：安装、配置（`cordis.patch.yml` 片段）、工具清单、报告示例、降级链说明、隐私（全本地 SQLite）。

## 7. 工具目录（名字固定，避免冲突）

| 工具名 | 参数（DSL） | 返回 | 负责人 |
| --- | --- | --- | --- |
| `ledger_set_initial_balance` | `amount:number!`, `overwrite:boolean?` | `{ ok, initial_balance_cents, initial_balance, set_at }` | A |
| `ledger_add_entry` | `type:string!`, `amount:number!`, `category:string!`, `merchant:string?`, `date:string?`, `note:string?`, `source:string?`, `confirm:boolean?` | 预览：`{ ok, status:'needs_confirmation', draft, message, text }`；落库：`{ ok, status:'recorded', entry, balances, month }` | A |
| `ledger_list_entries` | `month:string?`, `type:string?`, `limit:integer?` | `{ ok, entries, total }` | A |
| `ledger_delete_entry` | `id:string!`, `confirm:boolean?` | `{ ok, status, deleted }` | A |
| `ledger_balance` | — | `{ ok, balances }` 或 `{ ok:false, code:'need_initial_balance' }` | A |
| `ledger_month_summary` | `month:string?` | `{ ok, summary }` | A |
| `wealth_add_product` | `product_name:string!`, `product_type:string!`, `identifier:string!`, `holding_amount:number!`, `shares:number?`, `cost_nav:number?`, `manual_daily_profit:number?`, `manual_total_profit:number?`, `buy_date:string?`, `redeem_date:string?`, `confirm:boolean?` | `{ ok, status, product }` | B |
| `wealth_update_product` | `id:string!`, + 可改字段，`confirm:boolean?` | `{ ok, status, product }` | B |
| `wealth_list_products` | `include_archived:boolean?` | `{ ok, products }` | B |
| `wealth_record_profit` | `product_id:string!`, `profit_date:string?`, `amount:number!`, `confirm:boolean?` | `{ ok, status, profit }` | B |
| `wealth_refresh_profit` | `profit_date:string?`, `product_id:string?` | `{ ok, result }`（降级链执行） | B |
| `wealth_summary` | `month:string?` | `{ ok, summary }` | B |
| `ledger_scan_receipt` | `image_path:string!` | `{ ok, drafts, raw_text }` 或 `{ ok:false, code:'no_ocr_provider', hint }` | C |
| `finance_run_daily_job` | `date:string?` | `{ ok, result }` | C |
| `finance_run_month_end_job` | `month:string?` | `{ ok, result, report? }` | C |
| `finance_setup_schedules` | —（用 `exec.agent.session.id`） | `{ ok, created, reused }` | C |
| `finance_schedule_status` | — | `{ ok, schedules, last_runs }` | C |
| `finance_monthly_report` | `month:string?` | `{ ok, report }`（`report.rendered` 为完整两节文本） | Lead |
| `finance_alerts` | `include_resolved:boolean?` | `{ ok, alerts }` | Lead |

工具输出约定：
- 成功：`{ ok: true, ...业务字段, text?: string }`，`text` 是给用户看的中文摘要（可多行）。
- 失败：`{ ok: false, code, message }`（由 `toToolError` 生成，**不要 throw**）。
- 金额对外统一元（number，两位）+ 附 `*_cents` 便于精确；
- 每个工具必须用 `lib/toolkit.js` 的 `registerJsonTool` 注册（Lead 提供，勿自己写 defineTool 包装）。

错误码表（`CODES`）：`need_initial_balance` `already_initialized` `invalid_amount` `invalid_type`
`invalid_category` `invalid_date` `invalid_source` `invalid_month` `invalid_argument`
`confirmation_required` `entry_not_found` `product_not_found` `duplicate_product`
`source_unavailable` `no_ocr_provider` `schedule_unavailable` `internal_error`。

## 8. 报告契约（Lead 实现 `lib/report.js`，C 的月末 job 调用）

```js
export function buildMonthlyReport(db, { month, timeZone = 'Asia/Shanghai', today })
// -> { month, generated_at, ledger: MonthSummary, previous_ledger: MonthSummary|null,
//      comparison: { expense_delta_cents, income_delta_cents, net_delta_cents }|null,
//      wealth: WealthSummary, ledger_text, wealth_text, rendered }
```

`rendered` 固定骨架（顺序、标题、分隔线不可改）：

```
# 2026-10 月度报告
> 生成时间：… ｜ 记账与理财分属两个模块，金额互不合并计算

## 一、记账部分（日常收支）
本月支出合计：¥X（N 笔）  本月收入合计：¥Y（M 笔）  本月净结余：¥Z
支出分类占比（前 5 类）：
| 分类 | 金额 | 占比 |
最大单笔支出：…
与上月对比：支出 ↑/↓ ¥…（上月 ¥…）

------------------------------------------------------------

## 二、理财部分（与日常记账分开）
持仓总金额：¥…  持仓总收益：¥…（来源：manual/sum）  本月收益合计：¥…（仅统计 N 个有数据产品，缺失 M 个）
各产品明细表格（产品 / 持仓 / 本月收益 / 累计收益 / 数据来源 / 更新时间）
数据源说明：…（缺失产品列表/「数据源暂不可用，使用上次更新值」）
到期提醒（7 天内）：…

> 以上「日常收支」与「理财收益」为两个独立账本，不得相加。
```

## 9. 测试契约

- 统一 `node --test`（Node 24 内置），文件 `tests/<name>.test.js`（放在**插件包内**：
  `packages/dsh-ledger-wealth/tests/`），用 `import { test } from 'node:test'` + `assert`。
- 每个测试自建 `openDb(':memory:')`，**不写用户真实数据库、不联网**（network 相关的纯解析函数用固定字符串测）。
- 需要固定"今天"时显式传 `today: '2026-10-31'` 之类参数，不依赖系统时钟。
- 至少覆盖：正常路径、校验失败路径（错误码断言）、幂等路径（重复调用不重复写）、金额隔离断言。
- 跑测：`cd 'D:\DSH_WorkPlace\记账理财插件' && node --test packages/dsh-ledger-wealth/tests/`
  （根 `node_modules` 有 `@deepseek-ai/dsh-tools`，插件包通过根 node_modules 解析 peer）。

## 10. 交付标准（Definition of Done）

1. `node --check` 全绿、`node --test` 全绿（每个 teammate 提交前自跑自己的测试文件）。
2. 无 `console.log` 调试残留；无 TODO 占位（未实现要 throw 明确错误码）。
3. 所有金额字段以 `_cents` 落库、以元出参；所有对外文案中文、分节、可追溯来源。
4. 在 `docs/INTERFACES.md` 登记的任何签名改动，必须同时通知 Lead。
