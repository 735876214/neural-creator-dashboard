# note-api：读写笔记库的 HTTP 服务，同时托管看板前端（多阶段构建）。
#
# 构建由 GitHub Actions 完成（.github/workflows/docker-image.yml）：push 到 main 后
# 自动构建并发布 ghcr.io/735876214/neural-creator-dashboard:latest，NAS 上 compose
# 直接拉取镜像，不需要源码、不需要本机构建。本机调试时可手动 docker build。
# 阶段一在容器里 npm ci + vite build 出 dist/；阶段二只装运行时依赖
# （pdfjs-dist，纯 JS 无原生编译），镜像仍然很小。
# 前端由 note-api 以 STATIC_DIR 自托管，鉴权也由它自己做：未登录时页面导航 302 到
# login.html、其余请求回 401（镜像里没有 nginx，也没有 auth_request 子请求）。
FROM node:24-alpine AS web
WORKDIR /build
COPY package.json package-lock.json ./
# npm ci 而不是 npm install：同一 commit 必须装出同一份依赖，install 会就地改写 lock
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM node:24-alpine

# VAULT_GIT=1 时 note-api 会调用 git 做自动提交；alpine 基础镜像不自带 git。
# 挂载进来的 vault 往往属于宿主机上的另一个 UID，需要 safe.directory 才不报
# "dubious ownership"；提交身份也一并写进系统级配置，免得 commit 因缺 user.name 失败。
# 系统级 gitconfig 在 /etc 下，切到非 root 用户后依然可读。
RUN apk add --no-cache git \
 && git config --system --add safe.directory /vault \
 && git config --system user.name "note-api" \
 && git config --system user.email "note-api@localhost"

# 需要 Node 22.5+ 才有 node:sqlite；24 起不用加 --experimental-sqlite
WORKDIR /app

# 只拷服务端与构建好的前端
COPY server ./server
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=web /build/dist ./dist

# 运行期目录预建并交给 node 用户（镜像自带 uid/gid 1000 的 node）。
# 以 root 运行会把宿主机 bind 挂载的笔记写成 root 所有：NAS 文件管理器 / SMB / Obsidian
# 里改不动也删不掉，宿主 git 还会报 dubious ownership。compose 里可用 user: "${PUID}:${PGID}"
# 对齐宿主的属主（见 docs/nas-deployment.md）。
RUN mkdir -p /vault /data && chown -R node:node /app /vault /data

# BUILD_VERSION 由 CI 用 --build-arg 注入（compose 也可传），启动日志会打出来：
# 只挂 :latest 时，没有版本号就无法判断线上跑的是哪个 commit。
ARG BUILD_VERSION=dev
# AUTH_FILE 必须有默认值：镜像不经 compose 直接 docker run（或 NAS 图形界面「添加容器」
# 只填镜像名与端口）时，没有 AUTH_FILE 就没有密码来源，authed() 会把 null 当免登录，
# 整个笔记库（含写入、删除、AI key）对 0.0.0.0 全裸。/data 本就是容器的数据目录，
# 首次启动会把随机密码写进 /data/auth.json 并打印到日志，重启沿用。
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    VAULT_DIR=/vault \
    DATA_DIR=/data \
    STATIC_DIR=/app/dist \
    AUTH_FILE=/data/auth.json \
    BUILD_VERSION=${BUILD_VERSION}

EXPOSE 8787

# deep=1 检查 vault 可读、DATA_DIR 可写：卷只读或配额满时容器要显示 unhealthy，
# 而不是「页面能开、保存全失败」却一直 healthy。start-period 放宽到 30s，
# 冷启动慢的 NAS 上别在第一轮就判死。
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health?deep=1').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 非 root 运行：容器内进程受损不等于整个 NAS 受损
USER node

CMD ["node", "server/index.mjs"]
