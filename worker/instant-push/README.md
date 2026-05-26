# instant-push Worker

基于 `@rei-standard/amsg-instant` 的自部署 Cloudflare Worker。
收到前端的 POST 请求后，调用你自己的 OpenAI 兼容 LLM，把回复分句后逐条发成 Web Push 通知。
默认零数据库、零 cron；大包默认走 `_multipart` 分片传输。想要更稳的大对象传输时，可以额外启用 D1 BlobStore，Worker 会自动建表并顺手清理过期数据。

---

## 文件说明

| 文件 | 说明 |
|------|------|
| `worker.bundle.js` | **实际部署的产物**（`wrangler.toml` 里 `main` 指向它）。esbuild 把所有外部依赖（含仓库根的 `utils/sanitize`）全部 inline 进来，自包含。`scripts/build-workers.mjs` 自动维护 |
| `src/index.ts` / `src/classifier.ts` | Worker 源码。只在仓库内开发/构建用；CF 不直接跑它 |
| `wrangler.toml` | CF Worker 部署配置 |
| `package.json` | 子目录依赖声明 —— CF Workers Builds 用它跑 `npm install + wrangler deploy` |

> 维护者注意：改完 `src/` 必须跑 `pnpm build:workers` 把 `worker.bundle.js` 一起 commit，否则部署用的还是旧 bundle。CI 会校验，详见仓库根 `CLAUDE.md`。

---

## 阶段 1：生成 VAPID 密钥对

打开 **SullyOS → 设置 → Instant Push → 配置**，点"生成新密钥对"按钮。

- 页面上会显示公钥（自动填入表单）和**一次性显示的私钥**
- **立即复制私钥**，关闭弹窗后私钥消失，不可恢复
- 公钥会自动填进表单，等下第 3 步一起贴进 CF 后台

---

## 阶段 2：在 Cloudflare 部署 Worker

### 主方案：用 Git URL 克隆（推荐，自动跟最新）

1. 访问 [dash.cloudflare.com](https://dash.cloudflare.com/) → Workers & Pages → Create → Worker
2. 选择 **Clone a public repository via Git URL**
3. Git repository URL 填：
   ```
   https://github.com/qegj567-cloud/SullyOS/tree/master/worker/instant-push
   ```
   （URL 末尾的 `worker/instant-push` 子目录路径必须保留，CF 才知道用哪一份 wrangler.toml）
4. 弹出的配置页保持默认即可：Build command 留空，Deploy command 用默认的 `npx wrangler deploy`，Builds for non-production branches 勾不勾都行。点 **Deploy**。
5. 部署成功后记录 Worker 地址：`https://instant-push.<你的账号>.workers.dev`
6. 之后只要上游仓库 push 新版，CF Workers Builds 会自动重新部署，**不用再手动同步**

> 为什么这条路能成：`wrangler.toml` 里 `main` 指向**预先打好的 `worker.bundle.js`**（仓库里跟着源码一起 commit 的）。CF 拿到子目录后只需要 `wrangler deploy` 把这份 bundle 上传，**不跑 esbuild**，自然也不会因为源码里的跨目录 import (`../../../utils/sanitize`) 而部署失败。
>
> 历史坑：早期 `main` 指向 `src/index.ts`，CF Builds 会跑 esbuild，碰到跨目录 import 直接 `Could not resolve` 部署 fail。现在已固定走 bundle，自动部署对用户透明。

### 备用方案：手动复制 `worker.bundle.js`

CF 后台连不上 GitHub、或者你 fork 了私有副本不想接 OAuth 时用这条路：

1. 同样在 CF 后台 Create → Worker，**Start with Hello World** 模板，给 Worker 起名（如 `instant-push`），点 Deploy 先建一个空 Worker
2. 进入 Worker 详情页 → **Edit code**（在线编辑器）
3. 把 `worker/instant-push/worker.bundle.js` 的全部内容粘贴进去，覆盖原有代码
4. 点 **Deploy** 完成部署
5. 同样记录 Worker 地址

> ⚠️ 备用方案部署的是 commit 时的 bundle 快照，要拿最新代码就得重新粘贴一次。主方案会自动跟最新。

---

## 阶段 3：配置环境变量

在 Worker 详情页 → **Settings → Variables and Secrets** 里依次添加：

### 必填（2 个）

| 变量名 | 来源 |
|--------|------|
| `VAPID_PUBLIC_KEY` | 阶段 1 生成的公钥 |
| `VAPID_PRIVATE_KEY` | 阶段 1 生成的私钥（类型选 **Secret**） |

### 可选

| 变量名 | 说明 |
|--------|------|
| `VAPID_EMAIL` | 留空则默认 `mailto:noreply@example.com`，填什么都行 |
| `AMSG_CLIENT_TOKEN` | 防止别人扫到你的 Worker URL 滥用 CF 配额；前端填相同的值 |
| `AMSG_OVERSIZE_TRANSPORT` | 高级兜底项。通常留空，由前台连接测试后的开关决定；填 `d1` 可让旧前端默认用 D1 |

配置完重新 Deploy 一次让 secrets 生效。

### 可选：启用 D1 BlobStore

默认不需要 D1。超出 Web Push 单包安全线的内容会被 `amsg-instant` 拆成 `_multipart` 分片，由 `amsg-sw` 在浏览器 Service Worker 里收齐后还原。

如果你愿意多部署一个 D1，想让大对象走更稳的“短 push + HTTP 拉完整包”路径：

1. 创建 D1 数据库：
   ```bash
   wrangler d1 create instant-blob-db
   ```
2. 在 `wrangler.toml` 里取消注释 `[[d1_databases]]`，填入 `database_id`。
3. 重新部署。
4. 回到 SullyOS → Instant Push 配置，点“检测连接”。检测到 D1 后，前台才会允许打开 D1 envelope。

表结构会由 Worker 首次请求自动初始化，过期 blob row 也会由 Worker 定期顺手清理。

取舍很简单：`multipart` 少部署、无服务端暂存；D1 更稳，但多一个数据库。低流量场景下自动清理只会在有请求经过时触发；想更准时清理的话，可以额外打开 `wrangler.toml` 里注释掉的 cron。

---

## 阶段 4：测试

回到 **SullyOS → 设置 → Instant Push → 配置**：

1. 填入 Worker URL（阶段 2 末尾记录的地址）
2. 确认公钥已自动填入
3. 如果配了 `AMSG_CLIENT_TOKEN`，在"Client Token"字段填入相同的值
4. 点**发送测试推送** —— 浏览器会先申请通知权限，然后调用你的 LLM 生成一句话推送过来
5. 系统通知里收到消息 = 链路全通

---

## 常见问题

**Q：手机上收不到推送？**
iOS 要求把 SullyOS 以 PWA 方式安装到主屏幕才能收 Web Push；Safari 浏览器内的标签页不支持。
安卓国行手机若无 Google 服务（GMS），Web Push 通道不通，换 Chrome 桌面版测试确认链路，App 内通知走 Capacitor 本地通知不受影响。

**Q：想暂停推送怎么办？**
在 CF 后台把 Worker 暂停（Pause）即可，前端数据不丢。重新启用后恢复正常。

**Q：怎么彻底删除？**
CF 后台 → Workers & Pages → 找到该 Worker → Settings → Delete。
前端在 SullyOS → 设置 → Instant Push 关掉开关即可停止发起请求。

**Q：LLM 调用费用谁出？**
你自己在前端配置的 Chat API（apiKey）—— Worker 用你传进来的 key 和 apiUrl 调 LLM，Worker 本身不持有任何 key。

**Q：CF 的 Git 克隆构建失败、提示找不到依赖？**
- 先检查 Git URL 末尾是否带上了 `tree/master/worker/instant-push` 子目录路径。
- 如果报 `Could not resolve "../../../utils/sanitize"` 之类**跨目录 import** 找不到：那是你 fork 的仓库里 `wrangler.toml` 的 `main` 还指向 `src/index.ts` 的老配置。把它改成 `main = "worker.bundle.js"` 并把仓库根的 `pnpm build:workers` 产物一起 commit 上去即可（上游仓库已经是这样配的）。
