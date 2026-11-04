import { createHash } from 'node:crypto'

/**
 * 把请求体里的 base64 图片转存到公网存储，并替换成 http(s) URL。
 *
 * 为什么不在序列化前做：ChatLuna 的 shared-adapter 在 buildChatCompletionParams
 * 内部就把图片 URL 下载并转成了 base64，等请求到达 ModelRequester.post 时原始链接
 * 已经丢失。市场插件不能 patch node_modules，所以只能在 post 阶段把字节重新转存，
 * 换成 provider 可抓取的公网地址。
 */

export interface OffloadStorage {
  createTempFile(
    buffer: Buffer,
    filename: string,
    expireHours?: number,
    mimeType?: string,
  ): Promise<{ url?: string } | null | undefined>
}

export interface OffloadOptions {
  /** 小于该体积（字节）的图不折腾 */
  minBytes: number
  /** 单请求最多转存几张 */
  maxPerRequest: number
  /** 存储商返回的本机/内网地址是否允许（仅本地测试用） */
  allowLoopback: boolean
  /** 临时文件有效期（小时） */
  ttlHours: number
  /** 单图上限（provider 外链限制，默认 32MiB） */
  maxBytes: number
  /** 允许的平台关键字（按 model 名匹配） */
  platforms: string[]
}

export interface OffloadResult {
  offloaded: number
  skipped: number
  failed: number
  /** 存储返回了内网/本机地址而被跳过的数量 */
  privateSkipped: number
  savedBytes: number
}

const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
}

/** 判断 URL 是否为本机/内网地址（provider 通常抓不到） */
export function isPrivateUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return true
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true
  if (/^127\./.test(host)) return true
  if (/^10\./.test(host)) return true
  if (/^192\.168\./.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true
  if (/^169\.254\./.test(host)) return true
  if (/^fe80:/i.test(host)) return true
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true
  return false
}

function modelAllowed(model: unknown, platforms: string[]): boolean {
  if (platforms.length === 0) return true
  const name = String(model ?? '').toLowerCase()
  return platforms.some((platform) => name.includes(platform.toLowerCase()))
}

function imageUrlsOf(data: any): any[] {
  const list = Array.isArray(data?.messages)
    ? data.messages
    : Array.isArray(data?.input)
      ? data.input
      : []
  const parts: any[] = []
  for (const message of list) {
    if (!Array.isArray(message?.content)) continue
    for (const part of message.content) {
      if (
        part != null &&
        typeof part === 'object' &&
        (part.type === 'image_url' || part.type === 'input_image')
      ) {
        parts.push(part)
      }
    }
  }
  return parts
}

function readUrl(part: any): string | undefined {
  const raw = part?.image_url
  const url = typeof raw === 'string' ? raw : raw?.url
  return typeof url === 'string' ? url : undefined
}

function writeUrl(part: any, next: string) {
  if (typeof part.image_url === 'string') part.image_url = next
  else part.image_url.url = next
}

/**
 * 扫描 data 里的内联图片，转存后替换为公网 URL。
 * 任何一步失败都保留原 base64，不影响对话。
 */
export async function offloadImages(
  data: any,
  storage: OffloadStorage,
  options: OffloadOptions,
): Promise<OffloadResult> {
  const result: OffloadResult = { offloaded: 0, skipped: 0, failed: 0, privateSkipped: 0, savedBytes: 0 }
  if (!modelAllowed(data?.model, options.platforms)) return result

  const parts = imageUrlsOf(data)
  const cache = new Map<string, string>()

  for (const part of parts) {
    if (result.offloaded >= options.maxPerRequest) break
    const url = readUrl(part)
    if (url == null) continue
    const match = DATA_URL.exec(url)
    if (!match) continue

    const mime = match[1].toLowerCase()
    const base64 = match[2].replace(/\s+/g, '')
    const bytes = Math.floor((base64.length * 3) / 4)
    if (bytes < options.minBytes) {
      result.skipped++
      continue
    }
    if (bytes > options.maxBytes) {
      result.skipped++
      continue
    }

    const hash = createHash('sha256').update(base64).digest('hex')
    const cached = cache.get(hash)
    if (cached) {
      writeUrl(part, cached)
      result.offloaded++
      result.savedBytes += base64.length - cached.length
      continue
    }

    try {
      const buffer = Buffer.from(base64, 'base64')
      const ext = MIME_EXT[mime] ?? 'bin'
      const file = await storage.createTempFile(
        buffer,
        `meter-${hash.slice(0, 16)}.${ext}`,
        options.ttlHours,
        mime,
      )
      const next = file?.url
      if (!next || next.length > 8192) {
        result.skipped++
        continue
      }
      if (!options.allowLoopback && isPrivateUrl(next)) {
        result.privateSkipped++
        continue
      }
      cache.set(hash, next)
      writeUrl(part, next)
      result.offloaded++
      result.savedBytes += base64.length - next.length
    } catch {
      result.failed++
    }
  }

  return result
}