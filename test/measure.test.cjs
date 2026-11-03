// 冒烟测试：估算值 vs JSON.stringify 实际值
// 运行：node test/measure.test.cjs
const assert = require('node:assert')
const { estimateBody, summarize } = require('../lib/index.js')

function dataUrl(bytes) {
  const b64len = Math.floor(bytes / 3) * 4
  return 'data:image/jpeg;base64,' + 'A'.repeat(b64len)
}

function mkMessages(imageBytes, count) {
  const messages = []
  for (let i = 0; i < count; i++) {
    messages.push({
      role: 'human',
      name: '烛火',
      content: [
        { type: 'text', text: `第 ${i} 张图，含中文和 "引号" 与 \n 换行` },
        { type: 'image_url', image_url: { url: dataUrl(imageBytes), detail: 'low' } },
      ],
    })
    messages.push({
      role: 'ai',
      name: '可咪娜',
      content: '收到喵～',
      tool_calls: [{ id: `call_${i}`, name: 'qzone_post_detail', args: { index: i, images: 1 } }],
    })
  }
  return messages
}

const body = {
  model: 'deepseek-flash',
  stream: true,
  stream_options: { include_usage: true },
  temperature: 0.7,
  n: 1,
  messages: mkMessages(12 * 1024 * 1024, 3),
  tools: [{ type: 'function', function: { name: 'qzone_post_detail', description: 'x'.repeat(500) } }],
}

const actual = JSON.stringify(body).length
const est = estimateBody(body)
const err = Math.abs(est.bytes - actual) / actual * 100

console.log('估算:', est.bytes, '实际:', actual, '误差:', err.toFixed(3) + '%')
console.log('摘要:', summarize(est))
console.log('图片明细:', est.images.map((h) => `${h.role}#${h.index}:${(h.bytes / 1024 / 1024).toFixed(2)}MiB`).join(', '))

assert.ok(err < 0.5, `误差过大: ${err}%`)
assert.strictEqual(est.inlineImages, 3, '应识别出 3 张内联图')
assert.ok(est.inlineImageBytes > 40 * 1024 * 1024, '内联图体积应 > 40MiB')

// 外链应归类为 remote，不占内联体积
const remoteBody = {
  model: 'deepseek-flash',
  messages: [
    { role: 'human', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.jpg' } }] },
  ],
}
const remote = estimateBody(remoteBody)
assert.strictEqual(remote.remoteImages, 1)
assert.strictEqual(remote.inlineImages, 0)
assert.ok(remote.bytes < 1024, '外链请求体应很小')

// file_id 引用
const fileBody = {
  model: 'deepseek-flash',
  messages: [
    { role: 'human', content: [{ type: 'file', file_id: 'file-api-abcdefghijklmnop' }] },
  ],
}
const file = estimateBody(fileBody)
assert.strictEqual(file.fileRefs, 1)
assert.ok(file.bytes < 1024, 'file_id 请求体应很小')

// Responses API 的 input_image 也要识别
const responsesBody = {
  model: 'deepseek-flash',
  input: [
    { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'input_image', image_url: 'data:image/jpeg;base64,' + 'A'.repeat(3000) }] },
  ],
}
const resp = estimateBody(responsesBody)
assert.strictEqual(resp.inlineImages, 1, 'Responses input_image 应被识别')
assert.ok(resp.inlineImageBytes > 3000, 'Responses 图片体积应计入')

console.log('OK: 全部断言通过')