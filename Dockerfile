# note-api：读写笔记库的 HTTP 服务，同时托管看板前端（多阶段构建）。
#
# 构建由 GitHub Actions 完成（.github/workflows/docker-image.yml）：push 到 main 后
# 自动构建并发布 ghcr.io/735876214/neural-creator-dashboard:latest，NAS 上 compose
# 直接拉取镜像，不需要源码、不需要本机构建。本机调试时可手动 docker build。
# 阶段一在容器里 npm install + vite build 出 dist/；阶段二只装运行时依赖
# （pdfjs-dist，纯 JS 无原生编译），镜像仍然很小。
# 前端由 note-api 以 STATIC_DIR 自托管（登录走 auth_request 同一套会话，未登录 401，
# 由前端 boot.js 跳 login.html），不再需要单独的 nginx 容器。
FROM node:24-alpine AS web
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM node:24-alpine

# VAULT_GIT=1 时 note-api 会调用 git 做自动提交；alpine 基础镜像不自带 git。
# 挂载进来的 vault 往往属于宿主机上的另一个 UID，需要 safe.directory 才不报
# "dubious ownership"；提交身份也一并写进系统级配置，免得 commit 因缺 user.name 失败。
RUN apk add --no-cache git \
 && git config --system --add safe.directory /vault \
 && git config --system user.name "note-api" \
 && git config --system user.email "note-api@localhost"

# 需要 Node 22.5+ 才有 node:sqlite；24 起不用加 --experimental-sqlite
WORKDIR /app

# 只拷服务端与构建好的前端
COPY server ./server
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=web /build/dist ./dist

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    VAULT_DIR=/vault \
    DATA_DIR=/data \
    STATIC_DIR=/app/dist

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.mjs"]
