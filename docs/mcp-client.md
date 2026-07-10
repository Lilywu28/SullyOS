# 通用 MCP 客户端（用户自配的远程工具服务器）

> 改 MCP 接入路径、排查「工具连不上 / 角色不调工具」前必读。
> 这份文档讲的是**通用** MCP 客户端；小红书/麦当劳/瑞幸那三个写死的客户端不归这里管
> （它们分别在 `utils/xhsMcpClient.ts` / `mcdMcpClient.ts` / `luckinMcpClient.ts`）。

## 用户视角

设置 → 「MCP 工具服务器」卡片：

1. 「+ 添加」→ 填名称和服务器 URL（如 `https://mcp.example.com/mcp`）
2. 服务器要鉴权就填 Bearer Token
3. 点「测试连接」→ 客户端走 MCP 握手 + `tools/list`，工具清单持久化到本机
4. 打开开关 → 聊天里角色就能调这些工具

### 连不上？三种网络路径

浏览器直连远程 MCP 服务器经常被 CORS 拦（典型症状：测试连接时报
`Failed to fetch`）。按场景三选一：

| 路径 | 适用 | 操作 |
|------|------|------|
| **直连**（代理 URL 留空） | 服务器 CORS 配置正确 | 什么都不用做 |
| **本地代理** | 本地 MCP（如 xiaohongshu-mcp）、或临时试用 | `node scripts/mcp-proxy.mjs`，代理 URL 填 `http://localhost:18061` |
| **自己的 Cloudflare Worker** | 云端 MCP + 手机/不想在电脑跑东西 | 部署 [`worker/mcp-proxy/`](../worker/mcp-proxy/README.md) 到**自己的** CF 账号，代理 URL 填 Worker 地址，建议设 `PROXY_KEY` 防白嫖 |

代理约定统一为 `<代理URL>?target=<url-encoded 服务器URL>`（可选 `X-Proxy-Key` 头）。
**刻意不走中心 sfworker**：MCP 流量含用户的 Bearer Token，不应该经过项目方服务器。

## 代码地图

| 职责 | 文件 |
|------|------|
| 协议客户端（握手/session/tools·list/call）+ 配置存储 | `utils/mcpClient.ts` |
| OpenAI 工具格式转换、跨服务器重名、系统提示块 | `utils/mcpToolBridge.ts` |
| 设置卡片 | `apps/Settings.tsx` 的 `McpServersCard` |
| systemPrompt 注入（9d 段）+ `mcpChatActive` flag + 尾部 reminder | `utils/chatRequestPayload.ts` |
| tools 注入 + 客户端工具循环（与瑞幸共用骨架） | `hooks/useChatAI.ts` |
| 备份导出/导入 | `utils/db.ts`（`mcpLocal` 段）+ `types.ts` `FullBackupData.mcpLocal` |
| 本地 CORS 代理（支持 `?target=` 通用模式） | `scripts/mcp-proxy.mjs` |
| 用户自部署 Worker 代理 | `worker/mcp-proxy/` |

## 设计要点（改之前必看）

- **走 function-calling，不走文本指令**。工具以 OpenAI `tools` 参数注入，复用
  瑞幸聊天点单的客户端工具循环（`useChatAI.ts` 3.6 段）。工具名命中
  `mcpToolResolve` 映射 → 分发给对应服务器；没命中且瑞幸模式开着 → 走瑞幸
  原逻辑。两类工具可同场。
- **工具清单读持久化结果，不在聊天路径发网络请求**。`tools/list` 只在设置里
  点「测试连接」时跑；服务器更新了工具需要用户重新点一次。
- **暴露名 ≠ 真实工具名**。OpenAI 工具名只许 `[A-Za-z0-9_-]{1,64}`，MCP 工具
  名可能带点号；跨服务器还会重名。`buildMcpOpenAITools()` 返回
  `resolve: Map<暴露名, {server, toolName}>`，执行时必须经它换回真实名。
- **MCP 模式强制本地 fetch**（跳过 Instant Push）且**本轮禁 thinking**
  （`toolModeActive`，Gemini 系 "thinking + tools" 同发会 400）——与
  瑞幸/麦当劳既有约束一致，设置卡片里已向用户说明。
- **session 失效自动重连一次**：`tools/call` 遇 HTTP 400/404 会重握手重试
  （服务器重启后 `Mcp-Session-Id` 作废是常态）。
- **配置改动要 `resetMcpSession`**：URL/token/代理任一变了旧 session 就不能用，
  设置卡片的 `update()` 已处理。

## 已知边界

- 只支持 Streamable HTTP（含 SSE 响应体解析）；不支持旧版 HTTP+SSE 双端点
  传输，也不支持本地 stdio 服务器（那种请套 mcp-proxy 或自行起 HTTP 端）。
- 只用了 MCP 的 tools 能力；resources / prompts / OAuth 授权流未实现
  （要接 OAuth 服务器，目前先在 Token 框里贴手动申请的 token）。
- 工具结果回填循环时截断 1500 字符（与瑞幸一致），超长结果考虑让服务器端分页。
