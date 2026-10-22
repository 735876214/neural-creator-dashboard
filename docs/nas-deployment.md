# 在极空间 NAS 上部署：看板 + 笔记库 + AI

> 本机开发不用这份文件：用 `deploy/docker-compose.dev.yml`（只起 note-api 容器）+ `npm run dev`，见 `deploy/` 目录头部注释。

这套部署把你的 Obsidian 笔记库变成看板的数据源：看板在浏览器里打开就是最新内容，可以轻编辑（改动直接写回 `.md` 文件），AI 负责打标签、摘要、语义关联和问答。

```
极空间 NAS（Docker）
├── notes-vault/          明文 .md —— 笔记库，唯一真相，全部保存在 NAS 本地
└── note-api              单容器：读写笔记 + AI 编排 + 索引 + 托管看板与登录页（本仓库）
```

数据不出 NAS：vault `.md` 与索引卷都在本地，修改入口就是看板前端（局域网内访问），不提供外网访问与多设备同步——需要备份时用 NAS 自带快照即可。

## 0. 前置条件

- 极空间有 Container Manager（Docker）功能
- （可选，用 AI 时）DeepSeek / 硅基流动等任一家的 API key

## 1. 准备笔记库

在 NAS 上建一个共享文件夹（如 `notes-vault`），里面按看板的目录约定建四个子目录：

```
notes-vault/
├── 02-作品库/    ← 已发布的内容，frontmatter 写指标
├── 03-创作台/    ← 草稿
├── 04-选题池/    ← 选题
└── 05-方法库/    ← 方法笔记（可再分子目录，子目录会出现在图谱里）
```

note-api 还会在 vault 根目录自动创建隐藏目录 `.dashboard/settings.json`，保存月目标、AI 模型选择与平台 AppID；它不会出现在 Obsidian 文件树或图谱里，随 vault 一起备份。
**AI key 与公众号 AppSecret 不在那里**：`settings.json` 会被自动 commit 进 vault 的 git 历史并随 Syncthing 分发，所以这两类凭据存放在 `DATA_DIR`（默认容器内 `/data`）下的 `ai-secrets.json` 与 `platform-secrets.json`，权限 `0600`。`DATA_DIR` 一定要是持久卷，否则重启后要重填。旧版本曾把 AppSecret 写进 `settings.json`，升级后首次启动会自动搬到 `DATA_DIR` 并从该文件删除；但已经进过 git 历史的旧值无法自动清除，建议去微信后台重置一次 AppSecret。

作品笔记的 frontmatter 中英文字段都认：

```yaml
---
标题: 三分钟搭好你的第一个笔记系统
发布时间: 2026-09-01 20:30
类型: 视频            # 或 图文
观看: 1.2万           # 支持 1.2万 / 12.4% / 21s 这类写法
点赞: 386
评论: 42
收藏: 905
涨粉: 61
分享: 77
曝光: 9.8万
封面点击率: 12.4%
平均观看时长: 21s
tags: [笔记系统, 新手教程]
---
正文，可以写 [[双链]] 和 ![[图片.png]]。
```

方法笔记最少只要 `tags`；选题用 `platform / priority / status / note`，草稿用 `source`（来源选题标题）。

> 没有作品笔记也完全可以——作品库会是空的，其余照常。

## 2. 准备 compose 文件（NAS 上不需要源码）

镜像由 GitHub Actions 自动构建并发布到 GHCR（`ghcr.io/735876214/neural-creator-dashboard:latest`，
仓库为 public 时拉取无需登录）。NAS 上只需要 `docker-compose.yml`（如放在 `docker/neural/`），
不需要源码、不需要本机构建。

更新看板：重新拉取镜像即可——图形界面点一次构建/拉取，
或 `docker compose pull && docker compose up -d`。

**版本可追踪**：镜像同时发布 `:latest`（跟随 main）和 `:sha-<7 位 commit>` 两种标签，
启动日志第一行会打出 `版本 <BUILD_VERSION>`。`:latest` 每次 push main 都会被覆盖，
所以**升级前先备份、出问题按 sha 标签回滚**：

```bash
# 升级前备份笔记库与索引卷（路径按实际挂载改）
docker run --rm -v "$PWD/notes-vault":/v -v "$PWD":/b alpine tar czf /b/vault-backup.tgz /v
docker run --rm -v note-api-data:/d -v "$PWD":/b alpine tar czf /b/data-backup.tgz /d

# 回滚：把 compose 里的 image 临时钉到某个 sha，再 up -d
#   image: ghcr.io/735876214/neural-creator-dashboard:sha-7323d7e
docker compose up -d
```

索引卷里的 SQLite 跨版本只做「加列」迁移，旧版本读新库不保证正确——回滚时把
`data-backup.tgz` 一起还原最稳（`index.sqlite` 本身可以删掉重建，`auth.json` 与
`session.key` 不要删，删了要重新看密码 / 重新登录）。

## 3. 起 Docker Compose

```bash
cd docker/neural                  # compose 文件所在目录
docker compose up -d
```

> **文件属主**：容器以 `node`（uid/gid 1000）运行，不再用 root。若 NAS 上的笔记目录属于
> 别的用户（共享目录常见），先在 `.env` 里把 `PUID` / `PGID` 填成那边的 uid/gid，
> 否则看板写出来的笔记属于 1000，SMB / Obsidian / 文件管理器里改不动也删不掉：
> ```ini
> PUID=1000
> PGID=1000
> ```
> 也可以直接 `chown -R 1000:1000 notes-vault`（改成你填的 PUID/PGID）。
>
> **数据卷也要一起改**：`note-api-data` 命名卷（挂到容器内 `/data`）在首次创建时会继承镜像里
> `/data` 的属主 1000:1000。`PUID` / `PGID` 只换进程身份、不会动这个卷，所以当 PUID≠1000 时
> 进程打得开 `/vault`、却写不进 `/data/index.sqlite`，`server/index.mjs` 顶层建索引直接抛
> `EACCES` 退出，`restart: unless-stopped` 下就变成无限重启、日志只有一段堆栈。升级前一定要
> 把数据卷也改成同一个 uid/gid：
> ```sh
> chown -R 1043:1043 /path/to/Docker/neural/note-api-data   # 换成你的 PUID/PGID 与路径
> ```
> 从旧的 root 版镜像升级过来同理（老卷属主是 root）。`chown` 只需做一次，之后新建的文件都由
> 容器自己以 PUID 身份创建。

`.env` 是可选的：在 compose 文件同目录建一个 `.env`（可参考仓库里的 `deploy/.env.example`，
NAS 上没有仓库文件时直接新建即可），常用项：

```ini
DASHBOARD_USER=admin
DASHBOARD_PASSWORD=          # 留空 = 首次启动随机生成，docker compose logs note-api 查看
WEB_PORT=8088                # 看板端口，被占用时改
# WEB_BIND=0.0.0.0           # 前面挂 HTTPS 反代时改成 127.0.0.1（见下面「用 HTTPS 反代」）
# DASHBOARD_TZ_OFFSET=8      # 「今天是哪天」的时区偏移（作品日期、月目标、日报归类）
# AI_API_KEY=sk-...          # 可选：填了才有 AI 区块
# AI_BASE_URL=https://api.deepseek.com/v1
# AI_MODEL=deepseek-chat
```

不建 `.env` 也能启动，只是 AI / 热点关闭。

登录密码由 note-api 首次启动自举生成，写在容器卷的 `auth.json` 里（重启沿用，不会换密码）；**不需要**宿主机安装 `htpasswd`。两种用法：

- `.env` 里设置了 `DASHBOARD_PASSWORD`：直接用它；
- 留空：首次启动随机生成，执行下面这条命令查看（同时确认用户名）：

```bash
docker compose logs note-api
```

登录状态保存在 HttpOnly 会话 Cookie 里，默认 30 天（`SESSION_DAYS` 可改）。未登录访问任何页面都会先跳到 `login.html`，登录成功后回到看板；退出登录可调用 `POST /api/logout`。

> 极空间的 Container Manager 也可以图形化导入这个 compose 文件。
>
> `.env` 的完整变量说明见仓库 `deploy/.env.example`。`API_TOKEN` **只增不减能力**：设置后
> curl / 脚本可以用 `Authorization: Bearer <token>` 调 `/api`，浏览器会话照常工作（鉴权先试
> token、失败再回落 Cookie）。想彻底关掉密码登录是另外一回事，请改 `DASHBOARD_PASSWORD`。

浏览器打开 `http://<NAS-IP>:8088`，会先看到登录页；输入用户名和密码后进入看板，星核亮起来就是成功了。8088 被占用时在 `.env` 里改 `WEB_PORT`。

> **用 HTTPS 反代（可选）**：NAS 上再挂一层 Caddy / Traefik / 群晖反代时，两件事必须同时做，
> 否则反而更不安全：
>
> 1. `.env` 里 `WEB_BIND=127.0.0.1`（端口只监听本机，外部只能经反代进来）；
> 2. `.env` 里 `TRUST_PROXY=1`（note-api 才信任 `X-Forwarded-For` / `X-Forwarded-Proto`）。
>
> 只设 `TRUST_PROXY=1` 而端口仍发布在 `0.0.0.0` 时，任何直连请求都能自带 `x-real-ip`
> 伪造来源 IP，把登录限流绕成无限爆破；相反，只做反代而不设 `TRUST_PROXY` 时，所有请求的
> 来源 IP 都是反代容器，登录限流退化成「全局共享 8 次/5 分钟」，一个人连错就能把全家锁在门外，
> 而且 Cookie 的 `Secure` 属性也挂不上。Caddy 最小片段：
>
> ```caddyfile
> dash.example.com {
>     reverse_proxy 127.0.0.1:8088
> }
> ```

> **访问范围**：看板只在局域网内提供访问，没有外网入口、也没有多设备同步——数据全部在 NAS 本地，修改入口统一是看板前端。笔记是明文，请不要把端口转发到公网。

## 4. AI 功能（可选）

`.env` 里填：

| 变量 | 用途 | 说明 |
|---|---|---|
| `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL` | 打标签 + 摘要、选题生成、问答、热点日报 | 默认 DeepSeek；通义 / Kimi / 硅基流动 / 自建 OpenAI 兼容网关都行 |
| `AI_MODEL_ASK` / `AI_MODEL_ANALYZE` / `AI_MODEL_IDEAS` / `AI_MODEL_NEWS` | 各任务的默认模型 | 缺省回落 `AI_MODEL`；前端对话框里也可随时手动切换（选择写在 NAS 的 `vault/.dashboard/settings.json`） |
| `EMBED_*` | 语义关联、向量检索 | 两种方案见 `.env.example`：Cloudflare Workers AI（每天免费 10,000 Neurons）或 OpenAI 兼容接口 |

配置后重启 `note-api`，每篇方法笔记的分析栏会出现「AI 分析」区块：

- **打标签 + 摘要**：写回笔记 frontmatter 的 `tags` 和 `summary`（按内容 hash 增量，没改过的笔记不重算、不花 token）；
- **语义关联**：算 embedding 存索引，相似度超阈值的笔记对在分析栏里互相关联（不写文件，随时可重算）；
- **生成选题**：把候选写进 `04-选题池/`；
- **问答**：底部对话框的提问会检索你的笔记再回答，答案带引用、可点跳转。对话框旁的模型下拉可以换模型（拉不到列表时隐藏，走服务端默认）。

> **模型质量提示**：多模型网关上部分模型实测存在响应质量问题（返回无关内容或纯思考无输出）。建议用 glm / deepseek 系；思考型模型在列表里标了「（思考型）」，问答可用但较慢。

## 4.5 AI 热点（第六星座）

> 另有第七星座「个人知识库」：`06-个人知识库/` 下的 `kind: personal` 笔记（灵感 / 制度 / 推文剪藏）。
> 在看板「知识库」页粘贴链接即可由 note-api 抓取网页、保存 HTML 快照到 `06-个人知识库/.snapshots/`，
> 配置了 AI 时自动生成摘要与要点写回 frontmatter。快照读取接口带 CSP，不会执行剪藏页的脚本。
>
> **AI 助手**：创作台与知识库页右下角的浮动抽屉。上传 md / txt / docx / pdf（≤ MAX_BODY，默认 4 MB）
> 自动提取文本存进 `06-个人知识库/`（frontmatter 记 `sourceFile`），并可直接对全库提问（复用 `/api/ai/ask` 的 RAG 带引用；未配 AI key 时回退本地规则检索）。

首页多出的一簇「AI 热点」每天自动生成一份日报：

- 数据源是现成的公开 RSS（默认 [AIHOT 全部 AI 动态](https://aihot.news/all)，`NEWS_SOURCE` 可换成任何 RSS 2.0 源）；
- AI 把最近 48 小时的条目汇总成一段综述 + 主题分组，写进 `notes-vault/00-AI热点/YYYY-MM-DD.md`——自动出现在图谱的仙女座（粉色那簇）里，点开就是阅读窗；
- 每小时整点检查（当天过了 `NEWS_HOUR` 默认 8 点还没生成就补），`POST /api/news/refresh` 手动触发，`{"force": true}` 强制重做当天；
- `NEWS_CRON=0` 关闭整个定时任务。

## 5. 日常使用

- **看板里写**：长文、图片、整理都在看板完成——新建/改名/删除草稿、编辑选题、修改月目标，全部直接写回 NAS——草稿与选题落成 `.md`，月目标与 AI 模型选择写在 `vault/.dashboard/settings.json`。浏览器不保存这些业务数据；
- **离线时**：改动暂存在当前页面的内存里，恢复网络后自动补传；刷新或关闭页面会丢失未落盘的改动（页面会提示），所以断网时请保持标签页打开；
- **备份**：vault 建议 `git init` 一次（note-api 每次写入自动 commit，AI 误写可回滚）+ 极空间自身的快照。`vault/.dashboard/settings.json` 属于用户数据，会随 vault 一起备份；`index.sqlite` 是索引，删了会自动重建，不用备份。

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| build 报 `lstat .../server: no such file or directory` | 只上传了 `deploy/`，构建上下文里没有 `server/`。把整个仓库放到 NAS（compose 已在仓库根目录），至少含 `docker-compose.yml`、`Dockerfile`、`server/`、`src/`、`public/`、`package.json` |
| 旧版报 `env file .../deploy/.env not found` | 早期 compose 硬依赖 `.env` 且放在 `deploy/`。更新到当前版本后 `.env` 放仓库根目录、可选；需要 AI 时再 `cp deploy/.env.example .env` |
| 不知道登录密码 | `.env` 没设 `DASHBOARD_PASSWORD` 时首次启动随机生成：`docker compose logs note-api` |
| 登录后又跳回登录页 | 会话 Cookie 丢了或密码改过。检查浏览器是否禁用 Cookie；改密码后执行 `docker compose up -d --force-recreate note-api` 重新登录 |
| 登录页一直提示「连不上笔记库服务」 | note-api 没起来：`docker compose logs note-api`，确认容器健康（`docker compose ps`） |
| 页面显示「正在读取笔记库…」不动 | note-api 没起来：`docker compose logs note-api`；常见是 VAULT_DIR 挂载路径不对 |
| 保存提示「文件已被其他编辑器改动」 | 同一篇刚在别的标签页改过。看板没有覆盖，重新打开比对后再存 |
| 作品库是空的 | 还没有作品笔记——正常现象；或目录名不含「作品 / works」，用导入脚本时 `--works` 指定 |
| AI 区块不出现 | 服务端没配 `AI_API_KEY`，或配完没重启 note-api |
| 语义关联按钮报「embedding 未启用」 | 只配了 DeepSeek（它没有 embedding 接口），补配 `EMBED_*` 三项 |
| 星座 / 星核不动了 | 浏览器开了「减少动态效果」；这是无障碍特性，不是故障 |
