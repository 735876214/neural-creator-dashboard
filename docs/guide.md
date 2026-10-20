# 模块与使用指导手册

> 这份手册按「架构 → 模块 → 操作 → 配置 → 排障」梳理整个项目。面向两类读者：想快速上手的使用者，和准备改代码的开发者。
> 用户快速开始、导入笔记等更偏「用起来」的内容以 [README](../README.md) 为准；开发约定以 [AGENTS.md](../AGENTS.md) 为准；NAS 部署细节见 [nas-deployment.md](nas-deployment.md)。

---

## 1. 项目定位

创作神经网络看板：把**作品、方法笔记、选题、草稿**推导成一张神经网络图谱。中心是一颗逐帧自绘的星核，周围是七个真实星座骨架构成的星团；点开星团，星座线展开到每一篇内容；点开内容，右侧滑出分析栏。

三种运行形态：

| 形态 | 组成 | 数据来源 |
|---|---|---|
| 纯静态 | `npm run build` 后的 `dist/` | 构建时打包进 bundle 的 `my-data.local.js` 或 `sample.js` |
| 本机开发 | `npm run dev`（Vite :5173）+ `npm run api`（note-api :8787） | note-api 实时读取 vault；Vite 把 `/api` 代理到 8787 |
| 部署（NAS） | note-api 单容器（GHCR 镜像 `ghcr.io/735876214/neural-creator-dashboard`，compose 直接拉取，前端构建在 GitHub Actions 完成） | vault 里的 `.md` 文件 |

核心不变式：**`.md` 文件是唯一真相**；SQLite 与前端内存里的图谱都是可删可重建的派生物。唯一的例外是 `vault/.dashboard/settings.json`（月目标、AI 模型选择），它也是用户数据，随 vault 一起备份，但不参与笔记解析。

---

## 2. 总体数据流

```
看板前端（唯一修改入口）        看板设置 vault/.dashboard/settings.json
        │  PUT /api/*                 ▲
        ▼                             │ PUT /api/settings
   notes-vault/  ── readVault() ──► note-api /api/data ──► boot.js ──► src/data/store.js
        ▲                                                       │
        │  PUT /api/idea|draft|note、DELETE /api/note             │
        │  （mtime 乐观锁、.trash/ 备份、git commit）              ▼
   看板写操作（草稿/选题/正文编辑）◄── persist.js ◄── React（main.jsx / pages.jsx / Analysis.jsx）
                                                                │
                                                        buildGraph()（纯前端推导）
                                                                ▼
                                              星核 / 六星座 / 内页 / 分析栏（Canvas + React）
```

部署模式下业务数据只写 NAS：选题/草稿/目标都经 `persist.js` 落盘，浏览器 localStorage 不参与；纯静态模式只读。

两条旁路：

- **AI**：note-api 的 `server/ai.mjs` 调用 OpenAI 兼容或 Anthropic 协议网关，产出标签、摘要、语义关联、选题候选、问答；key 只在服务端。
- **AI 热点**：`server/news.mjs` 定时拉 RSS → AI 汇总成日报 → 写 vault 与 SQLite → 看板出现第六星座「AI 热点」，并可自动筛选题进选题池。

---

## 3. 目录与文件职责

### 3.1 前端入口与数据层

| 文件 | 职责 |
|---|---|
| `index.html` | 页面入口，加载 `src/neural/main.jsx`（实际先走 `boot.js`） |
| `src/config.js` | 品牌名、工作台名、头像路径、页脚；可有 `config.local.js` 覆盖 |
| `src/neural/boot.js` | **挂载 React 之前**先确认登录状态（`/api/session`）再取数：`VITE_API_BASE`（或同源）`/api/data`，8s 超时；未登录跳 `login.html`，失败则回退本地快照并进入只读模式 |
| `public/login.html` | 独立登录页（深空星空代码自绘、中英双语、支持 prefers-reduced-motion）；登录成功后回到原页面；纯静态部署不会用到 |
| `src/data/store.js` | 运行时数据仓：保存 boot 取回的数据、`files`（节点 id → 文件路径）、`mtimes`、`figures`（附件）、`settings`、`meta`、来源与错误 |
| `src/data/index.js` | 同步导出 `snapshot / posts / postContent / notes / seedIdeas / seedDrafts / concepts / files / figures / mtimes / settings / meta` |
| `src/neural/persist.js` | NAS 持久化：防抖自动保存、同 key 串行、mtime 乐观锁、内存 outbox 重试、409 冲突、新建后回填 path/mtime、完整正文 hydrate；**不写 localStorage** |
| `src/neural/SaveStatus.jsx` | 保存状态徽标与顶部同步横幅 |
| `src/data/sample.js` | 虚构示例数据，也是字段权威说明 |
| `src/data/my-data.local.js` | `npm run import` 生成的本机快照（gitignore，不入库） |
| `src/neural/works.js` | 作品与本月作品；`monthPosts` 以最新一篇所在月份为准 |

为什么要有 store：`works.js` 在模块顶层就 `posts.map()`，`graph.js` 的 `buildGraph()` 也是同步的。数据必须在任何模块被 import 前填好，所以 `boot.js` 用顶层 `await` 取数，再 `await import('./main.jsx')`。

### 3.2 图谱推导

`src/neural/graph.js`（全部在浏览器里算，不联网）：

| 导出 | 作用 |
|---|---|
| `KINDS` / `LINK_KINDS` / `LINK_EN` | 节点类型与六类连接的标签 |
| `MODULES` | 七个模块（五个主模块 + AI 热点 + 个人知识库）：id、标题、对应 kind、目录节点、角度、内页 |
| `buildGraph({ideas, drafts})` | 由 posts / notes / ideas / drafts / concepts 推导节点、边、度数、双向标记 |
| `neighbors` / `latent` | 一度 / 二度关联 |
| `stats` | 内容数、连接数、双向组数、未创建双链数 |
| `askGraph` | 底部「问图谱」的本地规则检索，不调用 AI |
| `forceLayout` | 星团节点布局 |

连接规则：目录归属、`[[双链]]`（未命中记为「未创建」）、选题来源（草稿 `source` ↔ 选题状态「已转草稿」，缺 `source` 时按同名标题回连）、发布为作品（草稿与作品标题相同）、热点依据（选题 `sourceNews` → 当天 AI 热点日报）、话题标签（frontmatter tags + 正文 `#话题`）、正文提及概念（至少两条内容提及才成为概念节点）、双向共振（共同提及 ≥2 个概念）、同名概念桥（知识分区与作品侧同名概念自动相连），以及 AI 语义边（`semantic`，来自 `/api/ai/relate`，持久化在 SQLite）。

分区：知识笔记和 AI 热点（`note / news`）与作品侧（`post / idea / draft`）各自成团，概念节点与共振以同区为主；同名概念、共享话题、热点来源和语义边会把两侧桥接起来。

### 3.3 视觉与交互

| 文件 | 职责 |
|---|---|
| `src/neural/Home.jsx` | 工作台：星核、七簇星团、三层交互、逐帧 `step()` 动画 |
| `src/neural/StarCore.jsx` | 星核 Canvas 渲染 |
| `src/neural/v41.js` | 星核渲染参数（色带、日冕、光晕等配置文件） |
| `src/neural/constellations.js` | 七个真实星座（J2000 星表 + 经典连线）与固定模块映射 |
| `src/neural/Cosmos.jsx` | 星穹背景：星云、星尘、流星 |
| `src/neural/NetworkCanvas.jsx` | 背景神经网络层 |
| `src/neural/ConstellationBand.jsx` | 五个内页顶部的星座轨 |
| `src/neural/theme.js` | 配色与素材路径（全站唯一一套深空配色） |
| `src/neural/icons.jsx` | 内联 SVG 图标 |
| `src/neural/neural.css` | 全部样式；顶部 CSS 变量是配色的另一处入口 |

星座映射固定：方法库→天蝎、概念网络→双鱼、作品库→处女、选题池→射手、创作台→水瓶、AI 热点→仙女座、个人知识库→猎户座。七个星团始终参与主视图布局；AI 热点没有日报时该星团为空或计数为 0。

知识库页与创作台页各有一个 **AI 助手**抽屉：上传 md / txt / docx / pdf 提取文本入库（`POST /api/knowledge/upload`，服务端解析），提问复用 `/api/ai/ask`（RAG 全库检索，含个人知识库）。

动画约定：循环必须「先排下一帧、再在 try 里执行本帧」，`dt` 不得为负；否则一帧异常会让星核与星团停在隐形状态。`prefers-reduced-motion` 时降级为静态表现。

### 3.4 页面与组件

| 文件 | 职责 |
|---|---|
| `src/neural/main.jsx` | 路由（`#home/#library/#drafts/#ideas`）、顶栏、弹窗（关于、目标、选题、阅读/编辑）、只读模式、同步横幅、toast |
| `src/neural/pages.jsx` | 五个内页：作品库（搜索 + 四种排序 + 选中分析）、创作台（编辑器、`[[` 双链补全、删除草稿）、选题池（新建/编辑/转草稿）、知识库（剪藏/上传）、方法库（浏览笔记）；保存状态就地展示 |
| `src/neural/Analysis.jsx` | 右侧分析栏：指标、收藏率等级、出链/反链/双向、话题、二度关联；AI 面板（打标签、语义关联、生成选题、模型选择、任务轮询） |
| `src/neural/persist.js` | 选题/草稿/目标/AI 模型的 NAS 读写：1.2s 防抖、同 key 串行、内存 outbox 重试、409 冲突、新建回填 path/mtime、完整正文 hydrate |
| `src/neural/sync.js` | AI 请求封装（`aiModels / aiAnalyze / aiRelate / aiIdeas`）；模型选择转存 NAS 设置 |

五个内页的功能：

- **作品库**：按标题搜索；按最新/观看/收藏率/涨粉排序；点击一行在右侧分析栏看全部指标与连接；可跳回工作台在图中定位。
- **创作台**：左侧草稿列表，右侧编辑器；标题与正文停止输入 1.2s 后自动写回 vault（`03-创作台/`），新建草稿立即落盘；删除会调用 `DELETE /api/note`，原文件先备份到 `.trash/`。断网时改动只在内存 outbox，恢复后自动重试。
- **选题池**：卡片列表；编辑优先级/状态/备注/平台；「转为草稿」会写回选题 `status: 已转草稿` 并新建草稿（`source` 记录选题标题，不调用 AI）；已有来源草稿时改为「打开关联草稿」。

### 3.5 后端 note-api（`server/`，零依赖，只用 Node 自带模块）

| 文件 | 职责 |
|---|---|
| `index.mjs` | HTTP 服务与路由、写入管线（乐观锁→备份→最小侵入改写→git commit）、创建/重命名/删除、设置文件读写、静态托管、鉴权、后台任务、定时任务注册 |
| `vault.mjs` | 扫描与解析 vault：分类规则、frontmatter 解析（中英键名）、数字/日期/标签归一化；与 import 脚本共用 |
| `frontmatter.mjs` | 最小侵入改写：只替换需要改的键与正文，保留字段顺序、注释、换行风格（CRLF/LF）与 Obsidian 类型推断 |
| `db.mjs` | SQLite（`node:sqlite`）：`notes` + FTS5 trigram 全文索引、`embeddings`、`ai_cache`、`jobs`、`news`；全部是可重建派生物 |
| `ai.mjs` | AI 网关调用层：openai / anthropic 双协议、任务模型、超时重试、并发闸、JSON 兜底、模型列表缓存 |
| `news.mjs` | RSS 拉取与解析、AI 生成日报、写 vault 与 SQLite、每小时 cron 检查 |
| `Dockerfile` | note-api 容器镜像 |

写入管线细节（`writeExisting`）：先比对 mtime（差 >1ms 返回 409 并附当前内容）→ 原文备份到 `vault/.trash/<相对路径>` → 按行改写 → vault 是 git 仓库时自动 commit → 失效缓存。所有写入必须用**相对路径**定位文件，不使用 `w1` 这类位置 id。

### 3.6 脚本、Skill 与部署

| 路径 | 职责 |
|---|---|
| `scripts/import-notes.mjs` | 一次性把 Markdown 笔记文件夹转成 `src/data/my-data.local.js`；只读不联网；`--reset` 切回示例 |
| `scripts/verify.mjs` | 校验 skill 格式、导入脚本、数据结构、星核/六星座代码仍在、页面无 `<video>`；`--release` 额外检查占位符 |
| `scripts/test-api.mjs` | 在临时 vault 上跑 note-api 端到端测试；`npm run test:api`，需要 Node 22.5+ 的 `node:sqlite` |
| `skills/neural-creator-dashboard/SKILL.md` | 可被 `npx skills add` 安装的通用 Agent Skill |
| `examples/vault/` | 虚构示例笔记库，演示 frontmatter 格式 |
| `deploy/docker-compose.dev.yml` | 开发版：只起 note-api 容器 |
| `docker-compose.yml` + `Dockerfile`（仓库根） | 部署版：note-api 单容器（多阶段构建自带前端，STATIC_DIR 自托管，登录页 + 会话 Cookie）；数据不出 NAS，无外网入口与多设备同步 |
| `docs/nas-deployment.md` | 极空间 NAS 部署全流程 |

---

## 4. 数据约定

### 4.1 vault 目录

```
notes-vault/
├── 00-AI热点/     ← 自动生成的日报（YYYY-MM-DD.md）
├── 02-作品库/     ← 已发布作品，frontmatter 写指标
├── 03-创作台/     ← 草稿
├── 04-选题池/     ← 选题
└── 05-方法库/     ← 方法笔记（可再分子目录）
```

分类按文件夹名自动识别（`vault.mjs` 的 `RULES`）：含「作品/works/published」→ 作品；「草稿/创作台/drafts」→ 草稿；「选题/ideas/灵感」→ 选题；「方法/methods/模板/流程/知识/card/notes」→ 方法笔记。「AI 热点」作为兜底规则放在最后。

### 4.2 常用 frontmatter

作品：`标题`、`发布时间`、`类型`（视频/图文）、`观看/views`、`点赞/likes`、`评论/comments`、`收藏/saves`、`涨粉/follows`、`分享/shares`、`曝光/impressions`、`封面点击率/ctr`、`平均观看时长/duration`、`tags`。数值支持 `1.2万`、`12.4%`、`21s` 写法。

选题：`platform`（小红书/B站/公众号/抖音）、`priority`（高/中/低）、`status`（待写/待扩展/已转草稿）、`note`。草稿：`source`（来源选题标题）。

方法笔记最少只要 `tags`；正文支持 `[[双链]]`。

> 作品节点的 `id` 是**按日期排序后的位置编号**（`w1`、`w2`…），不是持久标识；增删文件后编号会整体位移。这也是所有写操作使用相对路径的原因。

### 4.3 note-api 返回的 `/api/data` 形状

`snapshot / posts / postContent / notes / seedIdeas / seedDrafts / concepts`（与 sample.js 同形），外加 `files`（节点 id→路径）、`mtimes`（节点 id→文件 mtime，写回乐观锁基线）、`figures`（附件）、`settings`（月目标 / AI 模型，来自 `vault/.dashboard/settings.json`）、`semantic`（语义边）、`ai`（AI 能力信息）、`meta`（vault 路径、计数、生成时间）。

---

## 5. 操作指南（使用者视角）

### 5.1 工作台三层交互

1. **第一层**：星核居中、七个星团（作品库、概念网络、方法库、选题池、创作台、AI 热点、个人知识库）环绕游动。点星团 → 星核退到左侧，星团列队，星座线扇形展开到该模块每一篇内容。
2. **第二层**：点具体内容 → 右侧滑出分析栏：作品指标（观看/点赞/收藏率/涨粉等）、出链/反链/双向、话题、二度关联；方法笔记与作品可点「编辑正文」直接改 vault 文件。
3. **第三层**：`Esc` 或顶部面包屑逐层返回。

底部对话框「问你的图谱」用本地规则回答：最核心内容、双向连接、未创建笔记、下一篇写什么、孤立内容等，**不调用 AI**。

### 5.2 作品库 / 创作台 / 选题池

- 顶部导航或星团进入内页；每个内页顶部有星座轨，可一键回到工作台并展开对应星座。
- 创作台里改动自动保存：连着 note-api 时写入 NAS 上的 `.md`；断网时改动只在当前页面的内存 outbox 里，恢复网络后自动补传，刷新页面会丢失未落盘的离线改动（页面会提示）。
- 选题「转为草稿」会同时把选题状态写回 NAS，并生成一篇带来源标题的草稿，不模拟 AI 生成结果。

### 5.3 AI 能力（需服务端配置 AI key）

在分析栏的方法笔记面板中：

| 能力 | 接口 | 行为 |
|---|---|---|
| 打标签 + 摘要 | `POST /api/ai/analyze` | 按内容 hash 增量处理；结果写回笔记 frontmatter（`tags` 合并、`summary` 覆盖） |
| 语义关联 | `POST /api/ai/relate` | 生成 embedding、按余弦相似度出语义边，只存索引与内存缓存，不写文件 |
| 生成选题候选 | `POST /api/ai/ideas` | 用户勾选笔记作为输入，返回候选 |
| 问答（RAG） | `POST /api/ai/ask` | FTS 关键词召回 + 向量召回 → 拼上下文 → 回答，附引用路径 |

长任务异步执行：接口返回 `202 {job}`，前端轮询 `/api/ai/jobs/:id` 显示进度。未配置 key 时 AI 接口返回 501，前端自动隐藏 AI 区块。

### 5.4 AI 热点日报

- 默认源 `https://aihot.news/feed/all.xml`（可用 `NEWS_SOURCE` 替换任意 RSS 2.0）。
- 每小时检查一次：当天还没有日报且已过 `NEWS_HOUR`（默认 8 点）就拉取 → AI 汇总成日报 → 写 `00-AI热点/YYYY-MM-DD.md` 与 SQLite `news` 表 → 自动筛 3–5 个选题写进 `04-选题池/`（每天一次）。
- 前端可手动触发刷新（`/api/news/refresh`，`force` 覆盖当天）与筛选题预览（`/api/news/ideas`，`auto` 才落盘）。
- 需要 AI 才可用；`NEWS_CRON=0` 关闭定时。

---

## 6. 配置速查

### 6.1 服务端环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `VAULT_DIR` | 必填 | 笔记库目录 |
| `DATA_DIR` | `.note-api` | SQLite 索引（可删可重建）与**必须持久化**的运行时文件：`session.key`、`auth.json`（未设 `DASHBOARD_PASSWORD` 时生成的登录密码）、`ai-secrets.json`（AI key）、`platform-secrets.json`（公众号 Secret，0600）。看板配置在 `vault/.dashboard/settings.json` |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | 监听地址 |
| `STATIC_DIR` | 无 | 同时托管 `dist/`；静态资源由 note-api 自己鉴权后直出（镜像里没有 nginx） |
| `API_TOKEN` | 无 | 仅用于 curl / 脚本等非浏览器客户端；浏览器看板不携带，填了会导致看板请求 401。看板部署用登录页 + 会话 Cookie |
| `VAULT_GIT` | 开 | vault 是 git 仓库时每次写入自动 commit；`0` 关闭 |
| `MAX_BODY` | 2 MB | 请求体上限（字节）；compose 部署版设为 4 MB |
| `AI_PROTOCOL` | `openai` | 或 `anthropic` |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | DeepSeek | chat 网关与默认模型 |
| `AI_MODEL_ASK/ANALYZE/IDEAS/NEWS` | 回落 `AI_MODEL` | 任务级模型覆盖 |
| `EMBED_BASE_URL` / `EMBED_API_KEY` / `EMBED_MODEL` / `EMBED_PROTOCOL` | 跟随 chat | embedding（DeepSeek 无 embedding，需另配，如硅基流动 bge-m3）；Cloudflare 方案还需 `CF_ACCOUNT_ID` |
| `AI_TIMEOUT` / `AI_CONCURRENCY` | 60s / 4 | 单次 AI 调用超时（毫秒）与并发上限 |
| `NEWS_SOURCE` / `NEWS_HOUR` / `NEWS_CRON` | 见上 | 热点日报 |
| `NEWS_TZ_OFFSET` / `SYNC_TZ_OFFSET` | `8` | 日报与平台同步按哪个时区算「今天」（容器默认 UTC，必须设成 `8` 才是北京时间） |
| `DASHBOARD_USER` / `DASHBOARD_PASSWORD` | `admin` / 自动生成 | 登录账号；不设密码时启动生成随机密码写进 `AUTH_FILE` |
| `AUTH_FILE` | `<DATA_DIR>/auth.json` | 登录密码与 salt 的落盘位置，必须持久化 |
| `SESSION_DAYS` / `TRUST_PROXY` | `30` / 关 | 会话有效天数；前面有反向代理时才把 `TRUST_PROXY` 设为 `1`（否则限流按 socket 地址算） |
| `WECHAT_APPID` / `WECHAT_SECRET` | 无 | 公众号同步的兜底凭据（设置面板里填过则以面板为准） |
| `SYNC_HOUR` / `PLATFORM_SYNC_CRON` | `21` / 开 | 每天几点后自动同步；`PLATFORM_SYNC_CRON=0` 关闭 |
| `WEB_FETCH_TIMEOUT` / `WEB_FETCH_MAX_BYTES` | `20000` / 2 MB | 知识库剪藏的抓取超时与体积上限 |

### 6.2 前端变量

| 变量 | 说明 |
|---|---|
| `VITE_API_BASE` | 部署模式显式指定后端地址；不设则尝试同源 `/api/data` |
| `VITE_API_TIMEOUT` | 取数超时，默认 8000ms |
| `NOTE_API` | 仅供 `vite.config.js` 开发代理使用，默认 `http://127.0.0.1:8787` |

### 6.3 个性化

`src/config.js`：品牌名、工作台名、头像（`public/` 内）、页脚，以及仅用于清理旧版浏览器缓存的 `storagePrefix`。改动品牌后如需本地覆盖，可建 `src/config.local.js`（不提交）。业务数据不再写 localStorage。

---

## 7. API 路由一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查（免鉴权） |
| GET | `/api/data` | 全量数据（1.5s 缓存；`?fresh` 强制刷新），含 `files` / `mtimes` / `settings` |
| GET | `/api/version` | 轻量指纹（`v` / `files`），前端每 5 秒轮询用 |
| GET / PUT | `/api/settings` | 看板设置（`goal` 1–100、`aiModel`、`aiBaseUrl`、`platforms`、`syncHour`），存 `vault/.dashboard/settings.json`；Secret 与 AI key 只在 `DATA_DIR` |
| GET / POST | `/api/session`、`/api/login`、`/api/logout` | 登录态查询、登录（限流）、登出 |
| GET | `/api/auth-check` | 仅给显式反向代理做 `auth_request` 兼容判断 |
| POST | `/api/note-new` | 按标题新建笔记（带 `requestId` 时幂等） |
| GET | `/api/note?path=&id=` | 读取单篇原文、mtime、附件 |
| PUT | `/api/note` | 写正文 / frontmatter（`mtime` 乐观锁） |
| DELETE | `/api/note` | 删除（先备份到 `.trash/`） |
| PUT | `/api/idea`、`/api/draft` | 有 `path/id` 改现有，否则按标题新建 |
| GET | `/api/search?q=&limit=` | FTS 全文检索 |
| POST | `/api/index` | 重建索引 |
| GET | `/api/ai/info`、`/api/ai/models` | AI 能力与模型列表 |
| POST | `/api/ai/analyze` | 打标签 + 摘要 |
| POST | `/api/ai/relate` | 语义关联边 |
| POST | `/api/ai/ideas` | 从笔记生成选题候选 |
| POST | `/api/ai/ask` | RAG 问答 |
| GET | `/api/ai/jobs/:id` | 后台任务进度 |
| GET | `/api/news` / POST `/api/news/refresh` / POST `/api/news/ideas` | 日报查询、刷新、筛选题 |
| POST | `/api/publish` | 半自动发布回填（写入平台指标） |
| POST | `/api/attachment` | 上传附件到 `attachments/`，返回相对路径与新文件名 |
| GET | `/api/knowledge`、`/api/knowledge/snapshot` | 个人知识库列表与单条剪藏快照 |
| POST | `/api/platforms/pull` | 手动拉取平台指标（与 AI 任务共用互斥闸） |

---

## 8. 常见任务

**换成自己的数据（一次性快照）**

```bash
npm run import -- --vault "<笔记文件夹>" --account "<账号名>" --followers 1280
```

**本机接后端开发**

```bash
docker compose -f deploy/docker-compose.dev.yml up -d
```

```bash
npm run dev
```

**裸进程起后端**（不装 Docker）

```bash
VAULT_DIR=./examples/vault node server/index.mjs
```

Windows PowerShell 用 `$env:VAULT_DIR='.\examples\vault'; node server/index.mjs`。

**关闭热点定时**：`NEWS_CRON=0`；**关闭 vault git 提交**：`VAULT_GIT=0`。

**备份/Rollback**：写入前原文都在 `vault/.trash/<相对路径>`；vault 是 git 仓库时还有自动 commit。

---

## 9. 排障与注意事项

| 现象 | 原因与处理 |
|---|---|
| 浏览器里一直是旧示例选题/草稿 | 旧版 localStorage 已不再读取；部署模式启动成功后会清掉旧键。若仍显示只读横幅，说明 `/api/data` 没连上，检查 note-api 与代理 |
| 保存提示 409 冲突 | 文件被 Obsidian 或其他编辑器改过。看板不会覆盖；顶部横幅可「用我的版本覆盖」或「刷新载入 NAS 版本」 |
| 断网时的编辑刷新后消失 | 断网改动只存在当前页面的内存 outbox（不写 localStorage），恢复网络会自动补传；刷新/关页前页面会提示 |
| 页面白屏、星核与星团消失 | 检查动画循环是否保持「先排帧、再 try 执行本帧」；控制台是否有异常 |
| AI 区块不出现 | 服务端未配 `AI_API_KEY`，接口返回 501 属预期 |
| 语义关联不可用 | 未配 `EMBED_MODEL` / `EMBED_API_KEY`（DeepSeek 不提供 embedding） |
| 热点日报不生成 | 需要 AI key；当天已生成过；未到 `NEWS_HOUR`；`NEWS_CRON=0` |
| 容器里 SQLite 报 disk I/O error | Docker Desktop 挂载卷的已知问题，compose 已用命名卷规避；见 `db.mjs` 头部注释 |
| 构建产物里有私人数据 | `.gitignore` 只保护源码。公开部署前 `npm run import -- --reset`，并确认无 `config.local.js` |

开发红线（`npm run verify` 会检查）：星核与六星座动效不能删/隐藏/改成静态图；不新增图片或视频素材；`src/data/my-data.local.js` 与示例内容不能混用真实信息；保持 `prefers-reduced-motion` 与中英双语。

---

## 10. 修改后的验证

```bash
npm run verify
```

```bash
npm run build
```

```bash
npm run test:api
```

再跑 `npm run dev` 打开页面，确认：星核与七个星座出现、星穹背景缓慢流动；点「作品库」星团星座线展开到每篇内容；点一篇右侧弹出分析栏；五个内页正常；控制台无报错。

涉及 note-api 的改动，`npm run test:api` 已覆盖 `/api/data` 形状、正常写入、409、settings 与删除备份；再按需用示例库手工确认 AI 与热点日报。
