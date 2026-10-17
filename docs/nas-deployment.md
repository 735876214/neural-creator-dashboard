# 在极空间 NAS 上部署：看板 + 笔记库 + AI

这套部署把你的 Obsidian 笔记库变成看板的数据源：看板在浏览器里打开就是最新内容，可以轻编辑（改动直接写回 `.md` 文件），AI 负责打标签、摘要、语义关联和问答。

```
极空间 NAS（Docker）
├── notes-vault/          明文 .md —— Obsidian 和看板共用，唯一真相
├── note-api              读写笔记 + AI 编排 + 索引（本仓库 server/）
├── web (nginx)           托管看板 + Basic Auth
├── syncthing             把 vault 同步到桌面 / 手机 Obsidian
└── tailscale             外网访问（不开放公网端口）
```

## 0. 前置条件

- 极空间有 Container Manager（Docker）功能
- 一台能跑 `npm run build` 的电脑（Node.js 20.19+ / 22.12+）
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

## 2. 构建前端并上传

在本机：

```bash
git clone <这个仓库> && cd neural-creator-dashboard
npm install
npm run build          # 产物在 dist/
```

把整个项目（含 `dist/`）传到 NAS，比如放在 `docker/neural-dashboard/`。

## 3. 起 Docker Compose

```bash
cd deploy
cp .env.example .env       # 填 AI_API_KEY 等（不填也能用，只是没有 AI 区块）
htpasswd -bc .htpasswd 你的用户名   # 没有 htpasswd 工具就用在线生成器
docker compose up -d
```

> 极空间的 Container Manager 也可以图形化导入这个 compose 文件。

浏览器打开 `http://<NAS-IP>:8088`，输入刚设的 Basic Auth 密码，星核亮起来就是成功了。

## 4. 多端同步（Syncthing）

1. 打开 Syncthing 管理界面（NAS 上 `127.0.0.1:8384`，用 SSH 隧道或在 Tailscale 网络里访问）；
2. 添加共享文件夹，路径 `/var/syncthing/vault`，这就是 NAS 侧的 vault；
3. 桌面 / 手机的 Syncthing 客户端扫码配对，指向你的 Obsidian vault 本地目录；
4. Obsidian 打开这个 vault，正常写、正常贴图——图片存在 vault 里，看板会识别并显示「N 张图」角标。

**注意**：看板和 Obsidian 写的是同一批文件。看板的写入带冲突检测（mtime 不一致返回 409，不覆盖），但偶尔仍可能在 Syncthing 里出现 `.sync-conflict-` 文件——那是双端几乎同时写入的漏网信号，定期看一眼即可。

## 5. 外网访问（Tailscale）

compose 里带了 tailscale 容器：`.env` 里填 `TS_AUTHKEY`（在 [login.tailscale.com/admin/authkeys](https://login.tailscale.com/admin/authkeys) 生成），`docker compose up -d` 后设备自动入网。手机 / 电脑装 Tailscale 客户端登录同一账号，浏览器访问 NAS 的 Tailscale IP 或主机名即可。

不想用 Tailscale 的替代：Cloudflare Tunnel + Access（需要域名，自带登录）；极空间自带的远程访问功能能否转发 Docker 容器端口、是否有认证，请在你的 ZOS 版本上确认后再用——**笔记是明文，没有任何认证的公网暴露绝对不行**。

## 6. AI 功能（可选）

`.env` 里填：

| 变量 | 用途 | 说明 |
|---|---|---|
| `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL` | 打标签 + 摘要、选题生成、问答、热点日报 | 默认 DeepSeek；通义 / Kimi / 硅基流动 / 自建 OpenAI 兼容网关都行 |
| `AI_MODEL_ASK` / `AI_MODEL_ANALYZE` / `AI_MODEL_IDEAS` / `AI_MODEL_NEWS` | 各任务的默认模型 | 缺省回落 `AI_MODEL`；前端对话框里也可随时手动切换（记在浏览器） |
| `EMBED_*` | 语义关联、向量检索 | 两种方案见 `.env.example`：Cloudflare Workers AI（每天免费 10,000 Neurons）或 OpenAI 兼容接口 |

配置后重启 `note-api`，每篇方法笔记的分析栏会出现「AI 分析」区块：

- **打标签 + 摘要**：写回笔记 frontmatter 的 `tags` 和 `summary`（按内容 hash 增量，没改过的笔记不重算、不花 token）；
- **语义关联**：算 embedding 存索引，相似度超阈值的笔记对在分析栏里互相关联（不写文件，随时可重算）；
- **生成选题**：把候选写进 `04-选题池/`；
- **问答**：底部对话框的提问会检索你的笔记再回答，答案带引用、可点跳转。对话框旁的模型下拉可以换模型（拉不到列表时隐藏，走服务端默认）。

> **模型质量提示**：多模型网关上部分模型实测存在响应质量问题（返回无关内容或纯思考无输出）。建议用 glm / deepseek 系；思考型模型在列表里标了「（思考型）」，问答可用但较慢。

## 6.5 AI 热点（第六星座）

首页多出的一簇「AI 热点」每天自动生成一份日报：

- 数据源是现成的公开 RSS（默认 [AIHOT 全部 AI 动态](https://aihot.news/all)，`NEWS_SOURCE` 可换成任何 RSS 2.0 源）；
- AI 把最近 48 小时的条目汇总成一段综述 + 主题分组，写进 `notes-vault/00-AI热点/YYYY-MM-DD.md`——自动出现在图谱的仙女座（粉色那簇）里，点开就是阅读窗；
- 每小时整点检查（当天过了 `NEWS_HOUR` 默认 8 点还没生成就补），`POST /api/news/refresh` 手动触发，`{"force": true}` 强制重做当天；
- `NEWS_CRON=0` 关闭整个定时任务。

## 7. 日常使用

- **Obsidian 里写**（长文、图片、整理），等 Syncthing 同步，看板刷新即见；
- **看板里速记**：新建草稿 / 改选题，直接落成 NAS 上的 `.md`，Obsidian 端同步后就能看到；
- **备份**：vault 建议 `git init` 一次（note-api 每次写入自动 commit，AI 误写可回滚）+ 极空间自身的快照。`index.sqlite` 是索引，删了会自动重建，不用备份。

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| 页面显示「正在读取笔记库…」不动 | note-api 没起来：`docker compose logs note-api`；常见是 VAULT_DIR 挂载路径不对 |
| 保存提示「文件已被其他编辑器改动」 | Obsidian 或另一台设备刚改过这篇。看板没有覆盖，重新打开比对后再存 |
| 作品库是空的 | 还没有作品笔记——正常现象；或目录名不含「作品 / works」，用导入脚本时 `--works` 指定 |
| AI 区块不出现 | 服务端没配 `AI_API_KEY`，或配完没重启 note-api |
| 语义关联按钮报「embedding 未启用」 | 只配了 DeepSeek（它没有 embedding 接口），补配 `EMBED_*` 三项 |
| Syncthing 出现 `.sync-conflict-` 文件 | 双端同时写过同一个文件，内容都保留了，手工合并后删掉冲突副本 |
| 星座 / 星核不动了 | 浏览器开了「减少动态效果」；这是无障碍特性，不是故障 |
