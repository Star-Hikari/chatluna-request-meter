/**
 * DeepSeek Files API 上传客户端。
 *
 * 只在 ModelRequester.post 阶段使用：拿到 requester 的 fetch/key/endpoint 后，
 * 把 base64 图片上传成 file_id。不依赖 ChatLuna 内部实现，也不需要改 node_modules。
 */

export interface FilesUploadResult {
  id: string
  bytes?: number
  expiresAt?: number
}

export class FilesUploadError extends Error {
  status: number
  retryable: boolean

  constructor(status: number, message: string, retryable = false) {
    super(message)
    this.name = 'FilesUploadError'
    this.status = status
    this.retryable = retryable
  }
}

export interface FilesUploaderOptions {
  /** 通常是 requester._plugin.fetch */
  fetchImpl: (url: string, init?: any) => Promise<any>
  apiKey: string
  /** requester.concatUrl('files')，例如 https://api.deepseek.com/v1/files */
  filesUrl: string
  /** 0 = 永久（不传 expires_after） */
  ttlSeconds: number
  timeoutMs?: number
  maxRetries?: number
}

const resolvedUrlCache = new Map<string, string>()

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function originFilesUrl(filesUrl: string): string | null {
  try {
    const url = new URL(filesUrl)
    const origin = `${url.origin}/files`
    return origin === filesUrl ? null : origin
  } catch {
    return null
  }
}

function extOf(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/png':
      return 'png'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    default:
      return 'bin'
  }
}

async function safeText(response: any): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

async function safeJson(response: any): Promise<any> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export class FilesUploader {
  private filesUrl: string
  private candidates: string[]
  private timeoutMs: number
  private maxRetries: number

  constructor(private options: FilesUploaderOptions) {
    this.filesUrl = options.filesUrl
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.maxRetries = options.maxRetries ?? 2
    const cached = resolvedUrlCache.get(this.filesUrl)
    const list = cached ? [cached] : [this.filesUrl]
    const origin = originFilesUrl(this.filesUrl)
    if (origin && !list.includes(origin)) list.push(origin)
    this.candidates = list
  }

  private buildForm(buffer: Buffer, mime: string, filename: string): any {
    const FormDataCtor = (globalThis as any).FormData
    const BlobCtor = (globalThis as any).Blob
    if (typeof FormDataCtor !== 'function' || typeof BlobCtor !== 'function') {
      throw new FilesUploadError(-1, '当前运行环境不支持 FormData/Blob，无法上传 Files API')
    }
    const form = new FormDataCtor()
    form.append('purpose', 'user_data')
    if (this.options.ttlSeconds > 0) {
      form.append('expires_after[anchor]', 'created_at')
      form.append('expires_after[seconds]', String(Math.min(2_592_000, Math.round(this.options.ttlSeconds))))
    }
    form.append('file', new BlobCtor([buffer], { type: mime }), filename)
    return form
  }

  private async postOnce(url: string, buffer: Buffer, mime: string, filename: string): Promise<any> {
    const signal = (globalThis as any).AbortSignal?.timeout?.(this.timeoutMs)
    return this.options.fetchImpl(url, {
      method: 'POST',
      // 不要手动设置 Content-Type，交给 FormData 生成 boundary
      headers: { Authorization: `Bearer ${this.options.apiKey}` },
      body: this.buildForm(buffer, mime, filename),
      signal,
    })
  }

  private async postWithRetry(url: string, buffer: Buffer, mime: string, filename: string): Promise<FilesUploadResult> {
    let lastError: any
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let response: any
      try {
        response = await this.postOnce(url, buffer, mime, filename)
      } catch (error: any) {
        lastError = error
        if (attempt < this.maxRetries) {
          await sleep(500 * (attempt + 1))
          continue
        }
        throw new FilesUploadError(-1, `上传请求失败：${error?.message ?? error}`, true)
      }

      if (response?.ok) {
        const json = await safeJson(response)
        const id = json?.id
        if (typeof id !== 'string' || !id.startsWith('file-api-')) {
          throw new FilesUploadError(-1, `上传响应异常：${JSON.stringify(json).slice(0, 200)}`)
        }
        return { id, bytes: json.bytes, expiresAt: json.expires_at }
      }

      const status = Number(response?.status ?? -1)
      const body = await safeText(response)
      if ((status === 429 || status >= 500) && attempt < this.maxRetries) {
        lastError = new FilesUploadError(status, body)
        await sleep(1000 * (attempt + 1))
        continue
      }
      throw new FilesUploadError(status, `上传失败：${status} ${body.slice(0, 200)}`, status === 429 || status >= 500)
    }
    throw lastError instanceof FilesUploadError
      ? lastError
      : new FilesUploadError(-1, '上传失败：重试耗尽', true)
  }

  /**
   * 上传一张图片。优先 `{endpoint}/files`，404 时回退到 `{origin}/files`。
   */
  async upload(buffer: Buffer, mime: string, filename?: string): Promise<FilesUploadResult> {
    const name = (filename && filename.length > 0 ? filename : `meter-${Date.now()}.${extOf(mime)}`).slice(0, 200)
    let lastError: any
    for (const url of this.candidates) {
      try {
        const result = await this.postWithRetry(url, buffer, mime, name)
        resolvedUrlCache.set(this.filesUrl, url)
        return result
      } catch (error) {
        lastError = error
        if (error instanceof FilesUploadError && error.status === 404) continue
        throw error
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new FilesUploadError(404, '上传失败：所有候选路径均 404', false)
  }
}