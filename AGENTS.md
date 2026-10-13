# AGENTS.md

写给在这个仓库里工作的 AI 智能体（Codex、Kimi、Cursor、Claude Code 等）。

## 项目

创作神经网络看板：React 19 + Vite 7 的纯前端页面，把作品、方法笔记、选题、草稿推导成一张神经网络图谱。不联网、不调用 AI，用户数据只在本地。

## 命令

| 命令 | 作用 |
|---|---|
| `npm install` | 安装依赖（需要 Node.js 20.19+ 或 22.12+） |
| `npm run dev` | 开发服务器，默认 http://127.0.0.1:5173/ |
| `npm run build` | 构建静态文件到 `dist/` |
| `npm run import -- --vault <笔记文件夹>` | 把 Markdown / Obsidian 笔记导入成 `src/data/my-data.local.js`（在 `.gitignore` 里，不入库）；`--help` 查看选项，`--reset` 删除本机数据、切回示例 |
| `npm run verify` | 校验 skill 格式、导入脚本、当前数据结构与核心动效（星核、五片星座、零视频素材） |

## 结构

- `index.html`：页面入口，加载 `src/neural/main.jsx`。
- `src/neural/theme.js`、`neural.css` 顶部的 CSS 变量：配色（深空蓝紫底 + 金色星座线，只有一套深空配色）。
- `src/config.js`：品牌、头像、页脚、localStorage 前缀。
- `src/data/index.js`：数据入口。本机存在 `src/data/my-data.local.js` 时优先用它，否则用 `./sample.js`；改数据不用动这个文件。
- `src/data/sample.js`：虚构示例数据，也是数据字段的权威说明。
- `src/neural/graph.js`：图谱推导（目录归属、双链、选题来源、话题、概念提及、双向共振）、布局和本地检索。
- `src/neural/Home.jsx`：星核、五簇星团与三层交互；`Cosmos.jsx` 星穹背景；`StarCore.jsx` / `v41.js` 星核渲染；`constellations.js` 五个星座的真实星表骨架；`ConstellationBand.jsx` 内页星座轨；`NetworkCanvas.jsx` 背景星图；`Analysis.jsx` 分析栏；`pages.jsx` 三个内页。
- `scripts/import-notes.mjs`：笔记导入；`scripts/verify.mjs`：校验。
- `skills/neural-creator-dashboard/SKILL.md`：通用 Agent Skill，可用 `npx skills add` 安装到各家智能体。
- `examples/vault/`：虚构的示例笔记库，演示导入格式。

## 数据字段（`src/data/*.js` 的导出）

- `snapshot`：`account`、`followers`、`capturedAt`、`publishedFrom`、`publishedTo`、`source`
- `posts`：`id`、`title`、`date`（`YYYY-MM-DD HH:mm`）、`views`（数字，缺失写 0）、`likes`、`comments`、`saves`、`shares`、`follows`、`impressions`、`ctr`、`duration`（缺失写 `null`）
- `postContent`：与 `posts` 按 `title` 对应，`body`、`tags`、`media`（`images` / `video`）
- `notes`：`id`、`title`、`path`（形如 `05-方法库 methods/<子目录>/<文件名>.md`）、`body`
- `seedIdeas`：`id`（数字）、`title`、`platform`、`priority`（高 / 中 / 低）、`status`（待写 / 待扩展 / 已转草稿）、`note`
- `seedDrafts`：`id`、`title`、`body`、`source`（来源选题 id 或 `null`）
- `concepts`：`[概念名, [关键词…]]`

## 规矩

- **星核（画面上正中的发光核心）和五片星团是核心动效，不能删除、隐藏或改成静态图片。** 全部画面由代码在 Canvas 上逐帧自绘，页面里没有任何图片或视频素材：星核在 `src/neural/StarCore.jsx`（参数在 `v41.js`），星团层是 `src/neural/constellations.js` 的真实星座骨架，逐帧动画在 `Home.jsx` 的 `step()`。`npm run verify` 会检查它们还在。
- 五片星团是五个真实星座（J2000 赤经 / 赤纬 + 经典连线，取自 d3-celestial），映射固定：方法库→天蝎、概念网络→双鱼、作品库→处女、选题池→射手、创作台→水瓶。不要自创连线、不要换成随机星点或图标。
- 动画循环必须保持「先排下一帧、再在 try 里执行本帧」的写法，时间差 `dt` 不能为负：否则某一帧出错就会让星核和星团停在隐形状态（刷新后消失）。
- **不要再引入视频或图片素材。** reskin v0 起星核、星团、星云全部代码自绘，`public/` 只剩头像 `avatar.svg`（抽象图形）；`npm run verify` 会检查页面里没有 `<video>`。
- `src/data/my-data.local.js` 含用户个人笔记，已在 `.gitignore`；不要提交、不要写进示例或文档。
- `src/data/sample.js` 与 `examples/vault/` 只能放虚构内容。
- 不要加入联网请求、统计脚本或 AI 调用。
- 保持「减少动态效果」支持（`prefers-reduced-motion`）和中英双语文案。

## 改完之后的验证

1. `npm run verify` 和 `npm run build` 通过。
2. `npm run dev` 打开页面，确认：首页星核和五片星座出现、星穹背景在缓慢流动；点「作品库」星团，星座线展开到每一篇内容；点一篇内容右侧弹出分析栏；三个内页（作品库 / 创作台 / 选题池）正常；浏览器控制台没有报错。
