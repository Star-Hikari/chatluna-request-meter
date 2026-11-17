# koishi-plugin-chatluna-request-meter

观测 ChatLuna 每次模型请求的**请求体字节数**，在接近供应商上限时告警，实现了适配器不再以base64内联图片发送请求，支持改为公网链接或Files API方式上传图片

## 为什么需要它

ChatLuna 会把历史里的图片转成 base64 并**每轮重发**，而图片在本地 token 统计里几乎不计费
（`getMessageContent` 只拼 text 块），所以 token 一直"正常"，请求体却可能已经接近供应商上限
（DeepSeek 为 48 MiB）。等撞到 413 时，重试会把同一个超大请求反复发出去。

本插件挂在 `ModelRequester.prototype.post` 上——这是所有适配器（DeepSeek / 千问 / OpenAI 等）的唯一出口，因此**一处生效、全平台通用**。

## 安装

```bash
yarn add koishi-plugin-chatluna-request-meter
# 或 npm i koishi-plugin-chatluna-request-meter
```

在 Koishi 控制台启用「chatluna-request-meter」即可，默认配置就能工作。

## 配置

| 项 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `warnMiB` | `24` | warning 阈值（上限的 50%） |
| `errorMiB` | `38` | error 阈值（上限的 80%） |
| `abortMiB` | `45` | 拦截阈值（仅在 `abortEnabled` 时生效） |
| `abortEnabled` | `false` | 超限直接拦截，避免重试风暴 |
| `logEveryRequest` | `false` | 每次请求打 debug 日志 |
| `onlyChat` | `true` | 只观测 chat/completions 与 responses |
| `breakdownTop` | `3` | 日志里列出最大的前 N 张图片 |
| `cooldownSeconds` | `30` | 同级别告警去重冷却 |

## 日志示例

```
[request-meter] 请求体超过 24MiB 提示线：body 45.80MiB, inline 3, inline 41.90MiB, text 3.90MiB, model deepseek-flash, top #12 human(qzone_post_detail) 16.40MiB; #18 human 11.40MiB
```

开启 `abortEnabled` 后，超过 `abortMiB` 的请求会在发送前被拦截，并抛出 `ChatLunaError(ABORTED)`。

## 图片发送模式

`imageMode` 三选一：

| 模式 | 请求体里的图片 | 依赖 |
|---|---|---|
| `inline`（默认） | base64 字节 | 无 |
| `offload` | 公网 URL | `chatluna_storage` + 公网可达地址 |
| `files` | `file_id`（DeepSeek Files API） | 仅 DeepSeek，不需要公网 IP |

### offload

```yaml
imageMode: offload
offloadMinKb: 64
offloadMaxPerRequest: 8
offloadTtlHours: 720
offloadPlatforms: [deepseek]
offloadAllowLoopback: false
```

使用前提：

1. `chatluna-storage-service` 的 `serverPath` 必须是**供应商能访问的公网地址**（有固定公网 IP
   可反代 `chatluna-storage`），或改用 `s3` / `r2` 后端；
2. 目标模型支持 http(s) 图片输入（DeepSeek 支持，默认白名单 `deepseek`）；
3. 存储配额要够（默认 500MB / 300 个文件），大图建议切 S3/R2 或调大上限。

如果存储返回 `127.0.0.1`/内网地址，插件会跳过转存并保留 base64，同时打一条 warning。

### files（DeepSeek Files API）

把 base64 上传成 `file_id`，请求体里只留一个 id，同一张图多轮复用，**不需要公网 IP**。

```yaml
imageMode: files
filesTtlDays: 30          # 0 = 永久（需自行清理）
filesMaxPerRequest: 8
filesMinKb: 0
filesRoles: [user, tool]  # tool 已实测可用（未文档化）
filesPlatforms: [deepseek]
filesAccountScoped: true
filesUploadConcurrency: 4
```

说明：

- 首次遇到某张图时上传（8–12MB 约 1–3 秒），之后命中 hash 映射不再上传；
- 映射默认存内存，有 `database` 时写入 `chatluna_request_meter_file` 表，重启后可复用；
- 请求返回 400 时会把本轮用到的映射作废，下一轮自动重传；
- 单文件上限 64 MiB，账号配额 25 GiB / 10000 文件；
- 任何上传失败都会保留 base64，不影响对话。

> 为什么不做"原链接透传"：`fetchImageUrl` 是 shared-adapter 内部的局部函数，运行时替换 exports
> 无效；要透传只能给 node_modules 打补丁，而市场安装形态无法保证这一点。

## 统计内容

- `body`：整个 JSON 请求体（文本 + 工具 schema + 图片）
- `inline`：内联 base64 图片张数与占用
- `remote`：外链图片数量（只计 URL 长度，实际下载体积由服务端决定）
- `fileId`：Files API 引用数量
- `top`：体积最大的 N 张图，附带消息下标、角色、工具名

## 精度

逐节点累加字符串化长度，不分配完整 JSON 字符串；对 base64 内容误差 < 0.5%
（测试用例 48 MiB 请求体实测误差 0.000%）。

## 注意

- 本插件通过 monkey-patch 修改 `ModelRequester.prototype.post`；若 ChatLuna 升级后该方法签名变化，
  插件会记录警告并跳过统计，不影响正常对话。
- 外链模式下 body 很小是预期行为，不代表服务端不会因为下载图片而变慢或失败。

## 指令：`chatluna.compressall`

强制压缩所有 ChatLuna 会话（跳过 token 阈值），需要 **Koishi 权限 3 级及以上**。

```text
chatluna.compressall [instruction:text] [-a|--all]
```

| 参数 | 说明 |
|---|---|
| `instruction` | 可选，追加到摘要 Prompt 的额外要求 |
| `-a, --all` | 连同已归档会话一起压缩 |

行为：

- 按 `lastChatAt` 倒序**串行**压缩（同一平台会争锁，并发没有收益）；
- 压缩前检查 `lockConversation`，锁定的会话直接跳过，不会报错中断；
- 单个会话失败只记录，不影响其余会话；
- 聊天窗口只返回一句摘要（总数、成功/无变化/锁定/失败、减少的 token 比例）。

输出开关（插件配置「批量压缩」分组，默认都关闭）：

| 配置 | 默认 | 说明 |
|---|---|---|
| `compressShowResults` | `false` | 结束时是否在控制台逐条打印每个会话的压缩结果与进度；关闭时只打印合计与耗时 |
| `compressLogEnabled` | `false` | 是否把每次批量压缩的完整过程输出到本地日志文件 |
| `compressLogDir` | `data/chatluna` | 日志目录（仅在 `compressLogEnabled` 打开时显示）；支持相对路径（相对 Koishi 工作目录）与绝对路径，自动创建 |

日志文件名为 `compress-all-<本地时间>.log`，包含开始时间、用时、范围、摘要要求与逐条明细。

> 会话的模型/预设必须仍然可用；预设被删或模型下线时该会话会记失败。
> 同一时间只允许一个批量压缩任务运行。

## 更新日志

### 1.2.0

- `chatluna.compressall` 新增「批量压缩」配置分组（默认全部关闭，行为更安静）：
  - `compressShowResults`（默认 `false`）：是否在控制台逐条打印每个会话的压缩结果与进度；关闭时只打印合计与耗时；
  - `compressLogEnabled`（默认 `false`）：是否把每次批量压缩的完整过程写入本地日志文件；
  - `compressLogDir`（默认 `data/chatluna`）：日志目录，仅在日志开关打开时显示；支持相对路径（相对 Koishi
    工作目录）与绝对路径，目录不存在时自动创建。
- 日志文件名为 `compress-all-<本地时间>.log`，含开始时间、用时、范围、摘要要求与逐条明细；写入失败只告警，不影响指令返回。
- 配置联动遵循 koishi-schema-config.md 的模式选择式模板（顶层 intersect + union，`const(true).required()` + 空分支兜底），
  运行时对未命中分支的 `compressLogDir` 使用 `?? 'data/chatluna'` 守卫。

### 1.1.0

- 新增 `chatluna.compressall` 指令（authority ≥ 3）：强制压缩所有会话，支持 `-a` 包含归档、可选自定义摘要要求；
  控制台输出逐条明细与合计，聊天窗口返回简短摘要。
- 新增 `compress-all` 模块与单元测试（顺序执行、锁检查、失败隔离、摘要格式、指令装配）。

### 1.0.0

- 请求体体积观测：`warnMiB` / `errorMiB` / `abortMiB` 阈值告警，可选超限拦截（避免重试风暴）。
- 体积估算精度：48 MiB 请求体实测误差 0.000%，日志可列出最大的前 N 张图片。
- `imageMode: offload`：把 base64 图片转存到 `chatluna_storage`，请求体只留公网 URL。
- `imageMode: files`：DeepSeek Files API，上传一次换取 `file_id`，多轮复用；
  支持 hash 去重、内存/数据库映射、400 时自动作废重传。
- 配置按功能分组（基础 / 体积告警 / 观测与日志 / 图片发送模式 + offload / Files API 条件分支）。

## License

MIT