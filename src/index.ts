import type { Context } from 'koishi'
import { Schema } from 'koishi'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { join, resolve } from 'node:path'
import {
  BodyEstimate,
  describeImages,
  estimateBody,
  formatBytes,
  summarize,
} from './measure'
import { offloadImages, OffloadStorage } from './offload'
import { compressAll, formatChatSummary, formatConsoleLines } from './compress-all'
import { FilesUploader } from './files/uploader'
import { DatabaseBackend, FileStore, MemoryBackend } from './files/store'
import { FilesTransformResult, transformToFiles } from './files/transform'

// 供测试/排查复用
export { describeImages, estimateBody, formatBytes, summarize } from './measure'
export { isPrivateUrl, offloadImages } from './offload'
export { FilesUploadError, FilesUploader } from './files/uploader'
export { DatabaseBackend, FileStore, MemoryBackend } from './files/store'
export { transformToFiles } from './files/transform'
export { compressAll, formatChatSummary, formatConsoleLines, summarizeCompress } from './compress-all'

export const name = 'chatluna-request-meter'

export const inject = {
  required: ['chatluna'],
  optional: ['chatluna_storage', 'database'],
}

const FILES_TABLE = 'chatluna_request_meter_file'

export interface Config {
  enabled: boolean
  warnMiB: number
  errorMiB: number
  abortMiB: number
  abortEnabled: boolean
  logEveryRequest: boolean
  onlyChat: boolean
  breakdownTop: number
  cooldownSeconds: number
  imageMode: 'inline' | 'offload' | 'files'
  offloadMinKb: number
  offloadMaxPerRequest: number
  offloadTtlHours: number
  offloadPlatforms: string[]
  offloadAllowLoopback: boolean
  filesTtlDays: number
  filesMaxPerRequest: number
  filesMinKb: number
  filesRoles: string[]
  filesPlatforms: string[]
  filesAccountScoped: boolean
  filesUploadConcurrency: number
  compressShowResults: boolean
  compressLogEnabled: boolean
  compressLogDir: string
}

export const Config = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(true).description('是否启用请求体体积观测。'),
  }).description('基础'),

  Schema.object({
    warnMiB: Schema.number()
      .min(1)
      .max(1024)
      .default(24)
      .description('超过该体积（MiB）记 warning。建议设为供应商上限的 50%。'),
    errorMiB: Schema.number()
      .min(1)
      .max(1024)
      .default(38)
      .description('超过该体积（MiB）记 error。建议设为上限的 80%。'),
    abortMiB: Schema.number()
      .min(1)
      .max(1024)
      .default(45)
      .description('超过该体积（MiB）时拦截请求的阈值，仅在“启用拦截”时生效。'),
    abortEnabled: Schema.boolean()
      .default(false)
      .description('是否在超过 abortMiB 时直接拦截请求，避免重试 18 次把同样的超大请求反复发出去。默认关闭，只记录。'),
    cooldownSeconds: Schema.number()
      .min(0)
      .max(600)
      .default(30)
      .description('同一级别告警的去重冷却时间（秒），避免重试风暴刷屏。'),
  }).description('体积告警'),

  Schema.object({
    onlyChat: Schema.boolean()
      .default(true)
      .description('只观测 chat/completions 与 responses 请求，忽略 embeddings/rerank。'),
    logEveryRequest: Schema.boolean()
      .default(false)
      .description('每次请求都打 debug 日志（排查时打开）。'),
    breakdownTop: Schema.number()
      .min(0)
      .max(10)
      .default(3)
      .description('日志里列出体积最大的前 N 张图片（0 = 不列）。'),
  }).description('观测范围与日志'),

  Schema.object({
    imageMode: Schema.union([
      Schema.const('inline').description('内联：图片继续以 base64 放在请求体里（默认，行为不变）。'),
      Schema.const('offload').description('转存：把 base64 图片上传到 chatluna_storage，请求体里只留公网 URL。'),
      Schema.const('files').description('Files API：把 base64 图片上传到 DeepSeek，请求体里只留 file_id。'),
    ])
      .default('inline')
      .description('图片发送模式。offload 需要 chatluna_storage 的公网地址；files 只支持 DeepSeek。'),
  }).description('图片发送模式'),

  Schema.union([
    Schema.object({
      imageMode: Schema.const('offload').required(),
      offloadMinKb: Schema.number()
        .min(0)
        .max(8192)
        .default(64)
        .description('小于该体积（KB）的图片不转存。'),
      offloadMaxPerRequest: Schema.number()
        .min(1)
        .max(64)
        .default(8)
        .description('单个请求最多转存几张图片，防止一次上传过多。'),
      offloadTtlHours: Schema.number()
        .min(1)
        .max(720)
        .default(720)
        .description('转存文件的临时有效期（小时）。需覆盖会话保留期，否则历史里的 URL 会失效。'),
      offloadPlatforms: Schema.array(Schema.string())
        .default(['deepseek'])
        .description('允许使用 URL 模式的模型关键字（按 model 名匹配，如 deepseek / qwen）。留空表示全部。'),
      offloadAllowLoopback: Schema.boolean()
        .default(false)
        .description('允许存储返回 127.0.0.1/内网地址（仅本地测试用；正式环境供应商抓不到）。'),
    }).description('offload：转存为公网 URL'),

    Schema.object({
      imageMode: Schema.const('files').required(),
      filesTtlDays: Schema.number()
        .min(0)
        .max(30)
        .default(30)
        .description('Files API 文件有效期（天），0 = 永久（需要自行清理）。'),
      filesMaxPerRequest: Schema.number()
        .min(1)
        .max(64)
        .default(8)
        .description('单个请求最多把几张图片转成 file_id。'),
      filesMinKb: Schema.number()
        .min(0)
        .max(8192)
        .default(0)
        .description('小于该体积（KB）的图片不转 file_id。'),
      filesRoles: Schema.array(Schema.string())
        .default(['user', 'tool'])
        .description('允许重写为 file 块的消息角色。tool 已实测可用，但属未文档化行为。'),
      filesPlatforms: Schema.array(Schema.string())
        .default(['deepseek'])
        .description('允许使用 Files API 的模型关键字（按 model 名匹配）。'),
      filesAccountScoped: Schema.boolean()
        .default(true)
        .description('按 API key 隔离 file_id 映射（多账号时避免跨账号引用）。'),
      filesUploadConcurrency: Schema.number()
        .min(1)
        .max(16)
        .default(4)
        .description('首次上传时的并发数。'),
    }).description('Files API：转存为 file_id'),

    Schema.object({}),
  ]),

  Schema.object({
    compressShowResults: Schema.boolean()
      .default(false)
      .description('执行结束时是否在控制台逐条打印每个会话的压缩结果（关闭时只打印合计与耗时）。'),
    compressLogEnabled: Schema.boolean()
      .default(false)
      .description('是否把每次批量压缩的完整过程（范围、明细、合计、耗时）输出到本地日志文件。'),
  }).description('批量压缩（chatluna.compressall）'),

  Schema.union([
    Schema.object({
      compressLogEnabled: Schema.const(true).required(),
      compressLogDir: Schema.string()
        .default('data/chatluna')
        .description('压缩日志目录，支持相对路径（相对 Koishi 工作目录）与绝对路径；目录不存在时自动创建。'),
    }).description('压缩日志输出'),

    Schema.object({}),
  ]),
]) as Schema<Config>

const CHAT_URL = /chat\/completions|responses/i
const PATCH_KEY = Symbol.for('chatluna.request-meter.patched')
const FILES_MAX_BYTES = 64 * 1024 * 1024

interface MeterState {
  config: Config | null
  logger: any
  storage: OffloadStorage | null
  filesStore: FileStore | null
  filesBackend: 'memory' | 'database' | null
  uploaders: Map<string, FilesUploader>
  warnedNoStorage: boolean
  warnedPrivateUrl: boolean
  warnedNoFiles: boolean
  last: BodyEstimate | null
  lastAt: number
  lastModel?: string
  requests: number
  maxBytes: number
  lastWarnAt: number
  lastWarnBytes: number
  lastErrorAt: number
  lastErrorBytes: number
}

const state: MeterState = {
  config: null,
  logger: null,
  storage: null,
  filesStore: null,
  filesBackend: null,
  uploaders: new Map(),
  warnedNoStorage: false,
  warnedPrivateUrl: false,
  warnedNoFiles: false,
  last: null,
  lastAt: 0,
  requests: 0,
  maxBytes: 0,
  lastWarnAt: 0,
  lastWarnBytes: 0,
  lastErrorAt: 0,
  lastErrorBytes: 0,
}

/** 供冒烟/排查使用：最近一次请求的体积估算 */
export function getLastEstimate(): BodyEstimate | null {
  return state.last
}

/** 供冒烟/排查使用：累计统计 */
export function getStats() {
  return {
    requests: state.requests,
    maxBytes: state.maxBytes,
    lastAt: state.lastAt,
    lastModel: state.lastModel,
    filesBackend: state.filesBackend,
  }
}

function shouldMeasure(url: string): boolean {
  if (!state.config?.enabled) return false
  if (!state.config.onlyChat) return true
  return CHAT_URL.test(String(url ?? ''))
}

function cooldownPass(lastAt: number, lastBytes: number, bytes: number, seconds: number): boolean {
  const now = Date.now()
  if (seconds <= 0) return true
  if (now - lastAt > seconds * 1000) return true
  // 体积变化超过 5% 视为新情况，允许再次记录
  if (lastBytes > 0 && Math.abs(bytes - lastBytes) / lastBytes > 0.05) return true
  return false
}

function report(url: string, data: any, estimate: BodyEstimate) {
  const config = state.config!
  const logger = state.logger
  const mib = 1024 * 1024
  const model = typeof data?.model === 'string' ? data.model : undefined
  const top = describeImages(estimate, config.breakdownTop)
  const line = `${summarize(estimate)}${model ? `, model ${model}` : ''}${top ? `, top ${top}` : ''}`

  state.last = estimate
  state.lastAt = Date.now()
  state.lastModel = model
  state.requests++
  if (estimate.bytes > state.maxBytes) state.maxBytes = estimate.bytes

  if (config.logEveryRequest) {
    logger.debug(`[request-meter] ${line}`)
  }

  if (estimate.bytes >= config.abortMiB * mib && config.abortEnabled) {
    logger.error(
      `[request-meter] 请求体 ${formatBytes(estimate.bytes)} 超过拦截阈值 ${config.abortMiB}MiB，已阻止发送。${line}`,
    )
    throw createAbortError(estimate, config)
  }

  if (estimate.bytes >= config.errorMiB * mib) {
    if (cooldownPass(state.lastErrorAt, state.lastErrorBytes, estimate.bytes, config.cooldownSeconds)) {
      state.lastErrorAt = Date.now()
      state.lastErrorBytes = estimate.bytes
      logger.error(`[request-meter] 请求体超过 ${config.errorMiB}MiB 警戒线：${line}`)
    }
    return
  }

  if (estimate.bytes >= config.warnMiB * mib) {
    if (cooldownPass(state.lastWarnAt, state.lastWarnBytes, estimate.bytes, config.cooldownSeconds)) {
      state.lastWarnAt = Date.now()
      state.lastWarnBytes = estimate.bytes
      logger.warn(`[request-meter] 请求体超过 ${config.warnMiB}MiB 提示线：${line}`)
    }
  }
}

function createAbortError(estimate: BodyEstimate, config: Config): Error {
  // 延迟 require，避免插件加载阶段强依赖 chatluna 的内部实现
  const { ChatLunaError, ChatLunaErrorCode } = require('koishi-plugin-chatluna/utils/error')
  const hint = estimate.inlineImages > 0
    ? `其中 ${estimate.inlineImages} 张内联图片占 ${formatBytes(estimate.inlineImageBytes)}。`
    : ''
  return new ChatLunaError(
    ChatLunaErrorCode.ABORTED,
    new Error(
      `[request-meter] 请求体 ${formatBytes(estimate.bytes)} 超过 ${config.abortMiB}MiB 阈值，已拦截。${hint}` +
        `请压缩/清理图片，或调高 abortMiB 并关闭拦截。`,
    ),
  )
}

function modelAllowed(model: unknown, platforms: string[]): boolean {
  if (platforms.length === 0) return true
  const name = String(model ?? '').toLowerCase()
  return platforms.some((platform) => name.includes(platform.toLowerCase()))
}

function accountKeyOf(apiKey: string, scoped: boolean): string {
  if (!scoped) return 'shared'
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16)
}

interface FilesRun {
  result: FilesTransformResult
  accountKey: string
}

async function runFilesMode(requester: any, data: any, config: Config): Promise<FilesRun | null> {
  if (!state.filesStore) {
    if (!state.warnedNoFiles) {
      state.warnedNoFiles = true
      state.logger.warn('[request-meter] imageMode=files 但映射存储不可用，图片仍以内联 base64 发送')
    }
    return null
  }
  if (!modelAllowed(data?.model, config.filesPlatforms)) return null

  let apiKey: string | undefined
  let filesUrl: string | undefined
  try {
    const platformConfig = requester?._config?.value
    apiKey = platformConfig?.apiKey
    if (!apiKey) return null
    filesUrl = requester.concatUrl('files')
  } catch (error) {
    if (!state.warnedNoFiles) {
      state.warnedNoFiles = true
      state.logger.warn('[request-meter] 无法获取 Files API 配置，跳过 file 转换：', error)
    }
    return null
  }
  if (!filesUrl) return null

  const accountKey = accountKeyOf(apiKey, config.filesAccountScoped)
  const cacheKey = `${accountKey}|${filesUrl}`
  let uploader = state.uploaders.get(cacheKey)
  if (!uploader) {
    uploader = new FilesUploader({
      fetchImpl: (url, init) => requester._plugin.fetch(url, init),
      apiKey,
      filesUrl,
      ttlSeconds: config.filesTtlDays * 86_400,
    })
    state.uploaders.set(cacheKey, uploader)
  }

  const result = await transformToFiles(data, {
    roles: config.filesRoles,
    minBytes: config.filesMinKb * 1024,
    maxBytes: FILES_MAX_BYTES,
    maxPerRequest: config.filesMaxPerRequest,
    concurrency: config.filesUploadConcurrency,
    uploader,
    store: state.filesStore,
    accountKey,
    logger: state.logger,
  })

  if (result.rewritten > 0) {
    state.logger.info(
      `[request-meter] file 模式：改写 ${result.rewritten} 张（上传 ${result.uploaded}，复用 ${result.reused}），` +
        `请求体减少 ${formatBytes(result.savedBytes)}` +
        (result.failed > 0 ? `，${result.failed} 张失败保留 base64` : ''),
    )
  } else if (result.failed > 0) {
    state.logger.warn(`[request-meter] ${result.failed} 张图片转 file_id 失败，已保留 base64`)
  }

  return { result, accountKey }
}

async function invalidateFiles(run: FilesRun) {
  if (!state.filesStore || run.result.used.length === 0) return
  for (const used of run.result.used) {
    await state.filesStore.remove(run.accountKey, used.hash)
  }
  state.logger.warn(
    `[request-meter] 请求返回 400，已作废 ${run.result.used.length} 条 file 映射（下一轮会重新上传）`,
  )
}

async function runOffloadMode(data: any, config: Config) {
  if (!state.storage) {
    if (!state.warnedNoStorage) {
      state.warnedNoStorage = true
      state.logger.warn('[request-meter] imageMode=offload 但 chatluna_storage 不可用，图片仍以内联 base64 发送')
    }
    return
  }
  try {
    const result = await offloadImages(data, state.storage, {
      minBytes: config.offloadMinKb * 1024,
      maxPerRequest: config.offloadMaxPerRequest,
      allowLoopback: config.offloadAllowLoopback,
      ttlHours: config.offloadTtlHours,
      maxBytes: 32 * 1024 * 1024,
      platforms: config.offloadPlatforms,
    })
    if (result.offloaded > 0) {
      state.logger.info(
        `[request-meter] 已转存 ${result.offloaded} 张图片，请求体减少 ${formatBytes(result.savedBytes)}` +
          (result.failed > 0 ? `，${result.failed} 张失败保留 base64` : ''),
      )
    } else if (result.failed > 0) {
      state.logger.warn(`[request-meter] ${result.failed} 张图片转存失败，已保留 base64`)
    }
    if (result.privateSkipped > 0 && !state.warnedPrivateUrl) {
      state.warnedPrivateUrl = true
      state.logger.warn(
        '[request-meter] 存储返回的是本机/内网地址，供应商无法抓取；' +
          '请把 chatluna-storage-service 的 serverPath 配成公网地址，或改用 s3/r2 后端',
      )
    }
  } catch (error) {
    state.logger.warn('[request-meter] 图片转存失败，已跳过：', error)
  }
}

let compressRunning = false

function localStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  )
}

/**
 * 把一次批量压缩的完整过程写入本地日志。失败只告警，不影响指令返回。
 * compressLogDir 可能是 undefined（yml 未写 compressLogEnabled: true 时条件分支不生效），
 * 这里用 ?? 兜底，符合 koishi-schema-config.md 的运行时守卫要求。
 */
async function writeCompressLog(opts: {
  dir: string | undefined
  lines: string[]
  includeArchived: boolean
  instruction?: string
  startedAt: number
  elapsedMs: number
  logger: any
}) {
  try {
    const dir = resolve(process.cwd(), opts.dir ?? 'data/chatluna')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `compress-all-${localStamp(new Date(opts.startedAt))}.log`)
    const text = [
      '# ChatLuna 批量压缩日志',
      `- 开始时间：${new Date(opts.startedAt).toLocaleString('zh-CN')}`,
      `- 用时：${(opts.elapsedMs / 1000).toFixed(1)}s`,
      `- 范围：${opts.includeArchived ? '全部会话（含归档）' : '仅活跃会话'}`,
      `- 摘要要求：${opts.instruction?.trim() || '无'}`,
      '',
      ...opts.lines,
      '',
    ].join('\n')
    await writeFile(file, text, 'utf8')
    opts.logger.info(`[compress-all] 压缩日志已写入：${file}`)
  } catch (error) {
    opts.logger.warn('[compress-all] 压缩日志写入失败：', error)
  }
}

/**
 * 注册 `chatluna.compressall`：强制压缩所有会话。
 * 需要 authority >= 3；逐条顺序执行；明细打印与日志文件由配置开关控制
 * （默认都关闭，聊天窗口始终只回一句摘要）。
 */
export function registerCompressAllCommand(ctx: Context, logger: any, config: Config) {
  ctx.inject(['database'], (ctx2) => {
    const commandApi = (ctx2 as any).command
    if (typeof commandApi !== 'function') {
      logger.warn('[compress-all] 当前环境没有 commands 服务（ctx.command 不可用），跳过指令注册')
      return
    }
    const database = (ctx2 as any).database
    const chatluna = (ctx2 as any).chatluna

    commandApi
      .call(ctx2, 'chatluna.compressall [instruction:text]', '强制压缩所有 ChatLuna 会话', { authority: 3 })
      .option('all', '-a, --all 包含已归档会话')
      .usage('强制压缩所有会话（跳过 token 阈值）。明细/日志输出由插件配置控制；可附加一段摘要要求。')
      .action(async ({ options }: any, instruction: string | undefined) => {
        if (compressRunning) return '已有压缩任务正在执行，请稍后再试。'
        const runtime = chatluna?.conversationRuntime
        if (typeof runtime?.compressConversation !== 'function') {
          return '当前 ChatLuna 版本不支持批量压缩（缺少 conversationRuntime）。'
        }

        compressRunning = true
        const started = Date.now()
        try {
          const includeArchived = options.all === true
          const showResults = config.compressShowResults === true
          const logEnabled = config.compressLogEnabled === true
          logger.info(
            `[compress-all] 开始压缩（${includeArchived ? '含归档' : '仅活跃'}${instruction ? '，带自定义摘要要求' : ''}）`,
          )
          const results = await compressAll(
            {
              list: async (withArchived) =>
                database.get('chatluna_conversation', withArchived ? {} : { status: 'active' }),
              isLocked: async (conversation) => {
                if (!conversation.bindingKey) return false
                try {
                  const constraint = await chatluna.conversation.getManagedConstraintByBindingKey(
                    conversation.bindingKey,
                  )
                  return constraint?.lockConversation === true
                } catch {
                  return false
                }
              },
              compress: (conversation, text) => runtime.compressConversation(conversation, true, text),
            },
            {
              includeArchived,
              instruction,
              onItem: (item, index, total) => {
                if (showResults) {
                  logger.info(`[compress-all] (${index + 1}/${total}) ${item.title} → ${item.status}`)
                }
              },
            },
          )

          const elapsedMs = Date.now() - started
          const lines = formatConsoleLines(results)
          const summaryLine = lines[lines.length - 1]
          if (showResults) {
            for (const line of lines.slice(0, -1)) {
              logger.info(`[compress-all] ${line}`)
            }
          }
          logger.info(`[compress-all] ${summaryLine}`)
          logger.info(`[compress-all] 结束，用时 ${(elapsedMs / 1000).toFixed(1)}s`)

          if (logEnabled) {
            await writeCompressLog({
              dir: config.compressLogDir,
              lines,
              includeArchived,
              instruction,
              startedAt: started,
              elapsedMs,
              logger,
            })
          }
          return formatChatSummary(results)
        } catch (error: any) {
          logger.error('[compress-all] 批量压缩异常：', error)
          return `压缩失败：${String(error?.message ?? error).slice(0, 120)}`
        } finally {
          compressRunning = false
        }
      })
  })
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('request-meter')
  state.config = config
  state.logger = logger

  // 默认先给内存映射，数据库可用时再覆盖
  if (!state.filesStore) {
    state.filesStore = new FileStore(new MemoryBackend(), logger)
    state.filesBackend = 'memory'
  }

  ctx.inject(['database'], (ctx2) => {
    try {
      const model = (ctx2 as any).model
      model?.extend?.(FILES_TABLE, {
        id: 'string',
        accountKey: 'string',
        hash: 'string',
        fileId: 'string',
        bytes: 'unsigned',
        mime: 'string',
        createdAt: 'timestamp',
        expiresAt: 'timestamp',
        lastUsedAt: 'timestamp',
      })
      state.filesStore = new FileStore(new DatabaseBackend((ctx2 as any).database, FILES_TABLE, logger), logger)
      state.filesBackend = 'database'
      logger.info('[request-meter] 已使用数据库保存 file_id 映射，重启后可复用')
    } catch (error) {
      logger.warn('[request-meter] 初始化 file 映射表失败，退回内存存储：', error)
    }
  })

  ctx.inject(['chatluna_storage'], (ctx2) => {
    state.storage = (ctx2 as any).chatluna_storage ?? null
    if (state.storage && state.config?.imageMode === 'offload') {
      logger.info('[request-meter] 已接入 chatluna_storage，图片可转存为公网 URL')
    }
  })

  registerCompressAllCommand(ctx, logger, config)

  const { ModelRequester } = require('koishi-plugin-chatluna/llm-core/platform/api')
  const proto = ModelRequester.prototype as any

  if (!proto[PATCH_KEY]) {
    const original = proto.post
    proto.post = function patchedPost(this: any, url: string, data: any, params?: any) {
      return (async () => {
        let filesRun: FilesRun | null = null

        if (shouldMeasure(url)) {
          const current = state.config!
          if (current.imageMode === 'files') {
            try {
              filesRun = await runFilesMode(this, data, current)
            } catch (error) {
              state.logger.warn('[request-meter] file 模式处理失败，已跳过：', error)
            }
          } else if (current.imageMode === 'offload') {
            await runOffloadMode(data, current)
          }

          try {
            const estimate = estimateBody(data)
            report(url, data, estimate)
          } catch (error) {
            if (error && (error as any).name === 'ChatLunaError') throw error
            state.logger.warn('[request-meter] 体积估算失败，已跳过：', error)
          }
        }

        const response = await original.call(this, url, data, params)
        if (filesRun && filesRun.result.used.length > 0 && response && response.status === 400) {
          await invalidateFiles(filesRun)
        }
        return response
      })()
    }
    proto[PATCH_KEY] = original
    logger.info('[request-meter] 已挂载到 ModelRequester.post（覆盖全部适配器）')
  } else {
    logger.info('[request-meter] 探测点已存在，仅更新配置')
  }

  ctx.on('dispose', () => {
    if (state.config === config) state.config = null
  })
}