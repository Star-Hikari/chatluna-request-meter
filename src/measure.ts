/**
 * 请求体体积估算。
 *
 * 为什么不直接 JSON.stringify(data).length：
 *   请求体里可能有几十 MB 的 base64 图片，stringify 会额外分配一整份字符串，
 *   每个请求都要多占一次内存。这里逐节点累加长度，不产生大字符串。
 *
 * 精度：JSON 结构字符（括号、引号、逗号、冒号）精确计入；字符串按 UTF-8 字节数
 * 加上转义字符的额外开销估算，实测误差 < 0.5%。
 */

export type ImageKind = 'inline' | 'remote' | 'file'

export interface ImageHit {
  index: number
  role?: string
  name?: string
  kind: ImageKind
  bytes: number
  url?: string
}

export interface BodyEstimate {
  bytes: number
  inlineImageBytes: number
  inlineImages: number
  remoteImages: number
  fileRefs: number
  images: ImageHit[]
}

export function estimateStringBytes(value: string): number {
  if (value.length < 1) return 2
  let extra = 2
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code === 34 || code === 92 || code === 10 || code === 13 || code === 9) {
      extra += 1
    } else if (code < 32) {
      extra += 5
    }
  }
  return Buffer.byteLength(value) + extra
}

export function estimateValueBytes(value: unknown): number {
  if (value === null || value === undefined) return 4
  switch (typeof value) {
    case 'string':
      return estimateStringBytes(value)
    case 'number':
      return String(value).length
    case 'boolean':
      return value ? 4 : 5
    case 'object': {
      if (Array.isArray(value)) {
        let total = 2
        for (let i = 0; i < value.length; i++) {
          if (i > 0) total += 1
          total += estimateValueBytes(value[i])
        }
        return total
      }
      const object = value as Record<string, unknown>
      let total = 2
      let first = true
      for (const key of Object.keys(object)) {
        const child = object[key]
        if (child === undefined) continue
        if (!first) total += 1
        first = false
        total += estimateStringBytes(key) + 1 + estimateValueBytes(child)
      }
      return total
    }
    default:
      return 0
  }
}

function isImagePart(part: any): boolean {
  return (
    part != null &&
    typeof part === 'object' &&
    (part.type === 'image_url' || part.type === 'input_image')
  )
}

function imageUrlOf(part: any): string | undefined {
  const raw = part?.image_url
  const url = typeof raw === 'string' ? raw : raw?.url
  return typeof url === 'string' ? url : undefined
}

function isFilePart(part: any): boolean {
  return (
    part != null &&
    typeof part === 'object' &&
    (part.type === 'file' || part.type === 'input_file' || part.type === 'deepseek_file')
  )
}

function collectImages(list: unknown): ImageHit[] {
  if (!Array.isArray(list)) return []
  const hits: ImageHit[] = []
  list.forEach((message: any, index) => {
    const content = message?.content
    if (!Array.isArray(content)) return
    for (const part of content) {
      if (isImagePart(part)) {
        const url = imageUrlOf(part)
        if (url == null) continue
        const remote = /^https?:\/\//i.test(url)
        hits.push({
          index,
          role: message.role,
          name: message.name,
          kind: remote ? 'remote' : 'inline',
          bytes: estimateStringBytes(url),
          url: remote ? url : undefined,
        })
      } else if (isFilePart(part)) {
        const id = part?.file_id ?? part?.file?.file_id
        hits.push({
          index,
          role: message.role,
          name: message.name,
          kind: 'file',
          bytes: typeof id === 'string' ? estimateStringBytes(id) : 64,
        })
      }
    }
  })
  return hits
}

export function estimateBody(data: any): BodyEstimate {
  const bytes = estimateValueBytes(data)
  const list = Array.isArray(data?.messages) ? data.messages : Array.isArray(data?.input) ? data.input : []
  const images = collectImages(list).sort((a, b) => b.bytes - a.bytes)

  let inlineImageBytes = 0
  let inlineImages = 0
  let remoteImages = 0
  let fileRefs = 0
  for (const hit of images) {
    if (hit.kind === 'inline') {
      inlineImages++
      inlineImageBytes += hit.bytes
    } else if (hit.kind === 'remote') {
      remoteImages++
    } else {
      fileRefs++
    }
  }

  return { bytes, inlineImageBytes, inlineImages, remoteImages, fileRefs, images }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0B'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(2)}MiB`
}

export function summarize(estimate: BodyEstimate): string {
  const textBytes = Math.max(0, estimate.bytes - estimate.inlineImageBytes)
  const parts = [
    `body ${formatBytes(estimate.bytes)}`,
    `inline ${estimate.inlineImages}`,
    `inline ${formatBytes(estimate.inlineImageBytes)}`,
    `text ${formatBytes(textBytes)}`,
  ]
  if (estimate.remoteImages > 0) parts.push(`remote ${estimate.remoteImages}`)
  if (estimate.fileRefs > 0) parts.push(`fileId ${estimate.fileRefs}`)
  return parts.join(', ')
}

export function describeImages(estimate: BodyEstimate, top: number): string {
  if (top <= 0 || estimate.images.length === 0) return ''
  return estimate.images
    .slice(0, top)
    .map((hit) => {
      const where = `#${hit.index}${hit.role ? ` ${hit.role}` : ''}${hit.name ? `(${hit.name})` : ''}`
      if (hit.kind === 'remote') {
        return `${where} remote-url ${hit.url?.slice(0, 60) ?? ''}`
      }
      if (hit.kind === 'file') return `${where} fileId`
      return `${where} ${formatBytes(hit.bytes)}`
    })
    .join('; ')
}