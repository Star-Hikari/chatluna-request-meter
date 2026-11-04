/**
 * hash → file_id 映射存储。
 *
 * L1 内存缓存（跨请求），L2 可选 Koishi 数据库（重启后仍能复用）。
 * 数据库不可用或报错时自动退化为纯内存，不影响对话。
 */

export interface FileRecord {
  /** `${accountKey}:${hash}` */
  id: string
  accountKey: string
  hash: string
  fileId: string
  bytes: number
  mime: string
  createdAt: number
  /** null = 永久 */
  expiresAt: number | null
  lastUsedAt: number
}

export interface StoreBackend {
  get(id: string): Promise<FileRecord | null>
  set(record: FileRecord): Promise<void>
  remove(id: string): Promise<void>
}

function normalizeRow(row: any): FileRecord | null {
  if (!row || typeof row.fileId !== 'string') return null
  const toMs = (value: any): number | null => {
    if (value == null) return null
    if (typeof value === 'number') return value
    const time = new Date(value).getTime()
    return Number.isFinite(time) ? time : null
  }
  return {
    id: String(row.id),
    accountKey: String(row.accountKey ?? ''),
    hash: String(row.hash ?? ''),
    fileId: row.fileId,
    bytes: Number(row.bytes ?? 0),
    mime: String(row.mime ?? ''),
    createdAt: toMs(row.createdAt) ?? Date.now(),
    expiresAt: toMs(row.expiresAt),
    lastUsedAt: toMs(row.lastUsedAt) ?? Date.now(),
  }
}

export class MemoryBackend implements StoreBackend {
  private map = new Map<string, FileRecord>()

  constructor(private maxEntries = 512) {}

  async get(id: string): Promise<FileRecord | null> {
    const record = this.map.get(id)
    if (!record) return null
    // 触碰一下，维持 LRU 顺序
    this.map.delete(id)
    this.map.set(id, record)
    return record
  }

  async set(record: FileRecord): Promise<void> {
    this.map.delete(record.id)
    this.map.set(record.id, record)
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value
      if (oldest == null) break
      this.map.delete(oldest)
    }
  }

  async remove(id: string): Promise<void> {
    this.map.delete(id)
  }
}

export class DatabaseBackend implements StoreBackend {
  constructor(
    private database: any,
    private table: string,
    private logger?: any,
  ) {}

  async get(id: string): Promise<FileRecord | null> {
    const rows = await this.database.get(this.table, id)
    return rows?.[0] ? normalizeRow(rows[0]) : null
  }

  async set(record: FileRecord): Promise<void> {
    await this.database.upsert(this.table, [record])
  }

  async remove(id: string): Promise<void> {
    await this.database.remove(this.table, { id })
  }
}

export class FileStore {
  constructor(
    private backend: StoreBackend,
    private logger?: any,
  ) {}

  static keyOf(accountKey: string, hash: string): string {
    return `${accountKey}:${hash}`
  }

  /** 取一条可用记录；已过期（或 60 秒内过期）视为未命中 */
  async get(accountKey: string, hash: string): Promise<FileRecord | null> {
    const id = FileStore.keyOf(accountKey, hash)
    try {
      const record = await this.backend.get(id)
      if (!record) return null
      if (record.expiresAt != null && record.expiresAt <= Date.now() + 60_000) return null
      return record
    } catch (error) {
      this.logger?.warn?.('[request-meter] 读取文件映射失败：', error)
      return null
    }
  }

  async put(record: FileRecord): Promise<void> {
    try {
      await this.backend.set(record)
    } catch (error) {
      this.logger?.warn?.('[request-meter] 写入文件映射失败：', error)
    }
  }

  async remove(accountKey: string, hash: string): Promise<void> {
    try {
      await this.backend.remove(FileStore.keyOf(accountKey, hash))
    } catch (error) {
      this.logger?.warn?.('[request-meter] 删除文件映射失败：', error)
    }
  }

  async touch(accountKey: string, hash: string): Promise<void> {
    const id = FileStore.keyOf(accountKey, hash)
    try {
      const record = await this.backend.get(id)
      if (!record) return
      record.lastUsedAt = Date.now()
      await this.backend.set(record)
    } catch {
      // 触碰失败不影响主流程
    }
  }
}