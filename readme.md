# koishi-plugin-chatluna-request-meter

观测 ChatLuna 每次模型请求的**请求体字节数**，在接近供应商上限时告警，可选超限直接拦截。

## 为什么需要它

ChatLuna 会把历史里的图片转成 base64 并**每轮重发**，而图片在本地 token 统计里几乎不计费
（`getMessageContent` 只拼 text 块），所以 token 一直"正常"，请求体却可能已经接近供应商上限
（DeepSeek 为 48 MiB）。等撞到 413 时，重试会把同一个超大请求反复发出去。

本插件挂在 `ModelRequester.prototype.post` 上——这是所有适配器（DeepSeek / 千问 / OpenAI /
MiMo 等）的唯一出口，因此**一处生效、全平台通用**。

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

## 统计内容

- `body`：整个 JSON 请求体（文本 + 工具 schema + 图片）
- `inline`：内联 base64 图片张数与占用
- `remote`：外链图片数量（只计 URL 长度，实际下载体积由服务端决定）
- `fileId`：Files API 引用数量（如后续接入）
- `top`：体积最大的 N 张图，附带消息下标、角色、工具名

## 精度

逐节点累加字符串化长度，不分配完整 JSON 字符串；对 base64 内容误差 < 0.5%
（测试用例 48 MiB 请求体实测误差 0.000%）。

## 注意

- 本插件通过 monkey-patch 修改 `ModelRequester.prototype.post`；若 ChatLuna 升级后该方法签名变化，
  插件会记录警告并跳过统计，不影响正常对话。
- 外链模式下 body 很小是预期行为，不代表服务端不会因为下载图片而变慢或失败。

## License

MIT