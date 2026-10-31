# Fork notes — GnAyU/infinite-canvas

- Source: https://github.com/basketikun/infinite-canvas (MIT, see LICENSE — retained verbatim)
- Baseline: upstream v0.20.0, commit 9cd3dea, tagged `baseline-upstream-v0.20.0`
- Route: INDEPENDENT fork for personal, non-commercial use. `main` is our own trunk; upstream is read-only reference, with security fixes selected after review.
- Changes remain scoped; dependency, provider compatibility and configuration changes have separate commits.

## Web 标准工具链

使用 **Bun 1.4.4 + Node 22.23.4**，将这两个精确版本放在当前 shell 的 PATH；脚本检测到其他版本会直接失败，不自动修改全局工具链或回退到 npm。原先 Bun 1.3.13 / 本机 1.4.0 与 Node 22.23.3 已由 J 批准的安全补丁版本替代。

- 安装：`./scripts/setup.sh`，执行 npmjs registry 上的 `bun install --frozen-lockfile`。
- 开发：`./scripts/dev.sh`，默认 `http://127.0.0.1:3000`。
- 本地使用：`./scripts/serve.sh`，冻结安装、生产构建后启动 loopback preview。
- 测试：`cd web && bun run test`；类型检查：`bun run typecheck`；生产构建：`bun run build`，三条分别执行。
- 需要局域网访问时明确选择：`./scripts/dev.sh --host 0.0.0.0` 或 `./scripts/serve.sh --host 0.0.0.0`。这会暴露服务给网络中的其他设备；不要在不可信网络开放开发服务。额外端口参数也会透传。

`web/bun.lock` 是唯一目标 web 锁；过渡期间旧 npm/pnpm 文件仅保留到替代图验收通过，不作为安装输入。不要复制或修改 companion、docs、plugin 的独立锁。开发脚本每次都冻结安装，不用 node_modules 是否存在来跳过一致性检查，不使用 peer bypass。

`web/bunfig.toml` 固定 registry、冻结安装并关闭自动安装；显式 `trustedDependencies: ["esbuild"]` 替代默认信任表，仅批准锁中的 **esbuild 0.28.2** postinstall。平台可选二进制也受锁和完整性覆盖。其他依赖安装 hook 不获执行授权；发现额外必要 hook 时先审查，不能批量 trust。

## 构建入口与限制

- Pages 显式设置上述 Bun/Node 版本，使用 setup 脚本冻结安装；构建时 `VITE_BASE=/${repository.name}/`，并复制 `dist/index.html` 为 `dist/404.html`。
- Docker builder 组合 `oven/bun:1.4.4` 与 `node:22.23.4-bookworm-slim`，先复制 manifest/锁/bunfig，再验证版本并冻结安装。运行阶段仍是 nginx 静态站点。未启动 Docker daemon 或发布镜像；本机缺少 daemon/buildx，不能声称生产部署已完整验证。
- 根 Vercel 配置也调用相同版本检查和冻结安装。宿主必须能提供精确版本，否则构建**拒绝继续**；不会接受平台浮动版本。这里未运行托管 Vercel 部署，不能保证其环境可满足这些版本；可使用经审查的同图预构建静态产物，不把失败改为不受控在线安装。

React 19、AntD 6、localforage 1.10.0 保留；Pro 仅使用的 provider wrapper 由已有 AntD/app provider 承担。移除 shadcn CLI 及其 CSS 导入，但保留被 Radix select 使用的原状态变体。脚本编辑器保留原样式值，通过既有 class selectors 适配 AntD 6；无存储或功能迁移。

安全审计非零不被忽略：KaTeX 0.16.47 的 GHSA-238p-pmpm-9mq7 仍需 Viper/J 的明确风险结论，不能以低危或构建成功代替批准。完整逐项审计、安装和浏览器证据见 SCOPE-1 实施卡的证据索引；本分支不是发布批准。
