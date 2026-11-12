/**
 * 批量压缩 ChatLuna 会话。
 *
 * 内置的 `chatluna.compress` 一次只能压一个会话，且要经过 session 的 ACL/路由解析；
 * 这里在插件进程内直接调 `conversationRuntime.compressConversation`，按完整会话列表遍历。
 *
 * 设计要点：
 * - 顺序执行（同一平台会争 `withConversationAndPlatformLock`，并发没有收益）
 * - 压缩前显式检查 `lockConversation`，避免像内置指令那样直接报错
 * - 每个会话独立 try/catch，单个失败不影响其余
 * - `force = true`：跳过 token 阈值，无条件压缩（与内置 `chatluna.compress` 一致）
 */

export interface CompressConversationLike {
  id: string
  title?: string | null
  bindingKey?: string | null
  model?: string | null
  preset?: string | null
  status?: string | null
  lastChatAt?: Date | number | null
}

export interface CompressResultLike {
  compressed?: boolean
  inputTokens?: number
  outputTokens?: number
  reducedTokens?: number
  reducedPercent?: number
  originalMessageCount?: number
  remainingMessageCount?: number
}

export type CompressItemStatus = 'compressed' | 'unchanged' | 'locked' | 'failed'

export interface CompressItemResult {
  id: string
  title: string
  status: CompressItemStatus
  inputTokens: number
  outputTokens: number
  reducedTokens: number
  reducedPercent: number
  error?: string
}

export interface CompressAllDeps {
  list(includeArchived: boolean): Promise<CompressConversationLike[]>
  isLocked(conversation: CompressConversationLike): Promise<boolean>
  compress(conversation: CompressConversationLike, instruction?: string): Promise<CompressResultLike>
}

export interface CompressAllOptions {
  includeArchived: boolean
  instruction?: string
  onItem?: (item: CompressItemResult, index: number, total: number) => void
}

export interface CompressAllSummary {
  total: number
  compressed: number
  unchanged: number
  locked: number
  failed: number
  inputTokens: number
  outputTokens: number
  reducedTokens: number
  reducedPercent: number
}

function num(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function titleOf(conversation: CompressConversationLike): string {
  const title = (conversation.title ?? '').trim()
  return title.length > 0 ? title : conversation.id.slice(0, 8)
}

function timestampOf(conversation: CompressConversationLike): number {
  const value = conversation.lastChatAt
  if (value == null) return 0
  if (value instanceof Date) return value.getTime()
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
}

/** 顺序遍历并压缩；任何单条失败都不会中断整体 */
export async function compressAll(
  deps: CompressAllDeps,
  options: CompressAllOptions,
): Promise<CompressItemResult[]> {
  const conversations = [...(await deps.list(options.includeArchived))]
  conversations.sort((a, b) => timestampOf(b) - timestampOf(a))

  const results: CompressItemResult[] = []
  for (let index = 0; index < conversations.length; index++) {
    const conversation = conversations[index]
    const base: CompressItemResult = {
      id: conversation.id,
      title: titleOf(conversation),
      status: 'unchanged',
      inputTokens: 0,
      outputTokens: 0,
      reducedTokens: 0,
      reducedPercent: 0,
    }

    let item: CompressItemResult
    try {
      if (await deps.isLocked(conversation)) {
        item = { ...base, status: 'locked' }
      } else {
        const result = await deps.compress(conversation, options.instruction)
        const inputTokens = num(result?.inputTokens)
        const outputTokens = num(result?.outputTokens)
        const reducedTokens = num(result?.reducedTokens)
        item = {
          ...base,
          status: result?.compressed ? 'compressed' : 'unchanged',
          inputTokens,
          outputTokens,
          reducedTokens,
          reducedPercent: num(result?.reducedPercent),
        }
      }
    } catch (error: any) {
      item = {
        ...base,
        status: 'failed',
        error: String(error?.message ?? error).slice(0, 200),
      }
    }

    results.push(item)
    options.onItem?.(item, index, conversations.length)
  }

  return results
}

export function summarizeCompress(results: CompressItemResult[]): CompressAllSummary {
  const summary: CompressAllSummary = {
    total: results.length,
    compressed: 0,
    unchanged: 0,
    locked: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    reducedTokens: 0,
    reducedPercent: 0,
  }
  for (const item of results) {
    if (item.status === 'compressed') summary.compressed++
    else if (item.status === 'unchanged') summary.unchanged++
    else if (item.status === 'locked') summary.locked++
    else summary.failed++
    summary.inputTokens += item.inputTokens
    summary.outputTokens += item.outputTokens
    summary.reducedTokens += item.reducedTokens
  }
  if (summary.inputTokens > 0) {
    summary.reducedPercent = (summary.reducedTokens / summary.inputTokens) * 100
  }
  return summary
}

function formatNumber(value: number): string {
  return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 聊天窗口用：一句话概括，尽量短 */
export function formatChatSummary(results: CompressItemResult[]): string {
  const summary = summarizeCompress(results)
  if (summary.total === 0) return '没有找到可压缩的会话。'

  const parts = [`共 ${summary.total} 个会话`, `成功 ${summary.compressed}`]
  if (summary.unchanged > 0) parts.push(`无变化 ${summary.unchanged}`)
  if (summary.locked > 0) parts.push(`锁定 ${summary.locked}`)
  if (summary.failed > 0) parts.push(`失败 ${summary.failed}`)

  let text = `压缩完成：${parts.join('，')}`
  if (summary.reducedTokens > 0) {
    text += `；减少 ${formatNumber(summary.reducedTokens)} tokens（${summary.reducedPercent.toFixed(1)}%）`
  } else {
    text += '；token 无明显变化'
  }

  const failed = results.filter((item) => item.status === 'failed')
  if (failed.length > 0) {
    const names = failed.slice(0, 3).map((item) => item.title)
    text += `。失败：${names.join('、')}${failed.length > 3 ? ' 等' : ''}`
  }

  return text + '。'
}

/** 控制台用：逐条明细 + 汇总 */
export function formatConsoleLines(results: CompressItemResult[]): string[] {
  const summary = summarizeCompress(results)
  const lines: string[] = []
  for (const item of results) {
    const id = item.id.slice(0, 8)
    if (item.status === 'compressed') {
      lines.push(
        `✓ ${item.title} (${id}): ${formatNumber(item.inputTokens)} -> ${formatNumber(item.outputTokens)} tokens` +
          `（-${formatNumber(item.reducedTokens)}，${item.reducedPercent.toFixed(2)}%）`,
      )
    } else if (item.status === 'unchanged') {
      lines.push(`- ${item.title} (${id}): 已达标或无可压缩内容，跳过`)
    } else if (item.status === 'locked') {
      lines.push(`! ${item.title} (${id}): 会话已锁定，跳过`)
    } else {
      lines.push(`× ${item.title} (${id}): 失败 ${item.error ?? ''}`)
    }
  }
  lines.push(
    `合计 ${summary.total} 个会话：成功 ${summary.compressed}、无变化 ${summary.unchanged}、` +
      `锁定 ${summary.locked}、失败 ${summary.failed}；` +
      `${formatNumber(summary.inputTokens)} -> ${formatNumber(summary.outputTokens)} tokens` +
      `（-${formatNumber(summary.reducedTokens)}，${summary.reducedPercent.toFixed(2)}%）`,
  )
  return lines
}