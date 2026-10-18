# Neural Creator Dashboard · 创作神经网络看板

[![Release 发布包下载次数](https://img.shields.io/github/downloads/linye-ai/neural-creator-dashboard/total?label=Release%20downloads)](https://github.com/linye-ai/neural-creator-dashboard/releases)

**[下载最新版完整源码与 Skill 包 ZIP](https://github.com/linye-ai/neural-creator-dashboard/releases/latest/download/neural-creator-dashboard.zip)** · [查看版本与附件](https://github.com/linye-ai/neural-creator-dashboard/releases/latest)

**[在线演示 Live Demo →](https://linye-ai.github.io/neural-creator-dashboard/)** —— 打开即用的可交互看板，数据全部为虚构示例，无需安装。

下载后解压，进入 `neural-creator-dashboard` 文件夹，按下方「快速开始」安装依赖并运行。这是源码与 Skill 包，不是免安装的桌面软件。

下载统计来自 GitHub Release 附件的 `download_count`，累计范围为此仓库所有 Release 附件；不包含普通 `Code → Download ZIP`、`git clone`、`npx skills add` 或网盘转发。重复下载与维护者测试下载也可能计入，不等于人数或成功安装数，徽章可能有缓存延迟。当前只提供一个 ZIP 附件，后续统计时应区分不同附件，避免把校验文件下载当成软件安装数。


> **使用许可：MIT 开源许可，免费使用。** 详见 [LICENSE](LICENSE)。

把你的作品、笔记、选题和草稿，变成一张会呼吸的神经网络：中心是一颗星核，七簇发光的星团代表七个模块（含 AI 热点与个人知识库），点开星团，金色星座线像伞一样展开到每一篇内容；点开一篇，右侧弹出它的全部数据和双向链接。

Turn your works, notes, ideas and drafts into a living neural network — a star core, six glowing clusters, constellation lines spreading to every piece, and a full analysis panel for each one.

> 仓库里的账号、作品、笔记、选题、草稿**全部是虚构的示例数据**。

## 它能做什么

- **工作台**：星核点亮、日冕呼吸，背景星穹从星核蔓延开，七簇星团（作品库、概念网络、方法库、选题池、创作台、AI 热点、个人知识库）围绕星核游动。
- **三层交互**：点星团 → 星核退到左侧、七簇列队，星座线扇形展开到该模块的每一篇内容；点内容 → 右侧滑出分析栏（指标、收藏率、出链 / 反链 / 双向、话题、二度关联）；Esc 或面包屑逐层返回。
- **问你的图谱**：底部对话框可以问「最核心的内容」「双向连接有哪些」「下一篇写什么」「未创建的笔记」，按本地规则检索，不调用 AI；部署模式配好 AI key 后，分析栏另有 AI 问答、打标签与语义关联。
- **作品库 / 创作台 / 选题池**三个内页：作品卡片与排序、草稿编辑（支持 `[[` 双链补全）、选题转草稿，每个内页顶部带一条星座轨。
- **深空配色**：深空蓝紫底、金色星座线、星核与星云由代码逐帧自绘，颜色集中在 `src/neural/theme.js` 和 `neural.css` 顶部的 CSS 变量里。
- **中英双语**界面，尊重系统的「减少动态效果」设置。
- 纯静态模式只读；连接 note-api（NAS 部署）后，选题、草稿与月目标全部写入 NAS，浏览器不保存业务数据。

> 各模块的职责、数据流、API 与配置速查，见 **[模块与使用指导手册](docs/guide.md)**。

## 快速开始

需要 Node.js 20.19+ 或 22.12+。

```bash
git clone https://github.com/linye-ai/neural-creator-dashboard.git
cd neural-creator-dashboard
npm install
npm run dev
```

打开终端里显示的地址（默认 http://127.0.0.1:5173/ ）。

不启动 note-api 时是**纯静态只读模式**：页面的选题、草稿与目标不能编辑。需要在线编辑并写回 NAS，见 **[NAS 部署说明](docs/nas-deployment.md)**（`docker-compose.dev.yml` + `npm run dev` 也可在本机接后端）。

## 让你的 AI 智能体来装（Claude、Codex、Kimi、Cursor……）

仓库自带一个通用格式的 skill（`skills/neural-creator-dashboard/SKILL.md`），一条命令装到你电脑上的智能体：

```bash
npx skills add linye-ai/neural-creator-dashboard
```

装好后对智能体说：

> 用 neural-creator-dashboard 这个 skill，把我的笔记做成神经网络看板，笔记在 <你的笔记文件夹>。

也可以手动安装：把 `skills/neural-creator-dashboard` 整个文件夹复制到对应目录。

| 智能体 | 全局目录 | 项目内目录 |
|---|---|---|
| Claude Code | `~/.claude/skills/` | `.claude/skills/` |
| Codex | `~/.codex/skills/` | `.agents/skills/` |
| Kimi Code CLI | `~/.agents/skills/` | `.agents/skills/` |
| Cursor | `~/.cursor/skills/` | `.agents/skills/` |
| Gemini CLI | `~/.gemini/skills/` | `.agents/skills/` |
| Qwen Code | `~/.qwen/skills/` | `.qwen/skills/` |

不支持 skill 的智能体，直接对它说：

> 克隆 https://github.com/linye-ai/neural-creator-dashboard ，按仓库里的 AGENTS.md 帮我装好，并导入我的笔记。

## 换成你自己的数据

### 方式一：导入 Obsidian / Markdown 笔记（推荐）

```bash
npm run import -- --vault "<你的笔记文件夹>" --account "<账号名>" --followers 1280
```

- 按文件夹名自动识别：名字含「作品 / works」的是作品，「方法 / 模板 / 流程 / methods」的是方法笔记，「选题 / ideas」的是选题，「草稿 / 创作台 / drafts」的是草稿；也可以用 `--works`、`--methods`、`--ideas`、`--drafts` 指定文件夹。
- 作品数据写在 frontmatter 里，中英文字段都认（`观看/views`、`收藏/saves`、`点赞/likes`、`发布时间/date`、`类型/media`……），支持「1.2万」「12.4%」这类写法。
- 正文的 `[[双链]]` 自动连线；同一个话题标签出现在两条以上内容里，会成为「概念」节点。
- AI 热点日报（`00-AI热点/YYYY-MM-DD.md`）会作为 `kind: 'news'` 的内容进入图谱；自动生成的选题在 frontmatter 里写 `sourceNews`，图谱据此把选题连回当天日报。
- 方法笔记和作品各自的概念、话题会自动桥接：同名概念连一条「同名概念」边，共享话题共用同一个话题节点。
- 格式参考 `examples/vault/`，可以先 `npm run import -- --vault examples/vault` 试试。
- 导入结果写到 `src/data/my-data.local.js`（已在 `.gitignore`，不会被提交，看板会自动优先读它；代码里不动任何被跟踪的文件）；`npm run import -- --reset` 删掉本机数据、切回示例；`npm run import -- --help` 查看全部选项。
- 导入脚本只读你的笔记、不联网。

### 方式二：手动改数据

1. **`src/config.js`**：品牌名、图谱中心的名字、头像（放进 `public/`）、页脚文字。
2. **`src/data/sample.js`**（或你自己的 `src/data/my-data.local.js`）：所有内容数据，字段如下。

| 导出 | 内容 | 关键字段 |
|---|---|---|
| `snapshot` | 账号概况 | `account` 账号名、`followers` 粉丝数、`capturedAt` 数据日期、`source` 来源说明 |
| `posts` / `postContent` | 作品（由 `W(...)` 一次写出） | 指标：`views` `likes` `comments` `saves` `follows` `shares` `impressions` `ctr` `duration`，缺失填 `null`；内容：`body` 正文、`tags` 话题、`media`（`images` / `video`） |
| `notes` | 方法库笔记与 AI 热点日报 | `title`、`path`（方法笔记第二段是子目录；日报为 `00-AI热点/YYYY-MM-DD.md` 并带 `kind: 'news'`）、`body`（可以写 `[[双链]]`）、`tags`（可选） |
| `seedIdeas` | 选题池 | `title`、`priority`（高 / 中 / 低）、`status`（待写 / 待扩展 / 已转草稿）、`note`、`sourceNews`（可选，来源日报日期） |
| `seedDrafts` | 创作台草稿 | `title`、`body`、`source`（来源选题的 id） |
| `concepts` | 概念词表 | `[概念名, [关键词…]]`，换成你所在领域的词 |
| `semantic` | AI 语义边（仅部署模式） | `{a, b, sim}`，由 `/api/ai/relate` 生成并持久化 |

改完刷新页面即可。旧版浏览器里保存过的选题/草稿/目标不会再被读取；连接 NAS 后启动时会自动清掉这些旧键。

## 图谱是怎么连起来的

全部在浏览器里由数据推导（见 `src/neural/graph.js`）：

| 连接 | 规则 |
|---|---|
| 目录归属 | 内容属于哪个模块 / 子目录 |
| `[[双链]]` | 笔记与草稿正文里的双链；找不到对应内容的显示为「未创建」 |
| 选题来源 | 草稿记录了来源选题；选题状态为「已转草稿」时反向也成立；缺 `source` 时按同名标题自动回连 |
| 发布为作品 | 草稿与作品标题相同（忽略编号和 Obsidian 前缀）即自动相连 |
| 热点依据 | 选题的 `sourceNews` 指向当天 AI 热点日报；日报也会参与概念提及与共振 |
| 话题标签 | 作品、方法笔记、选题、草稿、日报的 frontmatter `tags` 与正文 `#话题` |
| 正文提及 | 正文出现概念词；至少两条内容提及，才成为概念节点 |
| 双向共振 | 两条内容共同提及 ≥ 2 个概念 |

## 目录结构

```
├── index.html                 页面入口
├── AGENTS.md                  写给 AI 智能体的开发说明（CLAUDE.md 指向它）
├── skills/neural-creator-dashboard/SKILL.md   通用 Agent Skill
├── scripts/import-notes.mjs   笔记导入；scripts/verify.mjs 校验（npm run verify）
├── examples/vault/            虚构的示例笔记库
├── server/                    note-api（读写 vault、AI 编排、索引）
├── deploy/                    NAS 部署用 compose / nginx 配置
├── docs/                      部署、使用指南与架构说明
├── public/avatar.svg          头像（抽象图形）
├── src/config.js              个性化配置
├── src/data/index.js          数据入口（示例 / 你的数据 / note-api）
├── src/data/sample.js         示例数据（虚构）
└── src/neural/
    ├── graph.js               图谱推导、布局、本地检索
    ├── Home.jsx               星核、七簇星团、星座线与三层交互
    ├── Cosmos.jsx             星穹背景（星云、星尘、流星）
    ├── StarCore.jsx           星核渲染
    ├── v41.js                 星核渲染参数
    ├── constellations.js      七个星座的真实星表骨架
    ├── ConstellationBand.jsx  内页星座轨
    ├── NetworkCanvas.jsx      背景神经网络
    ├── Analysis.jsx           右侧分析栏
    ├── pages.jsx              作品库 / 创作台 / 选题池
    ├── persist.js             NAS 持久化（防抖、mtime、内存重试、冲突）
    ├── SaveStatus.jsx         保存状态徽标与同步横幅
    ├── main.jsx               页面框架与弹窗
    ├── theme.js               配色与素材路径
    └── neural.css             样式
```

## 部署

```bash
npm run build
```

公开部署前请运行 `npm run import -- --reset`（会删掉 `src/data/my-data.local.js`），并确认没有留下本机的 `src/config.local.js`。构建产物里打包的是构建当时生效的那份数据与配置：`.gitignore` 只阻止源码提交，不能阻止个人数据被打包进网页，导入私人笔记后的构建产物不可直接公开。

`dist/` 是纯静态文件，可以放到任何静态托管（GitHub Pages、Vercel、Netlify、Cloudflare Pages 等）。构建使用相对路径，部署在子路径下也能正常加载。纯静态页面只读；需要在线编辑选题/草稿/目标时，按 **[NAS 部署说明](docs/nas-deployment.md)** 启动 note-api，数据会实时写入 vault 与 `vault/.dashboard/settings.json`。NAS 部署模式带独立的登录页与会话 Cookie，未登录访问会先跳到 `login.html`。

## 关于素材

- 星核、七簇星团与星穹背景**全部由代码在 Canvas 上逐帧自绘**，页面里没有任何图片或视频素材文件，`npm run verify` 会校验这一点。
- 七个星座的星位取自真实星表（J2000 赤经 / 赤纬 + 经典连线），见 `src/neural/constellations.js`；第六个是 AI 热点（仙女座），部署模式下由 note-api 每天生成日报；第七个是个人知识库（猎户座），存灵感、公司制度与网页剪藏（部署模式下可粘贴链接自动抓取快照并让 AI 分析）。
- **AI 助手**：创作台与知识库页的浮动抽屉——上传 `md / txt / docx / pdf`（≤4 MB）自动提取文本存进个人知识库（docx 内置 zip 解析、PDF 用 pdfjs-dist），并可对全库提问（部署模式配 AI key 走 RAG 带引用，否则本地规则检索）。
- 仓库里唯一的静态图片素材是头像 `public/avatar.svg`，它是抽象图形。示例数据全部虚构，与任何真实账号无关。

## 它是怎么做出来的

这个界面是用 Claude 一轮一轮对话写出来的，没有一句「万能提示词」。思路很简单：

1. **以原来的看板为起点**：先有一个能用的数据看板和自己的素材，让 AI 在它上面改，而不是从零生成。
2. **先说清楚交互**：星核连着几个模块，点模块展开内容，点内容出现分析。
3. **看一次效果，提一个具体意见**：比如「星核外围再柔和一点」「星团和右侧栏离太远了」，改了十几轮。
4. **让 AI 自己打开浏览器检查**，确认效果对了再进入下一轮。

## 许可

- 本项目采用 **MIT 开源许可**——可以自由使用、修改、分发（包括商业用途），详见 [LICENSE](LICENSE)。
- 依赖（React、Vite 等）保持各自的许可与声明，本项目不改变它们的授权。
- 示例数据全部虚构；用户导入的笔记不因导入而改变原有权利归属。

## License

[MIT](LICENSE)
