// 链路测试：模拟 ModelRequester.post，验证告警/拦截
// 运行：node test/meter.test.cjs
const assert = require('node:assert')
const { apply, getLastEstimate, getStats } = require('../lib/index.js')
// 先加载根模块，解开 chatluna 内部的循环依赖（真实 Koishi 运行时已加载）
require('koishi-plugin-chatluna')
const { ModelRequester } = require('koishi-plugin-chatluna/llm-core/platform/api')
const { ChatLunaErrorCode } = require('koishi-plugin-chatluna/utils/error')

function makeCtx(logs, storage) {
  const push = (level) => (...args) => logs.push([level, args.map(String).join(' ')])
  return {
    logger: () => ({ debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }),
    on: () => {},
    inject: (names, callback) => {
      if (storage && names.includes('chatluna_storage')) callback({ chatluna_storage: storage })
    },
  }
}

function makeRequester(calls) {
  const req = Object.create(ModelRequester.prototype)
  req._plugin = {
    fetch: async (url, init) => {
      calls.push({ url, body: init?.body })
      return { ok: true, text: async () => '' }
    },
  }
  req._configPool = { getConfig: () => ({ value: { apiKey: 'sk-test', apiEndpoint: 'https://example.invalid/v1' } }) }
  return req
}

function bodyWith(images, bytesEach) {
  const url = 'data:image/jpeg;base64,' + 'A'.repeat(Math.floor(bytesEach / 3) * 4)
  const messages = []
  for (let i = 0; i < images; i++) {
    messages.push({ role: 'human', content: [{ type: 'image_url', image_url: { url } }] })
    messages.push({ role: 'ai', content: 'ok' })
  }
  return { model: 'deepseek-flash', messages }
}

const MiB = 1024 * 1024

;(async () => {
  const logs = []
  const calls = []
  const ctx = makeCtx(logs)
  apply(ctx, {
    enabled: true, warnMiB: 24, errorMiB: 38, abortMiB: 45,
    abortEnabled: false, logEveryRequest: false, onlyChat: true,
    breakdownTop: 3, cooldownSeconds: 0,
  })

  const req = makeRequester(calls)

  // 1) 30MiB：应 warn，不拦截
  await req.post('chat/completions', bodyWith(2, 11 * MiB), {})
  assert.strictEqual(calls.length, 1, '应发出请求')
  assert.ok(logs.some(([l]) => l === 'warn'), '应产生 warn')
  assert.ok(!logs.some(([l]) => l === 'error'), '不应产生 error')
  console.log('case1 30MiB -> warn OK')

  // 2) 45MiB：应 error
  logs.length = 0
  await req.post('chat/completions', bodyWith(3, 12 * MiB), {})
  assert.ok(logs.some(([l]) => l === 'error'), '应产生 error')
  console.log('case2 48MiB -> error OK')

  // 3) 打开拦截后超限：应抛错且不调用 fetch
  logs.length = 0
  calls.length = 0
  apply(ctx, {
    enabled: true, warnMiB: 1, errorMiB: 2, abortMiB: 10,
    abortEnabled: true, logEveryRequest: false, onlyChat: true,
    breakdownTop: 3, cooldownSeconds: 0,
  })
  let thrown
  try {
    await req.post('chat/completions', bodyWith(1, 12 * MiB), {})
  } catch (e) {
    thrown = e
  }
  assert.ok(thrown, '超限应抛错')
  assert.strictEqual(thrown.errorCode, ChatLunaErrorCode.ABORTED, '错误码应为 ABORTED')
  assert.strictEqual(calls.length, 0, '拦截后不应发送请求')
  console.log('case3 abort -> blocked OK, code =', thrown.errorCode)

  // 4) 非 chat 请求在 onlyChat 下应被忽略
  logs.length = 0
  await req.post('embeddings', bodyWith(1, 30 * MiB), {})
  assert.ok(!logs.some(([l]) => l === 'warn' || l === 'error'), 'embeddings 不应告警')
  console.log('case4 embeddings ignored OK')

  // 5) offload：post 发出的 body 里是公网 URL
  logs.length = 0
  calls.length = 0
  const storage = {
    createTempFile: async (buffer, filename) => ({ url: 'https://cdn.example.com/' + filename }),
  }
  apply(makeCtx(logs, storage), {
    enabled: true, warnMiB: 1024, errorMiB: 1024, abortMiB: 1024,
    abortEnabled: false, logEveryRequest: false, onlyChat: true,
    breakdownTop: 3, cooldownSeconds: 0,
    imageUrlMode: 'offload', offloadMinKb: 0, offloadMaxPerRequest: 8,
    offloadTtlHours: 720, offloadPlatforms: ['deepseek'], offloadAllowLoopback: false,
  })
  await req.post('chat/completions', bodyWith(1, 100 * 1024), {})
  const sent = JSON.parse(calls[0].body)
  const sentUrl = sent.messages[0].content[0].image_url.url
  assert.ok(sentUrl.startsWith('https://cdn.example.com/'), '应替换为公网 URL')
  assert.ok(!calls[0].body.includes('data:image'), 'body 不应再含 base64')
  console.log('case5 offload -> body has URL OK')

  const last = getLastEstimate()
  const stats = getStats()
  assert.ok(last && last.bytes > 0)
  assert.ok(stats.requests >= 3)
  console.log('stats:', JSON.stringify(stats))
  console.log('OK: 链路测试全部通过')
})().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})