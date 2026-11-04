// offload 单元测试：公网替换 / 内网跳过 / 平台白名单 / 数量上限
// 运行：node test/offload.test.cjs
const assert = require('node:assert')
const { offloadImages, isPrivateUrl } = require('../lib/index.js')

function dataUrl(bytes) {
  return 'data:image/jpeg;base64,' + Buffer.alloc(bytes, 7).toString('base64')
}

function body(urls, model = 'deepseek-flash') {
  return {
    model,
    messages: urls.map((url) => ({
      role: 'human',
      content: [{ type: 'image_url', image_url: { url } }],
    })),
  }
}

const publicStorage = {
  createTempFile: async (buffer, filename) => ({ url: 'https://cdn.example.com/' + filename }),
}
const privateStorage = {
  createTempFile: async (buffer, filename) => ({ url: 'http://127.0.0.1:5140/chatluna-storage/temp/' + filename }),
}

const options = {
  minBytes: 64 * 1024,
  maxPerRequest: 8,
  allowLoopback: false,
  ttlHours: 720,
  maxBytes: 32 * 1024 * 1024,
  platforms: ['deepseek'],
}

;(async () => {
  // 1) 公网存储：替换成 URL，请求体变小
  const b1 = body([dataUrl(100 * 1024)])
  const r1 = await offloadImages(b1, publicStorage, options)
  assert.strictEqual(r1.offloaded, 1)
  assert.ok(r1.savedBytes > 90 * 1024)
  assert.ok(b1.messages[0].content[0].image_url.url.startsWith('https://cdn.example.com/'))
  console.log('case1 public -> offloaded OK')

  // 2) 内网地址：跳过且保留 base64
  const b2 = body([dataUrl(100 * 1024)])
  const r2 = await offloadImages(b2, privateStorage, options)
  assert.strictEqual(r2.offloaded, 0)
  assert.strictEqual(r2.privateSkipped, 1)
  assert.ok(b2.messages[0].content[0].image_url.url.startsWith('data:image'))
  console.log('case2 private -> skipped OK')

  // 3) allowLoopback：允许本机地址（本地测试）
  const b3 = body([dataUrl(100 * 1024)])
  const r3 = await offloadImages(b3, privateStorage, { ...options, allowLoopback: true })
  assert.strictEqual(r3.offloaded, 1)
  console.log('case3 allowLoopback -> offloaded OK')

  // 4) 平台白名单：qwen 不处理
  const b4 = body([dataUrl(100 * 1024)], 'qwen/qwen3.8-flash')
  const r4 = await offloadImages(b4, publicStorage, options)
  assert.strictEqual(r4.offloaded, 0)
  console.log('case4 platform filter OK')

  // 5) 小于 minBytes：跳过
  const b5 = body([dataUrl(10 * 1024)])
  const r5 = await offloadImages(b5, publicStorage, options)
  assert.strictEqual(r5.offloaded, 0)
  assert.strictEqual(r5.skipped, 1)
  console.log('case5 small image skipped OK')

  // 6) maxPerRequest 上限
  const b6 = body([dataUrl(100 * 1024), dataUrl(100 * 1024), dataUrl(100 * 1024)])
  const r6 = await offloadImages(b6, publicStorage, { ...options, maxPerRequest: 2 })
  assert.strictEqual(r6.offloaded, 2)
  assert.ok(b6.messages[2].content[0].image_url.url.startsWith('data:image'))
  console.log('case6 maxPerRequest OK')

  // 7) 内网判定
  assert.ok(isPrivateUrl('http://127.0.0.1/x'))
  assert.ok(isPrivateUrl('http://192.168.1.5/x'))
  assert.ok(isPrivateUrl('http://localhost/x'))
  assert.ok(!isPrivateUrl('https://cdn.example.com/x'))
  console.log('case7 isPrivateUrl OK')

  console.log('OK: offload 全部断言通过')
})().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
