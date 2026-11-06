<!--
提 PR 时用这份正文。GitHub 会自动填入 .github/pull_request_template.md 的 6 个 checkbox，
整份替换成下面这段也可以（已含全部勾选项）。
标题：Add ainachoneko/dsh-ledger-wealth
-->

- [x] I added **one file** at `data/plugins/ainachoneko__dsh-ledger-wealth.yml` — that single file is the whole submission. The READMEs are regenerated on `main` after merge; I did not touch them.
- [x] My repo's `package.json` declares **`dsh.bundle`** (`dsh.bundle.patch: ./cordis.patch.yml`). There is no browser half, so no `dsh.client`.
- [x] My repo is at least **1 day old** — created `2026-11-05T14:22:37Z`.
- [x] `category: tools` — the plugin ships 20 agent tools (7 `ledger_*`, 7 `finance_*`, 6 `wealth_*`).
- [x] Description states what the plugin does, no superlatives.
- [x] My repo has the `dsh-plugin` topic.

---

Local-first bookkeeping plugin with a separate wealth-holdings ledger.

- **20 agent tools**: 7 `ledger_*` (initial balance, add/list/delete entry, receipt OCR, month summary,
  balance), 7 `finance_*` (daily and month-end jobs, schedule setup/status, alerts, month-end report,
  status), 6 `wealth_*` (add/update/list products, record/refresh profit, summary)
- **Installable as declared**: `dsh.bundle.patch` points at `cordis.patch.yml`, which inserts one row
  (`id: ledger-wealth`, `name: dsh-ledger-wealth`). `lib/` is committed source, so there is no build step
  and no `prepare` / `postinstall` hook. Zero runtime dependencies — storage is Node's built-in `node:sqlite`.
- **The two ledgers never mix**: cash entries and wealth holdings live in separate tables, and there is no
  view or join that adds one total to the other. The month-end report renders them as two sections; a test
  asserts that a merged figure appears in neither the text nor the HTML output.
- **No fabricated returns**: daily profit resolves through a strict chain (manual → fund NAV → estimated
  from daily change → bank not covered → carried forward and labelled → unavailable), every number carries
  its source label, and annualized-rate ÷ 365 is blocked in code and by a source-scanning test.
- **Two-step writes**: every mutation (new entry, edit, delete, reconcile adjustment, product change)
  produces a draft that must be confirmed before it reaches the database.
- **Tests**: 83 passing via `node tests/run.mjs`; a GitHub Actions workflow runs module import check,
  the test suite and a packaging dry run on every push.

Repo: https://github.com/ainachoneko/dsh-ledger-wealth
