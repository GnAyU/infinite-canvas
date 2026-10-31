# 构建 Vite 前端产物。
FROM oven/bun:1.4.4 AS bun-toolchain
FROM node:22.23.4-bookworm-slim AS web-build
COPY --from=bun-toolchain /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app/web
COPY web/package.json web/bun.lock web/bunfig.toml ./
RUN test "$(bun --version)" = "1.4.4" && test "$(node --version)" = "v22.23.4"
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --registry=https://registry.npmjs.org --cache-dir=/root/.bun/install/cache
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
RUN bun run build

# 运行镜像：只启动静态前端，AI 请求由浏览器前台直连用户自己的接口。
FROM nginx:1.27-alpine

COPY --from=web-build /app/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY web/docker-entrypoint.sh /docker-entrypoint.d/40-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/40-runtime-config.sh

EXPOSE 3000
