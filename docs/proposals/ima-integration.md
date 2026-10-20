# 通过 IMA 官方 OpenAPI 获取知识库的可行性评估报告

> 评估对象：neural-creator-dashboard（v0.7.0，七星座图谱 + note-api 部署模式）
> 评估日期：2026-10-19（v1）；2026-10-20 复核（v2：新增 §十「双向同步专项评估」，结论见 §一 末段）
> 评估范围：以腾讯 ima（ima.copilot）为知识来源，把知识库内容取回并落入看板「个人知识库」（`06-个人知识库/`）；含反向写入与检索替代的可行性判断，以及「查看文件 / AI 检索 / 编辑回写」三项双向同步诉求的逐条判定

---

## 一、结论

**可行，评级「中高」：建议按「只读镜像」接入，不做全库保真同步，也不建议用它替换本地 RAG。**

关键事实：ima 提供**官方 OpenAPI**（`https://ima.qq.com/agent-interface` 领取 Client ID / API Key），接口覆盖知识库遍历、条目元信息、原文访问、笔记读写与上传。上一轮「只能问答、拿不到原文」的判断已作废。

三个方向的可行性：

| 方向 | 结论 | 说明 |
|---|---|---|
| ima 知识库 → 看板（只读镜像） | ✅ **中高**，建议 P1 | 网页 / 公众号 / 笔记三类可拉全文；文件类可下原件；订阅与公共库保真度低 |
| 看板 → ima（剪藏、笔记回写） | ✅ **高**，可顺带做 | `import_doc`（新建）/ `append_doc`（追加）实测可用；`update_note` 实测为**块级补丁**（需 block_id），不能整篇覆盖（§11.2） |
| 用 ima 检索替代本地 RAG | ⚠️ **实测**：`openapi/rag/v1/search` 可用，但只覆盖**公开知识库** | 返回原文 chunk（含 markdown 片段），但拿不到自己库的内容；`search_knowledge` 实测 `highlight_content` 为空串 |

**v2 复核后的双向同步结论（详见 §十）：**

| 诉求 | 判定 | 依据 |
|---|---|---|
| 看板查看 ima 库里的文件 | ✅ **可行** | `get_knowledge_list` → `get_media_info` → `url_info.url` 下载原件；经同源代理预览 |
| 通过 AI 检索 ima 库内容 | ❌ 自己库无官方检索 / ✅ 公开库有 | `rag/v1/search` 实测只命中公开共享知识库；自己库的 `search_knowledge` 无片段 → 仍需镜像后本地 RAG（§11.2） |
| 看板编辑内容同步回 ima | ⚠️ 只能新建/追加 | `import_doc` 新建、`append_doc` 追加实测成功；`update_note` 是块级补丁（block_id 不可得）；知识库条目**无更新、无删除** |

真正的约束不在接口能力，而在四点：**知识库条目没有 `modify_time`（增量只能靠本地 diff）、频控（`110021`）、`media_type=11` 只返回纯文本、订阅库/公共库只给 300 字预览或 AI 摘要**。

---

## 二、事实核查

### 2.1 官方通道（证据链）

| 证据 | 内容 |
|---|---|
| 控制台 | `https://ima.qq.com/agent-interface`，页面标题「ima claw配置」，登录后展示 Client ID 与 API Key |
| 官方 Skill 包 | `https://app-dl.ima.qq.com/skills/ima-skills-1.1.10.zip`（`meta.json` 版本 `1.1.10`，要求 Node ≥ 18） |
| 包内文档 | `knowledge-base/references/api.md`（598 行）、`notes/references/api.md`（365 行），含完整字段、分页、错误码、大小限制 |
| 分发与文档 | `https://skillhub.tencent.com/skills/ima-skills`、`https://wiki.ima.qq.com` |

接口形态：

| 项 | 值 |
|---|---|
| Base URL | `https://ima.qq.com` |
| 路径 | 知识库 `/openapi/wiki/v1/*`，笔记 `/openapi/note/v1/*` |
| 协议 | HTTP POST + JSON body |
| 鉴权 | Header `ima-openapi-clientid`、`ima-openapi-apikey`（Skill 客户端还带 `ima-openapi-ctx: skill_version=…`） |
| 统一返回 | `{code, msg, data}`，`code=0` 为成功，非 0 时直接展示 `msg` |

### 2.2 能力清单

知识库（`/openapi/wiki/v1`）：

| 接口 | 用途 | 关键限制 |
|---|---|---|
| `get_addable_knowledge_base_list` | 列出有写权限的库 | `cursor` + `limit` 1–50 |
| `search_knowledge_base` | 按名称找库 | `limit` 1–20 |
| `get_knowledge_base` | 库信息 | `ids` 1–20 个 |
| `get_knowledge_list` | 浏览/遍历条目 | `cursor` + `limit` 1–50 + `folder_id`；返回 `current_path` |
| `search_knowledge` | 关键词检索条目 | 返回 `media_id / title / parent_folder_id / highlight_content` |
| `get_media_info` | 取原文入口 | 返回 `url_info.url` + `url_info.headers`；`media_type=11` 时返 `notebook_ext_info.notebook_id` |
| `create_media` → COS → `add_knowledge` | 上传文件入库 | 需三步；COS 用临时凭证 |
| `import_urls` | 网页/公众号入库 | 1–10 个 URL，服务端自动识别类型 |
| `check_repeated_names` | 上传前查重 | 1–2000 条 |

笔记（`/openapi/note/v1`）：

| 接口 | 用途 | 关键限制 |
|---|---|---|
| `list_notebook` | 笔记本列表 | — |
| `list_note` | 列出笔记 | `limit` ≤ 20，可按 `MODIFY_TIME` 排序，有 `is_end` |
| `search_note` | 检索笔记 | `start/end` 差值 ≤ 20；`search_type` 0=标题 / 1=正文 |
| `get_doc_content` | 读正文 | `target_content_format` 仅 `0`（纯文本）可用，`1`（Markdown）**不支持** |
| `import_doc` | 新建笔记 | 只接受 Markdown |
| `append_doc` | 追加内容 | — |

媒体类型（`media_type`）：1 PDF、2 网页、3 Word、4 PPT、5 Excel、6 微信公众号、7 Markdown、9 图片、11 笔记、12 AI 会话、13 TXT、14 Xmind、15 录音、16 视频解析（**不支持** API 添加）、20 HTML、21 EPUB。

大小上限：Excel/TXT/Xmind/Markdown/HTML **10 MB**；图片 **30 MB**；EPUB **50 MB**；PDF/Word/PPT/音频及其他 **200 MB**；音频 ≤ 2 小时；网页与笔记不限。

根目录约定：`folder_id` 省略即根目录，**根的 `folder_id` 等于 `knowledge_base_id`**（`import_urls` 必填时传库 ID）。

### 2.3 本机实测：本地没有正文缓存

- `/Applications/ima.copilot.app` 已安装；
- `~/Library/Application Support/com.tencent.imamac` 共 586 MB，其中 `Default/Extensions` 249 MB、`Default/Service Worker` 11 MB，属 Chromium 运行时缓存；
- `Default/IndexedDB` 下只有 `https_mp.weixin.qq.com`、`https_dxr9qmoialm.feishu.cn` 与两个扩展源，**没有 `ima.qq.com` 的库**，也没有任何正文数据库。

结论：知识库正文只在云端，无法从本地缓存离线抽取——必须走 OpenAPI，这也正好排除了「读本地目录」这种脆弱的旁路。

### 2.4 社区旁证（说明工程边界真实存在）

| 项目 | 做法 | 对本评估的意义 |
|---|---|---|
| `chenxiccc/obsidian-ima.copilot-sync` | Obsidian 插件，IMA → vault 单向同步，用 OpenAPI 的 Client ID / API Key | 说明「拉取到 Markdown」已有成熟先例，可直接对照其限制清单 |
| `RangoLabWorks/ima-copilot-auto-sync` | 五层架构，Notes API 取清单 + GUI 自动化下载，专门绕过知识库接口限额 | 侧面印证频控是真实痛点，且清单类接口比内容类接口宽松 |
| `onclaw-dev/dsh-ima-copilot`、`highkay/tencent-ima-copilot-mcp` | 逆向 `x-ima-cookie` + `x-ima-bkn`，只实现 `/cgi-bin/assistant/qa` 问答 | 官方 OpenAPI 出现后，这条路线**不再需要**（凭证更重、能力更弱） |

社区项目记录过「知识库接口约 50 次/天」的限额，但官方 Skill 文档未写明该数字，本文按**未证实**处理，只以错误码 `110021 请求频控` 作为设计依据。

---

## 三、逐项可行性评估

### 3.1 拉取路径与数据映射

看板侧目标结构：`06-个人知识库/*.md`，`kind: 'personal'`，frontmatter 白名单为 `category / url / domain / author / clipped / summary / keyPoints / snapshot / sourceFile / uploaded`（`server/index.mjs:994` 的 `cleanPersonalFm`），入库统一走 `createNote('personal', …)`（`server/index.mjs:1082`、`:1139`）。

| ima 侧 | 看板侧字段 | 可行性 |
|---|---|---|
| `get_knowledge_list` 的 `media_id / title / parent_folder_id` | 文件枚举、目录映射到 `category`（灵感 / 制度 / 推文） | ✅ |
| `get_media_info` 的 `url_info.url`（网页 / 公众号） | `url`、`domain`、`clipped`；正文用现有 `server/webclip.mjs` 的 `htmlToText` | ✅ 需给 `fetchPage` 增加自定义 header（`server/webclip.mjs:72` 目前只发固定 UA/Accept） |
| `media_type=11` → `notebook_ext_info.notebook_id` → `get_doc_content` | `body`（纯文本） | ✅ 但丢 Markdown 结构 |
| 个人 / 共享库的 PDF、Word 等 | 下原件 → 现有 `server/docparse.mjs`（md/txt/docx/pdf） | ✅（≤200 MB，但看板 `MAX_BODY` 默认 2 MB，`server/index.mjs:45`，需另定上限或流式落盘） |
| 订阅 / 公共知识库 | 笔记仅 ~300 字预览；文件仅 AI 摘要、不能下原件 | ❌ 只能存摘要占位 |
| 微信公众号文章 | 官方只给 URL，正文仍需自己抓 | ⚠️ 项目零依赖、不能上无头浏览器，`mp.weixin.qq.com` 抓取成功率有限 |

保真度矩阵（按内容类型）：

| 内容类型 | 可获取 | 保真度 | 建议处理 |
|---|---|---|---|
| 网页 | 完整正文 | 高 | 抓取 + 快照，复用剪藏路径 |
| 微信公众号 | URL（正文另抓） | 中 | 抓成功按剪藏处理，失败存标题 + 链接 |
| 笔记（`media_type=11`） | 纯文本 | 中 | 直接写 `body`，保留 `notebook_id` 便于回链 |
| PDF / Word / PPT / Excel（个人库） | 原件 | 高 | 下载后走 `docparse` 提取文本 |
| 订阅 / 公共库条目 | 标题 + 摘要 / 300 字 | 低 | 只存占位并标注来源，不参与语义边 |

### 3.2 推送路径（看板 → ima）

`import_urls`（剪藏顺手入 ima）、`add_knowledge`（把 `06-个人知识库/*.md` 上传为 Markdown 条目）、`import_doc`（把草稿/笔记推成 ima 笔记）都是官方正向接口，成本低于抓取，且能形成「NAS 是真相、ima 是分发」的合理分工。

> v2 复核补充：除上述三个之外，实测还存在未公开的 `update_note`（原地更新笔记）、`move_knowledge` / `rename_knowledge`（条目移动与改名），但没有**知识库条目内容更新**与任何**删除**接口，因此「看板编辑 → 知识库文件覆盖」不成立，见 §10.3 ③。

### 3.3 检索替代：不建议

OpenAPI 只提供 `search_knowledge`（标题 / 高亮片段）与 `search_note`，**没有问答 / 生成接口**（`/openapi/chat/v1/*`、`/openapi/qa/v1/ask` 实测 404）；另有一个未公开的 `/openapi/rag/v1/search` 语义检索端点（实测存在、schema 未知，见 §10.3 ②）。用 ima 充当看板的 RAG 后端，会退化成「关键词命中列表」，且每次问答都要消耗外部额度并受频控影响。看板现有的 `/api/ai/ask`（本地检索 + 模型编排 + 引用）在延迟、成本、可控性上都更优。

### 3.4 四条硬边界

1. **增量难做**：知识库条目只有 `media_id / title / parent_folder_id`，**没有 `modify_time`** → 只能全量列表 + 本地 diff；只有笔记（`list_note` 的 `NoteBookInfo.modify_time`，毫秒）能精确增量。
2. **频控**：错误码 `110021 请求频控`（另有 `110020 安全打击`、`110030 无权限`）。列表 50/页 + 每篇一次 `get_media_info`，300 条一次性回填按最坏情况估算约 300+ 次调用，必须做成**限速 + 断点 + 分天**的队列。
3. **文本降级**：`get_doc_content` 的 `target_content_format=1`（Markdown）明确不支持，笔记只能取纯文本，标题层级、列表、代码块会丢失。
4. **权限分层**：订阅 / 公共知识库的条目在 API 层被削到预览或摘要，任何「全库同步」的承诺都不成立。

---

## 四、与项目架构的契合度

### 4.1 规范对齐

| 项目约束 | 接入方式 | 是否满足 |
|---|---|---|
| 纯静态模式不联网 | 仅在部署模式启用，模块挂在 note-api | ✅ |
| 前端只能发同源 `/api` | 新增 `/api/ima/*`，浏览器不直连 ima | ✅ |
| 密钥只在服务端、不进 bundle | `IMA_OPENAPI_CLIENTID` / `IMA_OPENAPI_APIKEY` 走环境变量，与 `AI_API_KEY` 同构（`docker-compose.yml:50`） | ✅ |
| 服务端零依赖 | 只有 `fetch` + JSON，不需要 SDK；与 `server/news.mjs`、`server/ai.mjs` 风格一致 | ✅ |
| 业务数据不进浏览器 | 结果直接写 `.md`，与现有 persist 一致 | ✅ |
| 写回用 mtime 乐观锁、409 不覆盖 | ima 来源没有本地 mtime，需按「新建」处理而非「更新」 | ⚠️ 见 4.2 |

### 4.2 三个冲突点

1. **与「vault 是唯一真相」冲突**：把 ima 内容混进 `06-个人知识库/` 顶层，会让用户在看板里编辑的副本被下次同步覆盖。**应落到独立子目录 `06-个人知识库/ima/`，定位为只读镜像**，看板内禁用编辑（或编辑后标记本地修改、同步时跳过）。
2. **mtime 乐观锁不适用**：外部来源没有并发编辑语义，`createNote` 的写入应按幂等键（`media_id`）判断「新增 / 跳过 / 覆盖」，不参与 409 流程。
3. **图谱与语义边会被稀释**：`src/neural/graph.js` 的节点文本是 `title + '\n' + body`，纯文本笔记与摘要占位会形成低信息量节点，建议镜像条目默认**不进概念共现**（给一个 `partition` 或标记位），只进个人知识库分支。

---

## 五、建议方案

### 5.1 模块与接口

```
server/ima.mjs            零依赖客户端：listKb / walkKb / mediaInfo / noteContent / importUrl
server/index.mjs          路由：
  GET  /api/ima/status    凭证是否配置、目标库列表、上次同步时间
  POST /api/ima/sync      触发后台同步（body: {kbId, mode}")
  GET  /api/ima/jobs/:id  进度与错误（轮询）
  POST /api/ima/push      反向：把一篇 .md 推送到 ima
```

同步任务必须异步化：一次回填可能跨分钟级，不能做成同步长请求（前端已有 `/api/version` 轮询模式可复用）。

### 5.2 落库 schema

沿用 `kind: 'personal'`，`cleanPersonalFm` 白名单增补两个字段：

```yaml
---
category: 推文            # 或 灵感 / 制度（按库或文件夹映射）
url: https://…
domain: example.com
clipped: 2026-10-19
source: ima               # 新增：来源标识
mediaId: 7f3c…            # 新增：幂等键
summary: …                # 订阅库条目才有
---
```

`mediaId` 是幂等与增量 diff 的唯一依据；对应的索引可加在 `server/db.mjs` 的 notes 表（新增一列或旁表），避免每次全量扫 frontmatter。

### 5.3 同步策略

1. 首次回填：按库 → 文件夹递归 `get_knowledge_list`（`limit=50`）拿清单，落一张临时清单表；
2. 内容获取按类型分派：网页/公众号 → `get_media_info` + `webclip` 抓取；笔记 → `get_doc_content`；文件 → 下载 + `docparse`；
3. 限速：并发 1、请求间 sleep、`110021` 指数退避、失败进重试队列，单日额度用完即停（状态写入 `.dashboard/` 下的 job 记录，可续跑）；
4. 增量：知识库全量列表 + `mediaId` diff（新增/删除）；笔记按 `modify_time` 精确定位；
5. 删除策略：默认「标记」不删文件（与 Obsidian 插件一致），避免一次误删清空镜像目录。

### 5.4 UI 入口

个人知识库页（`src/neural/pages.jsx` 的知识库页）增加「从 IMA 同步」按钮 + 状态条：显示已同步条数、待同步、失败原因（直接展示 API 的 `msg`）。遵循现有中英双语文案与 `isLive()` 判定。

---

## 六、风险与合规

| 风险 | 说明 | 缓解 |
|---|---|---|
| 凭证即全库读权限 | Client ID / API Key 泄露 = 知识库可读可写 | 只存 NAS 环境变量；不落 vault、不回显；定期轮换 |
| 频控与配额 | `110021` 频控，社区提到约 50 次/天（未证实） | 限速 + 断点续跑 + 分天回填；状态可视化 |
| 数据出境/外发 | 同步是「从 ima 读取」，但反向推送会把本地内容上传腾讯 | 反向能力默认关闭，逐篇显式触发 |
| 单向覆盖 | 镜像目录被覆盖会冲掉本地编辑 | 独立子目录 + 默认不覆盖 + 删除只标记 |
| 接口演进 | `openapi/wiki/v1` 与 Skill 版本绑定（包内 `ima-openapi-ctx: skill_version=…`） | 版本号集中常量；失败降级为只读展示，不影响看板主流程 |
| 服务条款 | 官方 OpenAPI 属正规通道，但自动化批量读取仍需符合用户协议 | 仅同步本人库；不共享凭证；不对外提供代理 |

---

## 七、实施路线与工作量

| 阶段 | 内容 | 预估 |
|---|---|---|
| **P0 探测** | `scripts/ima-probe.mjs`：列库 → 列条目 → 抽一条 `get_media_info` → 抓一次正文，输出 JSON 报告 | 0.5 人日 |
| **P1 只读镜像（网页/公众号/笔记）** | `server/ima.mjs` + `/api/ima/sync` + 后台任务 + `06-个人知识库/ima/` + 幂等 + UI 状态条 | 2–3 人日 |
| **P1 文件类** | 下载原件 → `docparse` 提取；流式写入绕过 `MAX_BODY` | 1–2 人日 |
| **P2 反向推送** | 剪藏时可选「同时存入 IMA」（`import_urls`）；笔记推 `import_doc` | 1 人日 |
| **P2 增量与删除标记** | 清单表 + `modify_time` 增量 + 删除标记模式 | 1 人日 |

---

## 八、验证方案

**第一步：凭证与库列表**

```bash
curl -sS https://ima.qq.com/openapi/wiki/v1/get_addable_knowledge_base_list \
  -H "ima-openapi-clientid: $IMA_OPENAPI_CLIENTID" \
  -H "ima-openapi-apikey: $IMA_OPENAPI_APIKEY" \
  -H 'Content-Type: application/json' \
  -d '{"cursor":"","limit":20}'
```

**第二步：条目与原文入口**（对目标库逐页 `get_knowledge_list`，随机抽 3 条调 `get_media_info`）

**第三步：正文可达性**（用 `url_info.url` + 返回的 `headers` 发 GET，确认 200 且正文非空）

判定标准：

| 结果 | 结论 |
|---|---|
| ①②③ 全通，且抽样中 ≥80% 有非空 `url_info` | 做 P1 全量镜像 |
| ②通但 `url_info` 大量为空 | 只做笔记类同步（`media_type=11`），放弃文件/网页类 |
| ①失败（`110030`/`110002`） | 核对 Client ID / API Key 与控制台绑定关系，暂缓 |
| 频繁 `110021` | 先做限速队列的最小版本，再谈全量 |

---

## 九、未决问题

1. 知识库接口的**准确日配额**官方未公开（仅 `110021` 错误码）；需在 P0 探测阶段实测日限。
2. `url_info.headers` 里签名 URL 的**有效期**未知，长任务需按需重新取 `media_id` 的链接。
3. `search_knowledge` 的高亮片段能否用于低成本摘要，需实测召回质量。
4. 订阅 / 公共库里「仅 AI 摘要」的条目，是否值得入图谱（信息量低，倾向不入）。
5. 镜像目录是否纳入语义边（`/api/ai/relate`）——建议默认排除，单独开关。
6. ~~`update_note` 的参数与并发语义~~ —— 已实测（§11.3）：块级补丁，`block_id` 不可得，覆盖方案作废；但 `list_notebook` 的版本握手仍未解（当前写笔记只能落「未分类」）。
7. ~~`rag/v1/search` 的结构~~ —— 已实测（§11.2）：可用且返回原文片段，但**只覆盖公开知识库**；其日额度、公开库版权边界仍待确认。
8. **删除语义**：ima 侧删除在看板只做「标记下架」，还是提供「全量 diff 后询问」；知识库条目无 `modify_time`，外部改动只能整体重拉。
9. **双写真源**：看板创作的笔记写回 ima 后，是否允许在 ima 端再改（改了就产生第二真源，需决定是否检测并提示）。

---

## 十、双向同步专项评估（v2 复核）

### 10.1 复核方法

**端点存在性探测**：对候选路径发 `POST {}` + 伪造凭证头。网关在鉴权阶段即返回，因此响应可区分三种情况：

| 响应 | 含义 |
|---|---|
| `HTTP 401 {"code":200002,"msg":"skill auth failed","request_id":…}` | **端点存在**，只是凭证无效 |
| `HTTP 404`（空响应体） | 路径不存在 |
| `HTTP 200 {"code":…}` | 需要凭证才能走到业务层，观测不到 |

共探测 60+ 条路径，覆盖笔记、知识库、rag、chat、agent、qa 六个命名空间。

**文档侧对照**：`https://ima.qq.com/agent-interface` 控制台「核心功能」六项（读取笔记内容 / 写入笔记「新建笔记或追加内容」/ 检索笔记 / 检索知识库 / 导入知识库 / 获取知识库资料）**均未标注「即将上线」或「内测中」**，即控制台对外承诺的能力就是这六项；Skill 包 `ima-skills-1.1.10` 的接口文档与之完全一致。

### 10.2 端点账本（实测）

| 路径 | 官方文档 | 实测 | 用途 |
|---|---|---|---|
| `/openapi/note/v1/{search_note,list_note,get_doc_content,import_doc,append_doc,list_notebook}` | 有 | 401 存在 | 笔记读、检索、新建、追加 |
| `/openapi/note/v1/update_note` | **无** | 401 **存在** | 实测为块级补丁：`user_request_id` + `updates[{action,block_id,content}]`，action∈{1,2,3}，都要求有效 `block_id` → 不能整篇覆盖（§11.2） |
| `/openapi/wiki/v1/{get_knowledge_list,search_knowledge,get_knowledge_base,search_knowledge_base,get_addable_knowledge_base_list,get_media_info,create_media,add_knowledge,import_urls,check_repeated_names}` | 有 | 401 存在 | 知识库浏览、检索、原文、上传、导入 |
| `/openapi/wiki/v1/move_knowledge`、`/rename_knowledge` | **无** | 401 **存在** | 移动 / 改名条目（可用于「新增版本后整理」） |
| `/openapi/rag/v1/search` | **无** | 401 **存在** | 实测：`{strategy_id, query, limit(5-20)}` → 返回原文 chunk；**只覆盖公开知识库语料**（§11.2） |
| `/openapi/note/v1/{update_doc,delete_doc,del_doc,rename_doc,move_doc,trash_doc,copy_doc,create_note,get_note,list_notes}` | — | 404 | **不存在** |
| `/openapi/wiki/v1/{delete_knowledge,del_knowledge,remove_knowledge,update_knowledge,modify_knowledge,replace_knowledge,update_media,delete_media,replace_file,batch_move_knowledge,delete_folder}` | — | 404 | **不存在**：知识库条目不可更新、不可删除 |
| `/openapi/rag/v1/{query,ask,retrieve,chat,completions,answer,get_chunks,context}`、`/openapi/chat/v1/*`、`/openapi/agent/v1/*`、`/openapi/qa/v1/ask` | — | 404 | **没有问答 / 生成接口** |

结论：**写回面 = 新建 + 追加 + 更新笔记 + 移动/改名；没有删除，也没有知识库条目内容更新。**

### 10.3 三项诉求逐条判定

**① 看板查看 ima 库里的文件：✅ 可行**

| 环节 | 接口 | 说明 |
|---|---|---|
| 列表 / 目录树 | `get_knowledge_list`（cursor + limit ≤50 + `folder_id`） | `current_path` 给面包屑；文件夹与文件同列表返回 |
| 取原件入口 | `get_media_info` | 返回 `url_info.url` + `url_info.headers`（签名头） |
| 下载 | 服务端带 `headers` GET 该 URL，流式转发 | 前端走同源 `/api/ima/raw?media_id=…`，避免跨域与签名头暴露 |
| 预览能力 | 浏览器原生 | PDF、图片、HTML、TXT、Markdown 可预览；DOCX / PPTX / XLSX 零依赖前端无法渲染 → 只能「下载」或「抽文本」（`server/docparse.mjs`） |
| 笔记类条目 | `get_doc_content`（`target_content_format=0`） | 纯文本渲染 |

限界：订阅 / 公共知识库的条目只返回预览或 AI 摘要，原件不可得（§三 保真度矩阵）。

**② 通过 AI 检索 ima 库内容：⚠️ 存在官方接口，但不宜作为主路径**

| 路线 | 机制 | 评级 |
|---|---|---|
| A. 镜像 + 看板本地 RAG | 同步到 `06-个人知识库/ima/` → 走现有 `/api/ai/ask`（本地检索 + 引用 + 语义边） | ✅ **推荐**：可控、可引用、无外部依赖 |
| B. 官方 `rag/v1/search` | 语义检索接口，未公开文档，schema 与额度均未知 | ⚠️ 待实测；适合做「找条目」增强，不适合作为唯一数据源 |
| C. `search_knowledge` 关键词检索 | 只返回标题 + `highlight_content` 片段 | ❌ 不能支撑问答（片段不完整、无全文） |
| D. 逆向 cookie 调 `/cgi-bin/assistant/qa` | 社区 MCP 的做法 | ❌ 凭证更重、能力更弱，官方 OpenAPI 出现后无必要 |

关键判断：**看板的「AI 检索」本质是「全文进本地索引」**，所以 ② 实际依赖 ①（拉取），而不是依赖某个问答接口。

**③ 看板编辑的内容同步回 ima：✅ 笔记可行，❌ 知识库文件不可行**

| 目标 | 能力 | 结论 |
|---|---|---|
| ima 笔记（本人） | `import_doc` 新建、`append_doc` 追加、`update_note`（**块级补丁**） | ⚠️ 可做「新建 + 文末追加」式同步；原地覆盖不成立（block_id 不可得，见 §11.3） |
| 知识库里的 Markdown / 文件条目 | 只有 `add_knowledge`（新增） | ❌ 无法覆盖同一 `media_id`；编辑只能「另存为一篇新条目」，旧条目在 ima 端手工删除 |
| 知识库里的网页 / 公众号条目 | 只有 `import_urls`（新增） | ❌ 同上，且原文归属 ima 抓取结果，本地改动无处落 |
| 条目整理 | `move_knowledge`、`rename_knowledge` | ✅ 可作为「新增版本 + 挪到归档文件夹」的补偿手段 |

### 10.4 五个语义障碍（决定架构，不只是能力清单）

1. **无删除接口**：看板删条目无法传到 ima，ima 删条目只能通过全量列表 diff 发现。删除必须保持「单向 + 只标记」。
2. **知识库条目无 `modify_time`**：无法判断 ima 端是否被改过，回写就是盲写；只有笔记有 `modify_time`。
3. **知识库内容不可替换**：同名新增 → 只能靠 `check_repeated_names` 查重后人工决策，自动化只能是「追加新版本」。
4. **`update_note` 的并发语义未知**：`100008 版本冲突` 说明它可能要版本号或 mtime，必须在 P0 用它做一次真实写入才敢设计自动覆盖。
5. **未公开接口无稳定性承诺**：`update_note`、`rag/v1/search`、`move/rename_knowledge` 都不在官方文档与「核心功能」六项里，随时可能变更；实现时必须可降级（探测失败即退回只读能力）。

### 10.5 推荐形态：非对称双向

| 方向 | 机制 | 真源 |
|---|---|---|
| ima 知识库 → 看板 `06-个人知识库/ima/` | 定时/手动拉取，`mediaId` 幂等，只读镜像，看板内禁用编辑 | **ima** |
| 看板创作（灵感 / 制度 / 草稿） → ima 笔记 | 首次 `import_doc` 建档，之后 `update_note` 覆盖，冲突时提示 | **看板（vault）** |
| 看板剪藏 → ima 知识库 | `import_urls` / `add_knowledge` 单向追加 | 双写但不可回改，视为分发 |
| AI 检索 | 镜像内容进本地 RAG；`rag/v1/search` 作为可选增强 | 看板 |

路由清单：

```
GET  /api/ima/status           凭证状态、库列表、上次同步
GET  /api/ima/tree?kb=&folder= 目录树（含 media_type、是否有原件）
GET  /api/ima/raw?media_id=    原件流式代理（带签名头，不暴露给前端）
POST /api/ima/sync             ima → 看板 镜像任务（后台 + 进度）
POST /api/ima/push             看板笔记 → ima 笔记（import_doc / update_note）
POST /api/ima/collect          看板剪藏 → ima 知识库（import_urls）
```

前端只调同源 `/api/ima/*`，凭证只存在于 NAS 环境变量，符合项目既有约束。

### 10.6 补充验证（在 §八 三步之上追加两项）

1. 对一篇测试笔记调 `update_note`（先 `import_doc` 建一篇），确认请求参数与 `100008` 触发条件；
2. 对一个已授权知识库调 `rag/v1/search`，记录请求字段、返回结构、是否返回原文片段与引用。

这两项决定「写回」与「AI 检索」是走官方能力还是退回镜像方案——**在拿到凭证的 30 分钟内可判定**。

---

## 十一、真实凭证实测（2026-10-20 实跑）

用真实 Client ID / API Key 跑了一遍读路径与写路径，共约 45 次调用，未触发频控。凭证只走环境变量，下文已脱敏（知识库名、note_id 部分截断、签名 URL 隐去）。

### 11.1 读路径实测

| 能力 | 端点 | 实测结果 |
|---|---|---|
| 知识库枚举 | `get_addable_knowledge_base_list` | ✅ 返回 4 个库（个人库 / 制度库 / 段子 / 微信收藏），`next_cursor` 分页正常 |
| 目录与条目 | `get_knowledge_list` | ✅ 条目在 `data.knowledge_list`（**不是** `info_list`）；文件夹 `media_type=99` 且 id 形如 `folder_xxx`；`current_path` 给面包屑 |
| 文件原件 | `get_media_info` → `url_info` | ✅ PDF 返回 CDN 签名 URL + `X-IMA-Sign` 等头；带头发起 GET 实测 **HTTP 200，599,599 字节，`application/pdf`，2 页** → **原件可下载** |
| 网页/公众号 | `get_media_info` | ⚠️ `media_type=6` 只返回**原始** `mp.weixin.qq.com` 链接，`headers` 为空 → 拿不到 ima 抓取的正文，只能回原站 |
| 笔记类条目 | `get_media_info` | ⚠️ `media_type=11` 的 `url` 是 `chrome://note?docid=…` 深链、`headers` 空；正文必须走 `get_doc_content` |
| 笔记正文 | `get_doc_content`（`target_content_format=0`） | ✅ 返回**纯文本**（Markdown 结构被抹平，标题与列表连成一行） |
| 自己库关键词检索 | `search_knowledge` | ⚠️ 只给 `title/media_type/parent_folder_id`；`highlight_content` 对笔记、文件夹、xlsx **全是空串** |

### 11.2 检索（rag）实测：可用，但不是自己的库

请求体：`{"strategy_id":"default","query":"…","limit":10}`（`limit` 校验区间 **[5,20]**；`strategy_id` 任意 1–128 字符串等价，缺省报 `invalid OpenapiSearchReq.StrategyId`）。

返回 `data.chunks[]`，每个 chunk 含：

| 字段 | 内容 |
|---|---|
| `content` | **原文片段**（Markdown 表格/正文都在，实测一次 300+ token） |
| `chunk_abstract` | 该 chunk 的 AI 摘要 |
| `chunk_url` | `https://ima.qq.com/wiki/?shareId=…&mediaId=…` 分享页 |
| `kb_id` / `chunk_index` / `chunk_token` / `publish_time_format` | 归属与定位信息 |
| `feature_scores` | `overall_score` / `semantic_score` / `kb_quality_score`（实测 0.84 / 0.54 / 0.11） |

**关键限制（实测）**：命中的 `kb_id` 全是**公开共享知识库**的数字 id（4 位数以上），不是本账号 `get_addable_knowledge_base_list` 返回的 base64 风格 id；传 `knowledge_base_ids` / `kb_ids` / 个人库 id 完全不影响结果。用自己库里独有的措辞去搜，返回的仍是别人的公开库。

结论：`rag/v1/search` = **公共语料语义检索**，能直接拿到原文片段（可作为问答上下文/补充素材），但**不能用来检索自己的库**。

### 11.3 写路径实测

| 操作 | 结果 | 说明 |
|---|---|---|
| `import_doc` | ✅ 成功 | `{content_format:1, content:"<markdown>"}` → 返回 `note_id`；`list_note` 立即可见（`modify_time` 为毫秒字符串） |
| `append_doc` | ✅ 成功 | 追加到文末，`get_doc_content` 可见追加内容 |
| `update_note` | ⚠️ 存在但不可用于覆盖 | 必填 `user_request_id`；`updates[]` 每项 `{action, block_id, content}`，`action` 合法值实测只有 **1/2/3**，且三者都要求有效 `block_id`（传 `""` 或 `"0"` → `BLOCK_NOT_FOUND`）；而 `get_doc_content` 不返回 block_id → **整篇覆盖走不通** |
| `list_notebook` | ⚠️ 恒空 | 返回 `note_folder_infos: []` + `need_update: true`（需要客户端版本握手），所以 `import_doc` 只能落「未分类」；若要把看板内容写入指定笔记本，需补上这层握手 |

### 11.4 知识库上传链路实测（create_media → COS → add_knowledge）

用一个 412 字节的测试 Markdown（同看板 `06-个人知识库/*.md` 的 frontmatter 结构）跑完整链路：

| 步骤 | 结果 |
|---|---|
| `check_repeated_names` | ✅ 首次 `is_repeated:false`；同名再查为 `true`（按文件名查重，跨条目有效） |
| `create_media` | ✅ 返回 `media_id` + `cos_credential`（bucket `ima-share-kb-…` / region `ap-shanghai` / 临时 secret + token / `expired_time`） |
| COS 上传 | ✅ 用官方自带 `knowledge-base/scripts/cos-upload.cjs`，HTTP 200 |
| `add_knowledge` | ✅ `media_type=7` + `file_info{cos_key,file_size,file_name}` → 条目入根目录；**条目标题取文件名**，传 `title` 不生效 |
| 回读 | ✅ `get_media_info` → 签名 URL → 下载得 **412 字节，frontmatter 与正文逐字节一致**（`.md` 往返无损） |
| **覆盖尝试** | ❌ 复用旧 `media_id` + 新 `cos_key` 再 `add_knowledge` → 返回 `code:0`，但回读仍是 v1（412B）→ **静默 no-op，内容不更新、也不新增条目** |
| 检索 | ❌ 上传后 `search_knowledge` 能按文件名命中，但 `highlight_content` 仍为空串 |
| 删除 | ❌ 无接口 |

结论：**上传链路成立**（看板 `.md` 能进 ima 知识库，且文件名即条目名，与项目「文件名即标题」的约定天然一致），但条目**一次写定：不可更新、不可删除**，重复 add 是空操作。所以「编辑同步」只能是**新增一个版本条目**（配合 `rename` 加版本号 + `move` 归档）。

### 11.5 对三项诉求的最终判定（取代 §10.3 的预判）

| 诉求 | 实测结论 | 可实现形态 |
|---|---|---|
| 看板查看 ima 库里的文件 | ✅ **文件类完全可行**，网页类受限 | 目录树 + `get_media_info` + 服务端代下载；PDF/Word/Excel/图片能拿到原件；公众号类只剩原链接 |
| 通过 AI 检索 ima 库内容 | ❌ **自己库没有官方检索** | 必须镜像到自己库外的索引（看板 vault + `/api/ai/ask`）；`rag/v1/search` 只能补「公开语料」 |
| 看板编辑同步回 ima | ⚠️ **只能新建 / 追加** | 笔记：`import_doc` 建档 + `append_doc` 追加；知识库：`add_knowledge` 新增（同 `media_id` 重复 add 为 no-op，见 §11.4）。均无法原地覆盖、无法删除 |

### 11.6 遗留与安全

1. 实测留下了两处**OpenAPI 删不掉**的测试物，需在 ima 客户端手工删：① 笔记「DSH 同步探针」（`note_id` 7518186165530698）；②「段子」知识库根目录的 `dsh-probe.md`（`media_id` `markdown_cls1_…1645165025897`）。
2. 凭证已验证具备：4 个库的读权限、笔记读写、知识库上传。它同时是**写权限钥匙**，建议探测结束后在控制台**重置 API Key**。
3. 未验证：`import_urls`（网页/公众号导入）实际抓取成功率、`move/rename_knowledge` 的整理手感、以及 IM 端删除后列表 diff 的时延。

---

## 十二、事实依据

- 官方控制台：`https://ima.qq.com/agent-interface`（Client ID / API Key）
- 官方 Skill 包：`ima-skills-1.1.10.zip`，字段与错误码引自包内 `knowledge-base/references/api.md`、`notes/references/api.md`
- 分发与文档：`https://skillhub.tencent.com/skills/ima-skills`、`https://wiki.ima.qq.com`
- 社区实现对照：`https://github.com/chenxiccc/obsidian-ima.copilot-sync`、`https://github.com/RangoLabWorks/ima-copilot-auto-sync`、`https://github.com/onclaw-dev/dsh-ima-copilot`
- 项目侧现状：`server/index.mjs:994`（`cleanPersonalFm` 白名单）、`server/index.mjs:1082` / `:1139`（`createNote('personal', …)`）、`server/webclip.mjs:72`（固定 UA/Accept）、`server/index.mjs:45`（`MAX_BODY` 默认 2 MB）、`src/neural/graph.js`（节点文本 = 标题 + 正文）
- 本机实测：`/Applications/ima.copilot.app` 与 `~/Library/Application Support/com.tencent.imamac`（586 MB，IndexedDB 无 `ima.qq.com` 库）
