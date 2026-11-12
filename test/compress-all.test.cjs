// 批量压缩模块测试：顺序 / 锁 / 失败隔离 / 归档 / 摘要
const assert = require('node:assert')
const {
  compressAll,
  formatChatSummary,
  formatConsoleLines,
  summarizeCompress,
} = require('../lib/index.js')

function conv(id, title, lastChatAt = 0, status = 'active') {
  return { id, title, bindingKey: `personal:onebot:1:direct:${id}`, status, lastChatAt }
}

;(async () => {
  // 1) 顺序执行 + 混合结果
  {
    const order = []
    const conversations = [conv('a', 'A', 1000), conv('b', 'B', 2000), conv('c', 'C', 3000), conv('d', 'D', 4000)]
    const results = await compressAll(
      {
        list: async () => conversations,
        isLocked: async (c) => c.id === 'c',
        compress: async (c) => {
          order.push(c.id)
          if (c.id === 'b') throw new Error('boom')
          return { compressed: c.id === 'a', inputTokens: 1000, outputTokens: 250, reducedTokens: 750, reducedPercent: 75 }
        },
      },
      { includeArchived: false, onItem: () => {} },
    )
    assert.deepStrictEqual(order, ['d', 'b', 'a'], '应按 lastChatAt 倒序且顺序执行（锁定的 c 不进入 compress）')
    assert.strictEqual(results.length, 4)
    const byId = Object.fromEntries(results.map((r) => [r.id, r.status]))
    assert.strictEqual(byId.d, 'unchanged')
    assert.strictEqual(byId.c, 'locked')
    assert.strictEqual(byId.b, 'failed')
    assert.strictEqual(byId.a, 'compressed')
    console.log('case1 order/lock/failure OK')
  }

  // 2) includeArchived 透传
  {
    let received = null
    await compressAll(
      {
        list: async (withArchived) => {
          received = withArchived
          return []
        },
        isLocked: async () => false,
        compress: async () => ({ compressed: false }),
      },
      { includeArchived: true },
    )
    assert.strictEqual(received, true)
    console.log('case2 includeArchived OK')
  }

  // 3) instruction 透传
  {
    let got = null
    await compressAll(
      {
        list: async () => [conv('x', 'X')],
        isLocked: async () => false,
        compress: async (_c, instruction) => {
          got = instruction
          return { compressed: true, inputTokens: 10, outputTokens: 5, reducedTokens: 5, reducedPercent: 50 }
        },
      },
      { includeArchived: false, instruction: '保留人物关系' },
    )
    assert.strictEqual(got, '保留人物关系')
    console.log('case3 instruction OK')
  }

  // 4) 汇总与聊天摘要
  {
    const results = [
      { id: '1', title: '甲', status: 'compressed', inputTokens: 12000, outputTokens: 2000, reducedTokens: 10000, reducedPercent: 83.3 },
      { id: '2', title: '乙', status: 'unchanged', inputTokens: 0, outputTokens: 0, reducedTokens: 0, reducedPercent: 0 },
      { id: '3', title: '丙', status: 'locked', inputTokens: 0, outputTokens: 0, reducedTokens: 0, reducedPercent: 0 },
      { id: '4', title: '丁', status: 'failed', inputTokens: 0, outputTokens: 0, reducedTokens: 0, reducedPercent: 0, error: 'boom' },
    ]
    const summary = summarizeCompress(results)
    assert.strictEqual(summary.total, 4)
    assert.strictEqual(summary.compressed, 1)
    assert.strictEqual(summary.unchanged, 1)
    assert.strictEqual(summary.locked, 1)
    assert.strictEqual(summary.failed, 1)
    assert.strictEqual(summary.reducedTokens, 10000)

    const chat = formatChatSummary(results)
    assert.ok(chat.includes('共 4 个会话'), chat)
    assert.ok(chat.includes('成功 1'), chat)
    assert.ok(chat.includes('失败 1'), chat)
    assert.ok(chat.includes('10,000'), chat)
    assert.ok(chat.includes('丁'), chat)
    assert.ok(chat.length < 160, '聊天摘要应足够短: ' + chat.length)
    console.log('case4 summary OK:', chat)

    const lines = formatConsoleLines(results)
    assert.strictEqual(lines.length, 5, '应为 4 条明细 + 1 条合计')
    assert.ok(lines[4].includes('合计 4 个会话'))
    console.log('case4 console lines OK')
  }

  // 5) 空列表
  {
    const results = await compressAll(
      { list: async () => [], isLocked: async () => false, compress: async () => ({}) },
      { includeArchived: false },
    )
    assert.deepStrictEqual(results, [])
    assert.strictEqual(formatChatSummary(results), '没有找到可压缩的会话。')
    console.log('case5 empty OK')
  }

  console.log('OK: compress-all 测试全部通过')
})().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})