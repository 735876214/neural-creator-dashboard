// 笔记库读取与解析：把一个 Markdown 笔记文件夹读成看板数据。
// 只用 Node 自带模块，只读你的笔记、不联网、不修改任何文件。
//
// scripts/import-notes.mjs（一次性导入，生成 src/data/my-data.local.js）和
// server/index.mjs（NAS 上的读写服务）共用这一份，避免两套解析逐渐不一致。
import {readFileSync, readdirSync, statSync, lstatSync} from 'node:fs';
import {join, relative, basename, sep} from 'node:path';
import {attachmentsOf} from './frontmatter.mjs';

export const SKIP = new Set(['.obsidian', '.trash', '.git', 'node_modules', '.DS_Store']);

// 附件目录（看板上传的图片 / 视频等，顶层 99-附件/）：不进图谱、不参与分类。
export const ATTACHMENTS_DIR = '99-附件';

// —— 读取 Markdown ——
// 用 lstat 而不是 stat：vault 里一个自指软链（Syncthing / Obsidian 插件 / 手工建的
// `latest -> .`）会让 stat 版无限递归，RangeError 冒到 /api/data 与每 5 秒一次的
// /api/version，整站 500。同时加 realpath 去重、深度上限与逐目录容错：
// 单个文件 EPERM/EIO（SMB 抖动、被独占）不该让整次读取失败。
const WALK_MAX_DEPTH = 12;
export function walk(dir, out = [], depth = 0, seen = new Set()) {
  if (depth > WALK_MAX_DEPTH) return out;
  let entries;
  try { entries = readdirSync(dir, {withFileTypes: true}); } catch { return out; }
  for (const e of entries) {
    const name = e.name;
    if (SKIP.has(name) || name.startsWith('.')) continue;
    const p = join(dir, name);
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue; // 软链一律跳过：既防自环，也不把库外内容读进来
      if (st.isDirectory()) walk(p, out, depth + 1, seen);
      else if (name.toLowerCase().endsWith('.md')) out.push(p);
    } catch { continue; }
  }
  return out;
}

// 简化的 YAML frontmatter：key: value、key: [a, b]、以及「- 项」列表。
export function parse(rawText) {
  // 跳过 UTF-8 BOM：带 BOM 的文件 `^---` 匹配不上，整块属性被当正文，标题与指标全部丢失。
  const bom = String(rawText).startsWith('\uFEFF') ? 1 : 0;
  const text = bom ? String(rawText).slice(1) : String(rawText);
  // 组 1 允许为空：`---\n---\n正文` 是空属性块
  const m = text.match(/^---\r?\n(?:([\s\S]*?)\r?\n)?---\r?\n?/);
  const fm = {};
  if (m) {
    let key = null;
    for (const raw of (m[1] ?? '').split(/\r?\n/)) {
      // 缩进行永远不是顶层键：嵌套对象（cover: 块、Notion 导出、dataview 属性）与
      // `|` / `>` 多行标量的续行里也会出现 `xx: yy` 形态，无条件 trim 后当顶层键会让
      // 「后写覆盖前写」，于是 title / tags / id 读到的是嵌套里的噪音值（还会被前端回写进文件）。
      if (/^\s/.test(raw)) {
        const item = raw.match(/^\s*-\s+(.*)$/);
        if (item && key) { if (!Array.isArray(fm[key])) fm[key] = []; fm[key].push(unquote(item[1])); }
        continue;
      }
      const kv = raw.match(/^([^:#][^:]*):\s*(.*)$/);
      if (!kv) continue;
      key = kv[1].trim();
      const v = kv[2].trim();
      fm[key] = v.startsWith('[') && v.endsWith(']') ? splitFlow(v.slice(1, -1)).map(unquote).filter(Boolean) : v === '' ? '' : unquote(v);
    }
  }
  return {fm, body: m ? text.slice(m[0].length) : text};
}

// 行内列表 `[a, b]` 的拆分要尊重引号：`tags: ["a,b", c]` 原来被劈成 a / b / c，
// 标签在第一次回写时就永久拆散。这里只在引号外按逗号切。
function splitFlow(s) {
  const out = [];
  let cur = '', q = '';
  for (const ch of String(s)) {
    if (q) { cur += ch; if (ch === q) q = ''; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(x => x !== '');
}

export const unquote = s => String(s).trim().replace(/^['"]|['"]$/g, '');
export const pick = (fm, keys) => { for (const k of keys) for (const f of Object.keys(fm)) if (f.toLowerCase() === k.toLowerCase() && fm[f] !== '') return fm[f]; return undefined; };
export function num(v) {
  if (v == null || v === '') return null;
  const str = String(v).trim();
  // mm:ss / hh:mm:ss（视频平均观看时长的常见写法）：原来会被字符类删成 0123 → null，
  // duration 静默变成「未采集」。
  const clock = str.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (clock) {
    const [a, b, c] = [Number(clock[1]), Number(clock[2]), Number(clock[3] || 0)];
    return clock[3] != null ? a * 3600 + b * 60 + c : a * 60 + b;
  }
  // 只剥单位和分隔符，不再用 /[s]/ 这类会误吃字母的字符类（"12ms" 曾被删成 "12m" → null）
  const s = str.replace(/[,，\s]/g, '').replace(/%$/, '').replace(/(秒|s)$/i, '');
  const m = s.match(/^(-?\d+(?:\.\d+)?)(万|w|k|千)?$/i);
  if (!m) return null;
  const mul = {万: 1e4, w: 1e4, W: 1e4, k: 1e3, K: 1e3, 千: 1e3}[m[2]] || 1;
  return Math.round(Number(m[1]) * mul * 10) / 10;
}
export const pad = n => String(n).padStart(2, '0');
export function dateOf(v, file) {
  // 只有日期时按本地时间的 00:00 解析（避免被当成 UTC 而跨天）
  const s = v ? String(v).trim().replace(/\//g, '-').replace(/^(\d{4}-\d{1,2}-\d{1,2})$/, '$1 00:00') : '';
  const d = s ? new Date(s) : null;
  const t = d && !isNaN(d) ? d : statSync(file).mtime;
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}
export function tagsOf(fm, body) {
  const raw = pick(fm, ['tags', 'tag', '标签', '话题']);
  const list = Array.isArray(raw) ? raw : raw ? String(raw).split(/[,，\s]+/) : [];
  // `#` 前的字符不限于空白：中文写作里「这条讲的是#选题方法论」很常见，只认行首/空格会整类丢掉话题。
  // 正则与前端 src/neural/graph.js 的 HASHTAG_RE 保持一致。
  for (const m of body.matchAll(/(?:^|[\s，。,.!?！？、；;:：()（）[\]{}【「《>])#([^\s#，。,.!?！？、；;:：()（）[\]]+)/g)) list.push(m[1]);
  return [...new Set(list.map(t => t.replace(/^#/, '').trim()).filter(t => t && !/^\d+$/.test(t)))].slice(0, 12);
}
export const clean = body => body.replace(/\r/g, '').trim().slice(0, 6000);

// —— 分类 ——
// 个人知识库（06-个人知识库）要在 methods 之前判断：methods 规则里有「知识」二字，会先吞掉它。
// personal 必须整段匹配：裸子串会把「05-方法库 methods/personal branding/x.md」这类
// 方法笔记整桶塞进个人知识库（星座跑错、path 被套上前缀、counts 失真）。
export const RULES_PERSONAL = ['personal', /^(?:personal|个人知识库|个人库|knowledge[ _-]?base)$/i];
export const RULES = [
  ['works', /(作品|works?$|published|已发布)/i],
  ['drafts', /(草稿|创作台|drafts?$|正在写|写作中)/i],
  ['ideas', /(选题|ideas?$|灵感)/i],
  // notes? 前面必须有个分隔符：`my-notes`、`08-notes` 仍算方法笔记，
  // 但「笔记notes」这种硬拼在词尾的目录名不再被当成强信号
  ['methods', /(方法|methods?$|模板|templates?$|流程|workflow|知识|卡片|(?:^|[-_ .])notes?$)/i]
];

// 目录名前面的序号（06-个人知识库 / 3. 草稿 / 01_流程）不算名字的一部分：
// 规则表是按语义名写的，带序号前缀会让锚定匹配（^…$）全部落空。
const stripIdx = s => String(s).replace(/^\d+\s*[-_.、．]\s*/, '');
// AI 热点日报目录：只能作为兜底（放最后），避免「方法库」之类先匹配走。
// 注：00-AI热点 由 RULES 之上的显式判断处理不了（新闻目录名不含上述词时），
// 所以这里加一条——但顺序在 methods 之后，普通笔记优先。
export const RULES_NEWS = ['news', /(AI热点|ai[ _-]?radar|ai[ _-]?news)/i];
// Logseq 导出兜底（obsidian-independence P2）：只认「logseq」目录名或 .logseq 隐藏目录——
// 通用的 pages/journals 太宽（任何项目都可能有同名目录），会静默吞掉用户的普通笔记；
// Logseq 库走 import-notes --logseq（显式 --methods pages --methods journals），不依赖这条规则。
export const RULES_LOGSEQ = ['methods', /(^|\.)(logseq)$/i];
// Notion 导出的页面文件夹名带 32 位哈希后缀（如「My Page 1234abcd…」），匹配前剥掉。
const NOTION_HASH = /\s+[0-9a-f]{32}$/i;
export const norm = p => p.split(/[\\/]/).filter(Boolean).join('/');

// dirs：显式指定的文件夹（{works: [], methods: [], ideas: [], drafts: []}），优先于按文件夹名自动识别。
export function classify(rel, dirs, allAsNotes = false) {
  const d = dirs || {};
  // Notion 导出适配：剥掉目录名里的 32 位哈希后缀再匹配（文件名里的哈希不影响分类——标题取 basename）
  // 分隔符同时接受 / 与 \（Windows 的 sep 是 \，但 vault 内部路径统一 /）
  const names = rel.split(/[\\\/]/).slice(0, -1).map(n => n.replace(NOTION_HASH, ''));
  for (const kind of ['works', 'drafts', 'ideas', 'methods']) for (const f of d[kind] || []) {
    const prefix = norm(f);
    if (norm(rel).startsWith(prefix + '/')) return {kind, root: prefix.split('/').length};
  }
  for (let i = 0; i < names.length; i++) if (RULES_PERSONAL[1].test(stripIdx(names[i]))) return {kind: 'personal', root: i + 1};
  // AI 热点要排在通用规则前面：`00-AI热点` 里带「热点」，先跑 methods 的话整个日报目录
  // 会被判成方法笔记（星座从仙女座跑到天蝎座，kind=news 的路径全失效）。
  for (let i = 0; i < names.length; i++) if (RULES_NEWS[1].test(stripIdx(names[i]))) return {kind: 'news', root: i + 1};
  for (let i = 0; i < names.length; i++) for (const [kind, re] of RULES) {
    if ((d[kind] || []).length) continue;
    if (re.test(stripIdx(names[i]))) return {kind, root: i + 1};
  }
  // Logseq 导出兜底：pages / journals / logseq 目录按方法笔记处理
  for (let i = 0; i < names.length; i++) if (RULES_LOGSEQ[1].test(names[i])) return {kind: 'methods', root: i + 1};
  return allAsNotes ? {kind: 'methods', root: 0} : null;
}

// 把一个笔记库读成看板数据。返回的形状与 src/data/*.js 的导出一致。
// 额外带回三样东西（导入脚本会剥掉，不进 my-data.local.js）：
//   rel    —— 文件相对 vault 的真实路径，服务端写回时用它定位文件
//   tags   —— 笔记的话题，用于推导概念词
//   counts —— 各模块的篇数，用于进度提示
// 轻量指纹：/api/version 每 5 秒轮询一次，不能为此把整个 vault 读两遍（几千篇时每次 0.3-0.5s NAS CPU）。
// 只 walk + stat，不读正文；文件增删/改名/改 mtime 都会让 v 变化。
export function vaultStamp(dir) {
  let v = 0, n = 0;
  // walk() 返回的已经是带 dir 的完整路径；累加 mtime + size 后对 1e15 取模，
  // 既避免浮点求和在几千篇时丢精度，也不会溢出安全整数。
  for (const p of walk(dir)) {
    try { const st = statSync(p); v = (v + Math.round(st.mtimeMs) + st.size) % 1e15; n++; } catch { v = (v + 1) % 1e15; n++; }
  }
  const value = {v: v + n, n};
  return value;
}

// 只给 /api/version 用：多个标签页各自 5 秒轮询，全库 stat 在 NAS 上是几百毫秒的 IO。
// 短缓存 3 秒把并发轮询合并成一次；读取路径（loadData）绝不能用缓存版本 ——
// 写完立刻比对 mtime 是乐观锁的基础，指纹滞后会造成「刚保存就报冲突」。
const stampMemo = new Map();
const STAMP_TTL = 3000;
// 自己写盘后必须立刻让缓存失效：前端「保存 → 轮询指纹 → 发现变了 → 重新拉数据」，
// 指纹滞后 3 秒会让刚保存的改动看起来没生效（test-api 的「写盘后指纹应变化」就是这条）。
export function bumpVaultStamp() { stampMemo.clear(); }
export function vaultStampCached(dir) {
  const hit = stampMemo.get(dir);
  const at = Date.now();
  if (hit && at - hit.at < STAMP_TTL) return hit.value;
  const value = vaultStamp(dir);
  stampMemo.set(dir, {at, value});
  return value;
}

export function readVault(opts = {}) {
  const vault = opts.vault;
  if (!vault) throw new Error('readVault 需要 vault 参数');
  const dirs = {works: opts.works || [], methods: opts.methods || [], ideas: opts.ideas || [], drafts: opts.drafts || []};
  // full=true 关掉全部「展示窗口」上限：/api/data 只显示最新 30 篇作品、40 篇方法笔记、
  // 60 天日报、120 条个人库、300 条选题/草稿，但全文检索与 RAG 不该被这些窗口限制
  // （第 31 篇作品就搜不到，问它还会回答「笔记库里没有相关内容」）。
  const unlimited = opts.full ? Infinity : 0;
  const maxWorks = opts.maxWorks || unlimited || 30, maxNotes = opts.maxNotes || unlimited || 40;

  // news（AI 热点日报）与 methods 同一条通道进图谱，但保留自己的 kind；
  // personal（个人知识库：灵感 / 制度 / 推文剪藏）同样保留自己的 kind。
  const bucket = {works: [], methods: [], ideas: [], drafts: [], news: [], personal: []};
  // 读不出正文的篇数：reindex 靠它决定这一轮能不能 prune（少读到一篇 ≠ 它被删了）
  let unreadable = 0;
  for (const file of walk(vault)) {
    const rel = relative(vault, file);
    // 附件目录（99-附件/）里的任何文件都不进图谱
    if (norm(rel).startsWith(ATTACHMENTS_DIR + '/')) continue;
    const c = classify(rel, dirs, !!opts.allAsNotes);
    if (!c) continue;
    // 单篇读失败（SMB 抖动、被独占、权限）只跳过它：原来一个 EACCES 会让整份
    // /api/data 抛 500，看板直接白屏，用户还以为是数据坏了。
    let parsed;
    try { parsed = parse(readFileSync(file, 'utf8')); } catch { unreadable++; continue; }
    const {fm, body} = parsed;
    const title = String(pick(fm, ['title', '标题', 'name']) || basename(file).replace(/\.md$/i, '')).trim();
    // 附件引用在这里算一次（全文，未截断）：loadData 原来为拿 figures 把每个文件再读一遍，
    // 几千篇的库等于把整个 vault 读两遍。正文超 6000 字时截断后的文本也拿不到后面的图片引用。
    let attachments = [];
    try { attachments = attachmentsOf(body); } catch {}
    bucket[c.kind].push({file, rel, root: c.root, fm, body, title, attachments});
  }

  // —— 作品 ——
  const works = bucket.works.map(x => {
    const media = /视频|video/i.test(String(pick(x.fm, ['media', '类型', 'type', '形式']) || '')) ? 'video' : 'images';
    const p = {
      title: x.title, date: dateOf(pick(x.fm, ['date', '发布时间', '发布日期', 'published', 'publishedAt', 'created', '创建时间']), x.file),
      views: num(pick(x.fm, ['views', '观看', '浏览', '阅读', '播放'])) ?? 0,
      likes: num(pick(x.fm, ['likes', '点赞'])) ?? 0,
      comments: num(pick(x.fm, ['comments', '评论'])) ?? 0,
      saves: num(pick(x.fm, ['saves', '收藏'])) ?? 0,
      follows: num(pick(x.fm, ['follows', '涨粉'])),
      shares: num(pick(x.fm, ['shares', '分享', '转发'])) ?? 0,
      impressions: num(pick(x.fm, ['impressions', '曝光'])),
      ctr: num(pick(x.fm, ['ctr', '点击率', '封面点击率'])),
      duration: num(pick(x.fm, ['duration', '平均观看', '平均观看时长', '时长'])),
      // 发布来源：发在哪个平台、原文链接、平台内容 ID 与最近一次指标同步时点（半自动发布回填）
      platform: String(pick(x.fm, ['platform', '平台']) || '').trim() || undefined,
      url: String(pick(x.fm, ['url', 'link', '链接']) || '').trim() || undefined,
      platformId: String(pick(x.fm, ['platformId', '平台ID', '平台id']) || '').trim() || undefined,
      syncedAt: String(pick(x.fm, ['syncedAt', '同步时间']) || '').trim() || undefined,
      // 发布时的来源选题 / 来源草稿（/api/publish 写入）：草稿文件发布后被移走，
      // 这两个稳定 id 是「选题 → 草稿 → 作品」链条在作品一侧的唯一线索。
      sourceIdeaId: String(pick(x.fm, ['sourceIdeaId']) || '').trim() || undefined,
      sourceDraftId: String(pick(x.fm, ['sourceDraftId']) || '').trim() || undefined
    };
    return {post: p, content: {title: x.title, body: clean(x.body), tags: tagsOf(x.fm, x.body), media}, rel: norm(x.rel), attachments: x.attachments};
  }).sort((a, b) => b.post.date.localeCompare(a.post.date)).slice(0, maxWorks)
    .map((w, i) => ({...w, post: {id: 'w' + (i + 1), ...w.post}}));

  // —— 方法笔记 ——
  // 排序必须在截断之前：walk() 的顺序取决于 readdir，同一批笔记在两次读取里可能排成
  // 不同顺序，于是「先是哪 40 篇」会变，n1..n40 也整体位移（ai_cache / 写回口令全都漂）。
  const methods = bucket.methods.slice().sort((a, b) => norm(a.rel).localeCompare(norm(b.rel), 'zh'));
  const notes = methods.slice(0, maxNotes).map((x, i) => {
    const parts = x.rel.split(sep);
    // 展示用 path 保留真实层级：原来只拼 `parts[root]`（一层子目录），
    // 更深的 `方法库/01-流程/子流程/文件.md` 会被压成 `子流程/文件.md`，同名的文件显示成同一个路径。
    const segs = parts.slice(Math.min(x.root, Math.max(0, parts.length - 1)));
    // 至少保留两级：直接躺在 05-方法库/ 根下的文件也带一层目录（契约要求
    // `05-方法库 methods/<子目录>/<文件名>`，否则导入脚本的校验会判格式不对）。
    // 这层目录名必须写成 `未分类` 而不是 parts[len-2]：后者在这里就是 `05-方法库 methods`
    // 本身，拼出来是 `05-方法库 methods/05-方法库 methods/x.md`，图谱会照 parts[1]
    // 再造一个同名的二级目录节点，分析栏的路径也显示成双前缀。
    const tail = segs.length > 1 ? segs.join('/') : ['未分类', ...segs].join('/');
    return {id: 'n' + (i + 1), title: x.title, path: `05-方法库 methods/${tail}`, body: clean(x.body), tags: tagsOf(x.fm, x.body), rel: norm(x.rel), kind: 'note', attachments: x.attachments};
  });

  // —— AI 热点日报（同一张 notes 表，kind 区分；目录是自己的 00-AI热点/）——
  // 同样先按文件名（含日期）倒序再截断：留下的永远是最新的 60 天，而不是「先遍历到的 60 天」。
  const news = bucket.news.slice().sort((a, b) => norm(b.rel).localeCompare(norm(a.rel)));
  news.slice(0, unlimited || 60).forEach((x, i) => {
    const parts = x.rel.split(sep);
    notes.push({id: 'news' + (i + 1), title: x.title, path: `${parts[0]}/${parts.slice(1).join('/') || x.title}`, body: clean(x.body), tags: tagsOf(x.fm, x.body), rel: norm(x.rel), kind: 'news', attachments: x.attachments});
  });

  // —— 个人知识库（灵感 / 制度 / 推文剪藏）：path 保留真实目录（同 news 的做法），
  // frontmatter 的 url / domain / author / snapshot 透传给前端渲染来源信息 ——
  const personal = bucket.personal.slice().sort((a, b) => norm(a.rel).localeCompare(norm(b.rel), 'zh'));
  personal.slice(0, unlimited || 120).forEach((x, i) => {
    const parts = x.rel.split(sep);
    notes.push({
      id: 'p' + (i + 1), title: x.title, path: `${parts[0]}/${parts.slice(1).join('/') || x.title}`,
      body: clean(x.body), tags: tagsOf(x.fm, x.body), rel: norm(x.rel), kind: 'personal', attachments: x.attachments,
      category: String(pick(x.fm, ['category', '分类']) || '').trim(),
      url: String(pick(x.fm, ['url', '链接', 'source']) || '').trim() || undefined,
      domain: String(pick(x.fm, ['domain', '站点']) || '').trim() || undefined,
      author: String(pick(x.fm, ['author', '作者']) || '').trim() || undefined,
      snapshot: String(pick(x.fm, ['snapshot', '快照']) || '').trim() || undefined,
      sourceFile: String(pick(x.fm, ['sourceFile', '来源文件']) || '').trim() || undefined,
      summary: String(pick(x.fm, ['summary', '摘要']) || '').trim() || undefined,
      keyPoints: Array.isArray(x.fm.keyPoints) ? x.fm.keyPoints.map(String).filter(Boolean) : undefined,
      // 前端（pages.jsx 的知识库列表）按 clipped 倒序并显示剪藏日期：剪藏接口写的是 clipped，
      // 上传写的是 uploaded。以前这两个字段没透传，部署模式下列表永远按 rel 排序、日期行不渲染，
      // 而 sample.js 里有 clipped，所以纯静态演示看着是好的。
      clipped: String(pick(x.fm, ['clipped', '剪藏日期', 'clippedAt']) || '').trim() || undefined,
      uploaded: String(pick(x.fm, ['uploaded', '上传日期', 'uploadedAt']) || '').trim() || undefined
    });
  });

  // 同一个 fm id 出现两次（Obsidian 的「制作副本」、Syncthing 的 X.sync-conflict-….md、
  // 从 .trash 里恢复出的同名文件都会保留 id:）会让 files['idea:'+id] 被后者静默覆盖，
  // 索引还会撞 notes 主键让 /api/data 整个 500。给后来者加后缀，保持两份都能读写。
  const uniqueId = () => {
    const used = new Set();
    return raw => {
      let id = String(raw);
      // 老数据的序号 id 保持数字类型（示例数据与前端契约都按数字用），只在真撞车时改成带后缀的字符串
      let out = raw;
      if (used.has(id)) {
        let n = 2;
        while (used.has(id + '-' + n)) n++;
        id = id + '-' + n;
        out = id;
      }
      used.add(id);
      return out;
    };
  };
  const uniqIdea = uniqueId();
  const uniqDraft = uniqueId();

  // —— 选题 ——
  // 排序必须在截断和编号之前，和 methods/news/personal 同理：老数据没有 fm id，编号是
  // `i+1` 这种位置 id，walk() 的顺序（readdir）一变，`idea:3` 就指向另一个文件，
  // files/mtimes/semantic_edges/ai_cache 与前端 persist.refs 会同时挂错对象。
  const ideas = bucket.ideas.slice().sort((a, b) => norm(a.rel).localeCompare(norm(b.rel), 'zh')).map((x, i) => {
    const status = String(pick(x.fm, ['status', '状态']) || '待写');
    // 稳定 ID：创建时写入的 fm id 优先（增删文件不会位移）；老数据回落到序号
    const stableId = String(pick(x.fm, ['id', '编号']) || '').trim();
    return {id: uniqIdea(stableId || i + 1), title: x.title, platform: String(pick(x.fm, ['platform', '平台']) || '小红书'), priority: ['高', '中', '低'].includes(String(pick(x.fm, ['priority', '优先级']))) ? String(pick(x.fm, ['priority', '优先级'])) : '中',
      status: ['待写', '待扩展', '已转草稿'].includes(status) ? status : '待写', note: String(pick(x.fm, ['note', '备注', 'description', '简介']) || clean(x.body).replace(/^#.*\n/, '').trim().slice(0, 120)), sourceNews: String(pick(x.fm, ['sourceNews', '来源热点', '热点日期', 'newsDate']) || '') || undefined, rel: norm(x.rel)};
  });

  // —— 草稿 ——
  // source 关联：优先 fm sourceIdeaId（稳定 id，String 统一比较），回退老格式 fm source=选题标题
  // 同样先排序再编号：草稿的位置 id 是 `draft-N`，顺序不定同样会串对象。
  const drafts = bucket.drafts.slice().sort((a, b) => norm(a.rel).localeCompare(norm(b.rel), 'zh')).map((x, i) => {
    const src = String(pick(x.fm, ['source', '来源选题', '选题']) || '');
    const srcId = String(pick(x.fm, ['sourceIdeaId']) || '').trim();
    const idea = (srcId && ideas.find(d => String(d.id) === srcId)) || ideas.find(d => d.title === src);
    const stableId = String(pick(x.fm, ['id', '编号']) || '').trim();
    // truncated：clean() 把正文截到 6000 字，前端据此判断「这份缓存不是全文」，
    // 必须先把全文拉回来才允许编辑，否则随便敲一个字就把后面的内容截掉写回磁盘。
    const draftBody = clean(x.body);
    const draftFull = x.body.replace(/\r/g, '').trim();
    return {id: uniqDraft(stableId || 'draft-' + (i + 1)), title: x.title, body: draftBody, truncated: draftBody.length < draftFull.length || undefined, source: idea ? idea.id : null,
      platform: String(pick(x.fm, ['platform', '平台']) || '').trim() || undefined, rel: norm(x.rel)};
  });

  // 概念词：至少在两条内容里出现的话题标签，取出现最多的 20 个。
  const count = new Map();
  for (const t of [...works.flatMap(w => w.content.tags), ...notes.flatMap(n => n.tags)]) count.set(t, (count.get(t) || 0) + 1);
  const concepts = [...count].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([t]) => [t, [t.toLowerCase()]]);

  const dates = works.map(w => w.post.date.slice(0, 10)).sort();
  const today = new Date();
  const snapshot = {
    account: opts.account || '我的账号', followers: Number.isFinite(opts.followers) ? opts.followers : null,
    capturedAt: `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`,
    publishedFrom: dates[0] || '', publishedTo: dates[dates.length - 1] || '', source: '导入自本地笔记'
  };

  // 选题与草稿也必须有上限：这两个桶原先全量返回，几百条就会把 /api/data 推到数 MB，
  // 并把图谱节点数推进力导向布局的 N² 区间（手机上一帧几百毫秒）。总数留在 counts 里给 UI 提示。
  const FLOW_LIMIT = 300;
  const ideasOut = ideas.slice(0, unlimited || FLOW_LIMIT);
  const draftsOut = drafts.slice(0, unlimited || FLOW_LIMIT);

  return {
    works, notes, ideas: ideasOut, drafts: draftsOut, concepts, snapshot,
    // unreadable：本次有几个文件没读出来（权限 / 被独占 / 半截文件）。reindex 用它拦住 prune，
    // 否则一次 SMB 抖动就会把那一篇的向量、AI 摘要与语义边永久删掉。
    unreadable,
    counts: {works: works.length, worksTotal: bucket.works.length, notes: notes.length, notesTotal: bucket.methods.length,
      ideas: ideasOut.length, ideasTotal: bucket.ideas.length, drafts: draftsOut.length, draftsTotal: bucket.drafts.length,
      // personal 与实际返回的条数一致：原来报的是全量，个人库超过 120 条时
      // 提示里写着「共 300 条」，页面只有 120 条，用户以为丢了笔记。
      personal: Math.min(bucket.personal.length, 120), personalTotal: bucket.personal.length}
  };
}
