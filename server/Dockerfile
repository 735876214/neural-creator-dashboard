# note-api：读写笔记库的 HTTP 服务，同时可以托管前端构建产物 dist/。
#
# 服务端零依赖（只用 Node 自带模块），所以不需要 npm install、没有原生编译，
# 镜像很小、构建很快。
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

# 只拷服务端：前端默认由 nginx 托管；需要让 note-api 直接托管时设置 STATIC_DIR 并挂载 dist。
COPY server ./server
COPY package.json ./

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    VAULT_DIR=/vault \
    DATA_DIR=/data

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.mjs"]
