// 重写器测试：角色 / 去重 / 数量上限 / 超大跳过 / 失败回退 / 跨请求复用
const assert = require('node:assert')
const { FileStore, MemoryBackend, transformToFiles } = require('../lib/index.js')

function dataUrl(bytes) {
  return 'data:image/png;base64,' + Buffer.alloc(bytes, 9).toString('base64')
}

function makeUploader() {
  const calls = []
  return {
    calls,
    async upload(buffer, mime, filename) {
      calls.push({ size: buffer.length, mime, filename })
      return { id: `file-api-${calls.length}`, bytes: buffer.length }
    },
  }
}

function makeOptions(uploader, store, extra = {}) {
  return {
    roles: ['user', 'tool'],
    minBytes: 0,
    maxBytes: 64 * 1024 * 1024,
    maxPerRequest: 8,
    concurrency: 2,
    uploader,
    store,
    accountKey: 'acc',
    ...extra,
  }
}

function body(messages) {
  return { model: 'deepseek-flash', messages }
}

;(async () => {
  // 1) 角色：user/tool 改写，assistant 保留
  {
    const uploader = makeUploader()
    const store = new FileStore(new MemoryBackend())
    const data = body([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl(100) } }] },
      { role: 'tool', content: [{ type: 'image_url', image_url: { url: dataUrl(200) } }] },
      { role: 'assistant', content: [{ type: 'image_url', image_url: { url: dataUrl(300) } }] },
    ])
    const result = await transformToFiles(data, makeOptions(uploader, store))
    assert.strictEqual(result.rewritten, 2)
    assert.strictEqual(data.messages[0].content[0].type, 'file')
    assert.strictEqual(data.messages[1].content[0].type, 'file')
    assert.strictEqual(data.messages[2].content[0].type, 'image_url')
    console.log('case1 roles OK')
  }

  // 2) 同图去重：两张相同图片只上传一次
  {
    const uploader = makeUploader()
    const store = new FileStore(new MemoryBackend())
    const url = dataUrl(512)
    const data = body([
      { role: 'user', content: [{ type: 'image_url', image_url: { url } }] },
      { role: 'user', content: [{ type: 'image_url', image_url: { url } }] },
    ])
    const result = await transformToFiles(data, makeOptions(uploader, store))
    assert.strictEqual(result.rewritten, 2)
    assert.strictEqual(uploader.calls.length, 1)
    assert.strictEqual(data.messages[0].content[0].file_id, data.messages[1].content[0].file_id)
    console.log('case2 dedupe OK')
  }

  // 3) 数量上限
  {
    const uploader = makeUploader()
    const store = new FileStore(new MemoryBackend())
    const data = body([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl(10) } }, { type: 'image_url', image_url: { url: dataUrl(11) } }] },
    ])
    const result = await transformToFiles(data, makeOptions(uploader, store, { maxPerRequest: 1 }))
    assert.strictEqual(result.rewritten, 1)
    assert.strictEqual(data.messages[0].content[1].type, 'image_url')
    console.log('case3 maxPerRequest OK')
  }

  // 4) 超过单图上限：跳过并保留
  {
    const uploader = makeUploader()
    const store = new FileStore(new MemoryBackend())
    const data = body([{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl(100) } }] }])
    const result = await transformToFiles(data, makeOptions(uploader, store, { maxBytes: 10 }))
    assert.strictEqual(result.rewritten, 0)
    assert.strictEqual(result.skipped, 1)
    assert.strictEqual(data.messages[0].content[0].type, 'image_url')
    console.log('case4 oversize OK')
  }

  // 5) 上传失败：保留 base64，failed 计数
  {
    const uploader = { async upload() { throw new Error('boom') } }
    const store = new FileStore(new MemoryBackend())
    const data = body([{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl(100) } }] }])
    const result = await transformToFiles(data, makeOptions(uploader, store))
    assert.strictEqual(result.rewritten, 0)
    assert.strictEqual(result.failed, 1)
    assert.strictEqual(data.messages[0].content[0].type, 'image_url')
    console.log('case5 upload failure fallback OK')
  }

  // 6) 跨请求复用：第二次不再上传
  {
    const uploader = makeUploader()
    const store = new FileStore(new MemoryBackend())
    const url = dataUrl(256)
    const first = body([{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }])
    await transformToFiles(first, makeOptions(uploader, store))
    assert.strictEqual(uploader.calls.length, 1)
    const second = body([{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }])
    const result = await transformToFiles(second, makeOptions(uploader, store))
    assert.strictEqual(uploader.calls.length, 1, '第二次不应重复上传')
    assert.strictEqual(result.reused, 1)
    assert.strictEqual(second.messages[0].content[0].type, 'file')
    console.log('case6 cross-request reuse OK')
  }

  // 7) 非 data URL（外链）不动
  {
    const uploader = makeUploader()
    const store = new FileStore(new MemoryBackend())
    const data = body([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.jpg' } }] }])
    const result = await transformToFiles(data, makeOptions(uploader, store))
    assert.strictEqual(result.rewritten, 0)
    assert.strictEqual(uploader.calls.length, 0)
    console.log('case7 non-data url untouched OK')
  }

  console.log('OK: 重写器测试全部通过')
})().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})