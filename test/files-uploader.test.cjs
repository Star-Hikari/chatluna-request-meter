// 上传器测试：multipart 字段 / 重试 / 路径回退 / 错误分类
const assert = require('node:assert')
const { FilesUploader } = require('../lib/index.js')

function response(status, body, jsonBody) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body ?? '')),
    json: async () => jsonBody ?? body,
  }
}

function makeFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init, calls.length)
  }
  return { fetchImpl, calls }
}

;(async () => {
  // 1) 成功：检查 multipart 字段
  const okFetch = makeFetch(() => response(200, null, { id: 'file-api-ok', bytes: 128 }))
  const uploader = new FilesUploader({
    fetchImpl: okFetch.fetchImpl,
    apiKey: 'sk-test',
    filesUrl: 'https://a.example/v1/files',
    ttlSeconds: 3600,
  })
  const result = await uploader.upload(Buffer.alloc(128, 1), 'image/png', 'x.png')
  assert.strictEqual(result.id, 'file-api-ok')
  const init = okFetch.calls[0].init
  assert.strictEqual(init.method, 'POST')
  assert.ok(!init.headers['Content-Type'], '不应手动设置 Content-Type')
  const form = init.body
  assert.strictEqual(form.get('purpose'), 'user_data')
  assert.strictEqual(form.get('expires_after[anchor]'), 'created_at')
  assert.strictEqual(form.get('expires_after[seconds]'), '3600')
  const file = form.get('file')
  assert.strictEqual(file.name, 'x.png')
  assert.strictEqual(file.type, 'image/png')
  assert.strictEqual(file.size, 128)
  console.log('case1 multipart fields OK')

  // 2) 503 重试一次后成功
  let attempt = 0
  const retryFetch = makeFetch(() => {
    attempt++
    return attempt === 1 ? response(503, 'busy') : response(200, null, { id: 'file-api-retry' })
  })
  const retryUploader = new FilesUploader({
    fetchImpl: retryFetch.fetchImpl,
    apiKey: 'sk-test',
    filesUrl: 'https://b.example/v1/files',
    ttlSeconds: 0,
  })
  const retried = await retryUploader.upload(Buffer.alloc(16, 2), 'image/jpeg', 'y.jpg')
  assert.strictEqual(retried.id, 'file-api-retry')
  assert.strictEqual(retryFetch.calls.length, 2)
  assert.ok(!retryFetch.calls[0].init.body.get('expires_after[seconds]'), 'ttl=0 不应带过期字段')
  console.log('case2 retry on 503 OK')

  // 3) 主路径 404 → 回退 origin/files
  const fallbackFetch = makeFetch((url) => {
    if (String(url).endsWith('/v1/files')) return response(404, 'not found')
    return response(200, null, { id: 'file-api-fallback' })
  })
  const fallbackUploader = new FilesUploader({
    fetchImpl: fallbackFetch.fetchImpl,
    apiKey: 'sk-test',
    filesUrl: 'https://c.example/v1/files',
    ttlSeconds: 60,
  })
  const fallback = await fallbackUploader.upload(Buffer.alloc(8, 3), 'image/webp', 'z.webp')
  assert.strictEqual(fallback.id, 'file-api-fallback')
  assert.ok(String(fallbackFetch.calls[0].url).endsWith('/v1/files'))
  assert.ok(String(fallbackFetch.calls[1].url).endsWith('/files'))
  assert.ok(!String(fallbackFetch.calls[1].url).includes('/v1/'))
  console.log('case3 404 fallback OK')

  // 4) 401 不重试
  const failFetch = makeFetch(() => response(401, 'unauthorized'))
  const failUploader = new FilesUploader({
    fetchImpl: failFetch.fetchImpl,
    apiKey: 'sk-bad',
    filesUrl: 'https://d.example/v1/files',
    ttlSeconds: 60,
  })
  let thrown
  try {
    await failUploader.upload(Buffer.alloc(8, 4), 'image/png', 'bad.png')
  } catch (e) {
    thrown = e
  }
  assert.ok(thrown, '401 应抛错')
  assert.strictEqual(thrown.status, 401)
  assert.strictEqual(failFetch.calls.length, 1, '401 不应重试')
  console.log('case4 401 no retry OK')

  // 5) 异常响应（缺 id）
  const badFetch = makeFetch(() => response(200, null, { foo: 'bar' }))
  const badUploader = new FilesUploader({
    fetchImpl: badFetch.fetchImpl,
    apiKey: 'sk-test',
    filesUrl: 'https://e.example/v1/files',
    ttlSeconds: 60,
  })
  let badError
  try {
    await badUploader.upload(Buffer.alloc(8, 5), 'image/png', 'bad2.png')
  } catch (e) {
    badError = e
  }
  assert.ok(badError && /响应异常/.test(badError.message))
  console.log('case5 invalid response OK')

  console.log('OK: 上传器测试全部通过')
})().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})