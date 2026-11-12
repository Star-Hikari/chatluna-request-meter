// 指令装配测试：authority / 选项 / action 行为
const assert = require('node:assert')
const { registerCompressAllCommand } = require('../lib/index.js')

function makeCommandApi() {
  const state = {}
  const chain = {
    option(name, desc) {
      state.options = { ...(state.options ?? {}), [name]: desc }
      return chain
    },
    usage(text) {
      state.usage = text
      return chain
    },
    action(fn) {
      state.action = fn
      return chain
    },
  }
  const api = (name, desc, config) => {
    state.name = name
    state.desc = desc
    state.config = config
    return chain
  }
  api.state = state
  return api
}

function makeCtx({ conversations, commandApi, compress, locked = [] }) {
  const logs = []
  const push = (level) => (...args) => logs.push([level, args.map(String).join(' ')])
  const logger = { info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') }
  const database = {
    get: async (table, query) => {
      assert.strictEqual(table, 'chatluna_conversation')
      if (query.status === 'active') return conversations.filter((c) => c.status === 'active')
      return conversations
    },
  }
  const chatluna = {
    conversationRuntime: { compressConversation: compress },
    conversation: {
      getManagedConstraintByBindingKey: async (bindingKey) => ({
        lockConversation: locked.includes(bindingKey),
      }),
    },
  }
  const ctx = {
    inject: (names, callback) => callback({ database, chatluna, command: commandApi }),
  }
  return { ctx, logs, logger }
}

;(async () => {
  const conversations = [
    { id: 'a', title: '甲', bindingKey: 'k-a', status: 'active', lastChatAt: 1000 },
    { id: 'b', title: '乙', bindingKey: 'k-b', status: 'active', lastChatAt: 2000 },
    { id: 'c', title: '丙', bindingKey: 'k-c', status: 'archived', lastChatAt: 3000 },
  ]
  const calls = []
  const commandApi = makeCommandApi()
  const { ctx, logs, logger } = makeCtx({
    conversations,
    commandApi,
    locked: ['k-b'],
    compress: async (conversation) => {
      calls.push(conversation.id)
      return { compressed: true, inputTokens: 100, outputTokens: 20, reducedTokens: 80, reducedPercent: 80 }
    },
  })

  registerCompressAllCommand(ctx, logger)

  // 指令元信息
  const state = commandApi.state
  assert.strictEqual(state.name, 'chatluna.compressall [instruction:text]')
  assert.strictEqual(state.config.authority, 3, '需要 authority 3')
  assert.ok(state.options.all, '应有 -a/--all 选项')
  assert.ok(typeof state.action === 'function')

  // 默认只压活跃会话
  const reply = await state.action({ options: {} })
  assert.deepStrictEqual(calls, ['a'], '只应压活跃且未锁定的会话')
  assert.ok(reply.includes('共 2 个会话'), reply)
  assert.ok(reply.includes('成功 1'), reply)
  assert.ok(reply.includes('锁定 1'), reply)
  assert.ok(logs.some(([level, text]) => level === 'info' && text.includes('合计')), '控制台应有合计行')

  // -a 包含归档
  calls.length = 0
  const reply2 = await state.action({ options: { all: true } })
  assert.deepStrictEqual(calls, ['c', 'a'], '含归档时应压 c 和 a，且按 lastChatAt 倒序')
  assert.ok(reply2.includes('共 3 个会话'), reply2)
  console.log('command authority/options/action OK')

  // 缺 conversationRuntime：返回可读错误
  const badCommandApi = makeCommandApi()
  const bad = makeCtx({
    conversations,
    commandApi: badCommandApi,
    compress: async () => ({}),
  })
  bad.ctx.inject = (names, callback) =>
    callback({ database: {}, chatluna: {}, command: badCommandApi })
  registerCompressAllCommand(bad.ctx, bad.logger)
  const badReply = await badCommandApi.state.action({ options: {} })
  assert.ok(badReply.includes('不支持批量压缩'), badReply)
  console.log('missing runtime guard OK')

  console.log('OK: 指令测试全部通过')
})().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})