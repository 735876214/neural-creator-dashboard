# note-api：读写笔记库的 HTTP 服务，同时可以托管前端构建产物 dist/。
#
# 服务端零依赖（只用 Node 自带模块），所以不需要 npm install、没有原生编译，
# 镜像很小、构建很快。
FROM node:24-alpine

# 需要 Node 22.5+ 才有 node:sqlite；24 起不用加 --experimental-sqlite
WORKDIR /app

# 只拷服务端：前端是构建好之后单独挂进来的静态文件
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
