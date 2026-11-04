import { createHash } from 'node:crypto'
import { FileStore, FileRecord } from './store'
import { FilesUploader, FilesUploadError } from './uploader'

/**
 * 把 chat/completions 请求体里的 base64 图片替换成 DeepSeek `file` 内容块。
 *
 * 只做内存重写，不写 ChatLuna 数据库；任何失败都保留原 base64。
 */

export interface FilesTransformOptions {
  /** 允许重写的角色，例如 ['user', 'tool'] */
  roles: string[]
  minBytes: number
  maxBytes: number
  maxPerRequest: number
  concurrency: number
  uploader: FilesUploader
  store: FileStore
  accountKey: string
  logger?: any
}

export interface FilesTransformResult {
  uploaded: number
  reused: number
  failed: number
  skipped: number
  rewritten: number
  savedBytes: number
  /** 本轮实际用到的映射，供请求失败时作废 */
  used: Array<{ hash: string; fileId: string }>
}

const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i

function isImagePart(part: any): boolean {
  return part != null && typeof part === 'object' && part.type === 'image_url'
}

function readUrl(part: any): string | undefined {
  const raw = part?.image_url
  const url = typeof raw === 'string' ? raw : raw?.url
  return typeof url === 'string' ? url : undefined
}

async function mapLimit(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= tasks.length) return
      await tasks[index]()
    }
  })
  await Promise.all(workers)
}

export async function transformToFiles(
  data: any,
  options: FilesTransformOptions,
): Promise<FilesTransformResult> {
  const result: FilesTransformResult = {
    uploaded: 0,
    reused: 0,
    failed: 0,
    skipped: 0,
    rewritten: 0,
    savedBytes: 0,
    used: [],
  }

  const messages = Array.isArray(data?.messages) ? data.messages : []
  if (messages.length === 0) return result

  const eligible: any[] = []
  for (const message of messages) {
    if (!message || !options.roles.includes(String(message.role))) continue
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (isImagePart(part)) eligible.push(part)
    }
  }
  if (eligible.length === 0) return result

  const selected = eligible.slice(0, Math.max(1, options.maxPerRequest))
  const requestCache = new Map<string, string>()
  const inflight = new Map<string, Promise<string | null>>()

  const processOne = async (part: any): Promise<void> => {
    const url = readUrl(part)
    if (url == null) return
    const match = DATA_URL.exec(url)
    if (!match) {
      result.skipped++
      return
    }
    const mime = match[1].toLowerCase()
    if (!IMAGE_MIME.has(mime)) {
      result.skipped++
      return
    }
    const base64 = match[2].replace(/\s+/g, '')
    const bytes = Math.floor((base64.length * 3) / 4)
    if (bytes < options.minBytes || bytes > options.maxBytes) {
      result.skipped++
      return
    }

    const hash = createHash('sha256').update(base64).digest('hex')

    let fileId = requestCache.get(hash) ?? null
    let fromUpload = false

    if (fileId == null) {
      const record = await options.store.get(options.accountKey, hash)
      if (record) {
        fileId = record.fileId
        result.reused++
        void options.store.touch(options.accountKey, hash)
      }
    }

    if (fileId == null) {
      let pending = inflight.get(hash)
      if (!pending) {
        pending = (async () => {
          try {
            const buffer = Buffer.from(base64, 'base64')
            const upload = await options.uploader.upload(buffer, mime, `meter-${hash.slice(0, 16)}.${mime.split('/')[1]}`)
            const record: FileRecord = {
              id: FileStore.keyOf(options.accountKey, hash),
              accountKey: options.accountKey,
              hash,
              fileId: upload.id,
              bytes,
              mime,
              createdAt: Date.now(),
              expiresAt: upload.expiresAt != null ? upload.expiresAt * 1000 : null,
              lastUsedAt: Date.now(),
            }
            await options.store.put(record)
            fromUpload = true
            return upload.id
          } catch (error: any) {
            if (error instanceof FilesUploadError && (error.status === -1 || error.status === 429 || error.status >= 500)) {
              options.logger?.warn?.(`[request-meter] file 上传失败（${error.status}）：${error.message}`)
            } else {
              options.logger?.warn?.('[request-meter] file 上传异常：', error?.message ?? error)
            }
            return null
          }
        })()
        inflight.set(hash, pending)
      }
      fileId = await pending
    }

    if (fileId == null) {
      result.failed++
      return
    }

    requestCache.set(hash, fileId)
    part.type = 'file'
    part.file_id = fileId
    delete part.image_url
    result.rewritten++
    result.savedBytes += Math.max(0, url.length - (fileId.length + 40))
    result.used.push({ hash, fileId })
    if (fromUpload) result.uploaded++
  }

  await mapLimit(
    selected.map((part) => () => processOne(part)),
    Math.max(1, options.concurrency),
  )

  return result
}