import type { Context } from 'koishi'
import { Schema } from 'koishi'
import {
  BodyEstimate,
  describeImages,
  estimateBody,
  formatBytes,
  summarize,
} from './measure'

// 供测试/排查复用
export { describeImages, estimateBody, formatBytes, summarize } from './measure'

export const name = 'chatluna-request-meter'

export const inject = {
  required: ['chatluna'],
}

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
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用请求体体积观测。'),
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
  logEveryRequest: Schema.boolean()
    .default(false)
    .description('每次请求都打 debug 日志（排查时打开）。'),
  onlyChat: Schema.boolean()
    .default(true)
    .description('只观测 chat/completions 与 responses 请求，忽略 embeddings/rerank。'),
  breakdownTop: Schema.number()
    .min(0)
    .max(10)
    .default(3)
    .description('日志里列出体积最大的前 N 张图片（0 = 不列）。'),
  cooldownSeconds: Schema.number()
    .min(0)
    .max(600)
    .default(30)
    .description('同一级别告警的去重冷却时间（秒），避免重试风暴刷屏。'),
})

const CHAT_URL = /chat\/completions|responses/i
const PATCH_KEY = Symbol.for('chatluna.request-meter.patched')

interface MeterState {
  config: Config | null
  logger: any
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

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('request-meter')
  state.config = config
  state.logger = logger

  const { ModelRequester } = require('koishi-plugin-chatluna/llm-core/platform/api')
  const proto = ModelRequester.prototype as any

  if (!proto[PATCH_KEY]) {
    const original = proto.post
    proto.post = function patchedPost(this: any, url: string, data: any, params?: any) {
      try {
        if (shouldMeasure(url)) {
          const estimate = estimateBody(data)
          report(url, data, estimate)
        }
      } catch (error) {
        if (error && (error as any).name === 'ChatLunaError') throw error
        logger.warn('[request-meter] 体积估算失败，已跳过：', error)
      }
      return original.call(this, url, data, params)
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