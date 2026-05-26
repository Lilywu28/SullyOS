# Claude / AI 助手工作笔记

这份文件是给 Claude Code 等 AI 助手自动读的项目级提示, 不放面向用户的文档。

## 改 Cloudflare Worker 源码后必须重新打包 bundle

### 涉及范围

- `worker/instant-push/src/**` (instant push worker)
- 任何被它 import 的 `utils/**` 或其它跨子目录文件 (e.g. `utils/sanitize.ts`)

### 为什么

worker 实际部署用的是 `worker/instant-push/worker.bundle.js` (`wrangler.toml`
里 `main = "worker.bundle.js"`), 不是 `src/index.ts`. 这样做是因为 src 里
import 了仓库根的 `../../../utils/sanitize`, 而 Cloudflare Builds 用 Git URL
子路径 (`tree/master/worker/instant-push`) 拉代码时**只克隆子目录**, esbuild
找不到外层 utils → "Could not resolve" 部署失败. bundle 是 esbuild 预先把外部
依赖全 inline 后的产物, 自包含, 上传即用.

历史上至少两次 (commits `948a2e8`, `bd44474`) 改了 src 没重生 bundle, 导致
部署的 worker 落后源码。CI 现在会校验, PR 没同步会直接 fail. 别再漏。

### 怎么做

改完 worker src 后, **必须**:

```bash
pnpm install            # 如未装依赖
pnpm build:workers      # 重生 worker/instant-push/worker.bundle.js + public/instant-worker.bundle.js
git add worker/instant-push/worker.bundle.js public/instant-worker.bundle.js
```

把更新后的 bundle **和** src 改动一起 commit. CI 会跑同一条命令然后
`git diff --exit-code` 检查, drift 就 fail.

如果只改了**不进 bundle** 的文件 (e.g. wrangler.toml 注释、README、worker
package.json 的 scripts), 可以不 rebuild — CI 会确认 bundle 仍同步.
