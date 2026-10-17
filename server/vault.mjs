// 笔记库读取与解析：把一个 Markdown 笔记文件夹读成看板数据。
// 只用 Node 自带模块，只读你的笔记、不联网、不修改任何文件。
//
// scripts/import-notes.mjs（一次性导入，生成 src/data/my-data.local.js）和
// server/index.mjs（NAS 上的读写服务）共用这一份，避免两套解析逐渐不一致。
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join, relative, basename, sep} from 'node:path';

export const SKIP = new Set(['.obsidian', '.trash', '.git', 'node_modules', '.DS_Store']);

// —— 读取 Markdown ——
export function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith('.')) continue;
    const p = join(dir, name), st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.toLowerCase().endsWith('.md')) out.push(p);
  }
  return out;
}

// 简化的 YAML frontmatter：key: value、key: [a, b]、以及「- 项」列表。
export function parse(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const fm = {};
  if (m) {
    let key = null;
    for (const raw of m[1].split(/\r?\n/)) {
      const item = raw.match(/^\s*-\s+(.*)$/);
      if (item && key) { if (!Array.isArray(fm[key])) fm[key] = []; fm[key].push(unquote(item[1])); continue; }
      const kv = raw.match(/^([^:#][^:]*):\s*(.*)$/);
      if (!kv) continue;
      key = kv[1].trim();
      const v = kv[2].trim();
      fm[key] = v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1).split(',').map(unquote).filter(Boolean) : v === '' ? '' : unquote(v);
    }
  }
  return {fm, body: m ? text.slice(m[0].length) : text};
}

export const unquote = s => String(s).trim().replace(/^['"]|['"]$/g, '');
export const pick = (fm, keys) => { for (const k of keys) for (const f of Object.keys(fm)) if (f.toLowerCase() === k.toLowerCase() && fm[f] !== '') return fm[f]; return undefined; };
export function num(v) {
  if (v == null || v === '') return null;
  const s = String(v).replace(/[,，\s%秒s]/gi, '');
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
  for (const m of body.matchAll(/(?:^|\s)#([^\s#，。,.!?！？、；;:：()（）[\]]+)/g)) list.push(m[1]);
  return [...new Set(list.map(t => t.replace(/^#/, '').trim()).filter(t => t && !/^\d+$/.test(t)))].slice(0, 12);
}
export const clean = body => body.replace(/\r/g, '').trim().slice(0, 6000);

// —— 分类 ——
export const RULES = [
  ['works', /(作品|works?$|published|已发布)/i],
  ['drafts', /(草稿|创作台|drafts?$|正在写|写作中)/i],
  ['ideas', /(选题|ideas?$|灵感)/i],
  ['methods', /(方法|methods?$|模板|templates?$|流程|workflow|知识|卡片|notes?$)/i]
];
export const norm = p => p.split(/[\\/]/).filter(Boolean).join('/');

// dirs：显式指定的文件夹（{works: [], methods: [], ideas: [], drafts: []}），优先于按文件夹名自动识别。
export function classify(rel, dirs, allAsNotes = false) {
  const d = dirs || {};
  const names = rel.split(sep).slice(0, -1);
  for (const kind of ['works', 'drafts', 'ideas', 'methods']) for (const f of d[kind] || []) {
    const prefix = norm(f);
    if (norm(rel).startsWith(prefix + '/')) return {kind, root: prefix.split('/').length};
  }
  for (let i = 0; i < names.length; i++) for (const [kind, re] of RULES) {
    if ((d[kind] || []).length) continue;
    if (re.test(names[i])) return {kind, root: i + 1};
  }
  return allAsNotes ? {kind: 'methods', root: 0} : null;
}

// 把一个笔记库读成看板数据。返回的形状与 src/data/*.js 的导出一致。
// 额外带回三样东西（导入脚本会剥掉，不进 my-data.local.js）：
//   rel    —— 文件相对 vault 的真实路径，服务端写回时用它定位文件
//   tags   —— 笔记的话题，用于推导概念词
//   counts —— 各模块的篇数，用于进度提示
export function readVault(opts = {}) {
  const vault = opts.vault;
  if (!vault) throw new Error('readVault 需要 vault 参数');
  const dirs = {works: opts.works || [], methods: opts.methods || [], ideas: opts.ideas || [], drafts: opts.drafts || []};
  const maxWorks = opts.maxWorks || 30, maxNotes = opts.maxNotes || 40;

  const bucket = {works: [], methods: [], ideas: [], drafts: []};
  for (const file of walk(vault)) {
    const rel = relative(vault, file), c = classify(rel, dirs, !!opts.allAsNotes);
    if (!c) continue;
    const {fm, body} = parse(readFileSync(file, 'utf8'));
    const title = String(pick(fm, ['title', '标题', 'name']) || basename(file).replace(/\.md$/i, '')).trim();
    bucket[c.kind].push({file, rel, root: c.root, fm, body, title});
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
      duration: num(pick(x.fm, ['duration', '平均观看', '平均观看时长', '时长']))
    };
    return {post: p, content: {title: x.title, body: clean(x.body), tags: tagsOf(x.fm, x.body), media}, rel: norm(x.rel)};
  }).sort((a, b) => b.post.date.localeCompare(a.post.date)).slice(0, maxWorks)
    .map((w, i) => ({...w, post: {id: 'w' + (i + 1), ...w.post}}));

  // —— 方法笔记 ——
  const notes = bucket.methods.slice(0, maxNotes).map((x, i) => {
    const parts = x.rel.split(sep);
    const sub = parts[x.root] && x.root < parts.length - 1 ? parts[x.root] : (parts[x.root - 1] || '笔记');
    return {id: 'n' + (i + 1), title: x.title, path: `05-方法库 methods/${sub}/${parts[parts.length - 1]}`, body: clean(x.body), tags: tagsOf(x.fm, x.body), rel: norm(x.rel)};
  });

  // —— 选题 ——
  const ideas = bucket.ideas.map((x, i) => {
    const status = String(pick(x.fm, ['status', '状态']) || '待写');
    return {id: i + 1, title: x.title, platform: String(pick(x.fm, ['platform', '平台']) || '小红书'), priority: ['高', '中', '低'].includes(String(pick(x.fm, ['priority', '优先级']))) ? String(pick(x.fm, ['priority', '优先级'])) : '中',
      status: ['待写', '待扩展', '已转草稿'].includes(status) ? status : '待写', note: String(pick(x.fm, ['note', '备注', 'description', '简介']) || clean(x.body).replace(/^#.*\n/, '').trim().slice(0, 120)), rel: norm(x.rel)};
  });

  // —— 草稿 ——
  const drafts = bucket.drafts.map((x, i) => {
    const src = String(pick(x.fm, ['source', '来源选题', '选题']) || '');
    const idea = ideas.find(d => d.title === src);
    return {id: 'draft-' + (i + 1), title: x.title, body: clean(x.body), source: idea ? idea.id : null, rel: norm(x.rel)};
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

  return {
    works, notes, ideas, drafts, concepts, snapshot,
    counts: {works: works.length, worksTotal: bucket.works.length, notes: notes.length, notesTotal: bucket.methods.length, ideas: ideas.length, drafts: drafts.length}
  };
}
