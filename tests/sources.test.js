/**
 * 数据源纯函数与失败映射测试（不联网）。
 *
 * 用固定字符串喂解析器：东财 pingzhongdata、天天基金 fundgz 的 404 页、
 * 历史净值 JSON；银行源恒为 not_covered。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BANK_COVERAGE, fetchBankSnapshot } from '../lib/sources/bank.js'
import { fetchFundSnapshot, parseFundGz, parsePingzhongData } from '../lib/sources/fund.js'

/** 两个交易日的真实净值。 */
const PINGZHONG = `
var fS_name = "华夏成长混合";
var fS_code = "000001";
var Data_netWorthTrend = [
  {x:${Date.UTC(2026, 9, 29, 1)},y:2.0,equityReturn:0.0},
  {x:${Date.UTC(2026, 9, 30, 1)},y:2.01,equityReturn:0.5}
];
`

describe('fund source parsing', () => {
  it('reads the last two NAV points from pingzhongdata', () => {
    const data = parsePingzhongData(PINGZHONG, '000001')
    assert.ok(data)
    assert.equal(data.name, '华夏成长混合')
    assert.equal(data.unitNav, 2.01)
    assert.equal(data.prevUnitNav, 2)
    assert.equal(data.navDate, '2026-10-30')
    assert.equal(data.prevNavDate, '2026-10-29')
    assert.equal(data.changePct, 0.5)
  })

  it('returns null instead of a half-parsed object', () => {
    assert.equal(parsePingzhongData('', '000001'), null)
    assert.equal(parsePingzhongData('<html>404</html>', '000001'), null)
    assert.equal(parsePingzhongData('var Data_netWorthTrend = [];', '000001'), null)
  })

  it('only accepts a real jsonpgz payload, never the HTML 404 page', () => {
    assert.equal(parseFundGz('<html><body>404</body></html>'), null)
    const payload = parseFundGz(
      'jsonpgz({"fundcode":"000001","name":"华夏成长混合","jzrq":"2026-10-30","dwjz":"2.0100","gsz":"2.0200","gszzl":"0.50"});',
    )
    assert.equal(payload.code, '000001')
    assert.equal(payload.unitNav, 2.01)
    assert.equal(payload.estNav, 2.02)
    assert.equal(payload.estChangePct, 0.5)
  })

  it('rejects a malformed fund code without touching the network', async () => {
    const snapshot = await fetchFundSnapshot('abc', { fetchImpl: async () => assert.fail('不应发请求') })
    assert.equal(snapshot.ok, false)
    assert.equal(snapshot.reason, 'invalid_identifier')
  })

  it('maps a throwing fetch to a network failure', async () => {
    const snapshot = await fetchFundSnapshot('000001', {
      timeoutMs: 1000,
      fetchImpl: async () => {
        throw new Error('boom')
      },
    })
    assert.equal(snapshot.ok, false)
    assert.equal(snapshot.reason, 'network')
  })

  it('uses the backup endpoint when the primary yields no NAV trend', async () => {
    const backup = JSON.stringify({
      Data: {
        LSJZList: [
          { FSRQ: '2026-10-29', DWJZ: '1.5000', JZZZL: '0.20' },
          { FSRQ: '2026-10-30', DWJZ: '1.5300', JZZZL: '2.00' },
        ],
      },
    })
    const calls = []
    const snapshot = await fetchFundSnapshot('000001', {
      timeoutMs: 1000,
      fetchImpl: async (url) => {
        calls.push(url)
        if (calls.length === 1) return { ok: true, status: 200, text: async () => '<html>blocked</html>' }
        return { ok: true, status: 200, text: async () => backup }
      },
    })
    assert.equal(snapshot.ok, true)
    assert.equal(snapshot.data.unitNav, 1.53)
    assert.equal(snapshot.data.prevUnitNav, 1.5)
    assert.ok(calls.length >= 2, '主源失败后必须尝试备选源')
  })
})

describe('bank source coverage', () => {
  it('declares no free coverage and always answers not_covered', async () => {
    assert.deepEqual(BANK_COVERAGE, {})
    const snapshot = await fetchBankSnapshot('CMB-2026-001')
    assert.equal(snapshot.ok, false)
    assert.equal(snapshot.reason, 'not_covered')
    assert.match(snapshot.detail, /暂无可用免费数据源/)
  })
})
