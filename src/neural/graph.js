// 神经图谱数据：全部由当前数据源（note-api / my-data.local.js / sample.js）在浏览器中推导。
// 连接来源：笔记正文 [[双链]]、目录归属、选题转草稿记录、选题引用的热点日报、话题标签、
// 正文提及的概念词、两篇内容共同提及 ≥2 个概念时形成的「双向共振」，以及 AI 语义边。
// 分区（partition）：知识笔记和 AI 热点是 knowledge，作品/选题/草稿是 works。两套内容各有各的
// 概念节点和共振；同名概念、共享话题和显式来源关系会自动把两个分区桥接起来。
import {posts, workContent} from './works';
import {notes as notesRaw, concepts as CONCEPTS} from '../data';
import {getData, getFigures} from '../data/store.js';
import {CONFIG} from '../config';
import {T} from './theme';

export const KINDS = {
  core: {label: '创作空间', en: 'Core', color: T.kinds.core},
  folder: {label: '目录', en: 'Folder', color: T.kinds.folder},
  post: {label: '作品', en: 'Work', color: T.kinds.post},
  note: {label: '知识笔记', en: 'Knowledge note', color: T.kinds.note},
  idea: {label: '选题', en: 'Idea', color: T.kinds.idea},
  draft: {label: '草稿', en: 'Draft', color: T.kinds.draft},
  concept: {label: '概念', en: 'Concept', color: T.kinds.concept},
  tag: {label: '话题', en: 'Topic', color: T.kinds.tag},
  news: {label: 'AI 热点', en: 'AI news', color: T.kinds.news},
  personal: {label: '个人收藏', en: 'Knowledge clip', color: T.kinds.personal},
  ghost: {label: '未创建', en: 'Unresolved', color: T.kinds.ghost}
};
export const LINK_KINDS = {
  contain: '目录归属',
  wiki: '[[双链]]',
  source: '选题来源',
  news: '热点依据',
  publish: '发布为作品',
  tag: '话题标签',
  mention: '正文提及',
  resonance: '双向共振',
  bridge: '同名概念',
  semantic: '语义相关'
};
export const LINK_EN = {contain: 'Contains', wiki: 'Wikilink', source: 'Source', news: 'News source', publish: 'Published as', tag: 'Topic', mention: 'Mention', resonance: 'Resonance', bridge: 'Shared concept', semantic: 'Semantic'};
export const CONTENT = new Set(['post', 'note', 'idea', 'draft', 'news', 'personal']);
// 内容分区：方法笔记 / AI 热点 / 个人知识库（knowledge）与作品侧（works）。数据里带 partition 时以数据为准。
export const PARTITION_OF = n => n?.partition || (n?.kind === 'note' || n?.kind === 'news' || n?.kind === 'personal' ? 'knowledge' : 'works');

const FOLDERS = [
  {id: 'f:works', title: '作品库', path: '02-作品库', angle: 180},
  {id: 'f:drafts', title: '创作台', path: '03-创作台', angle: 145},
  {id: 'f:ideas', title: '选题池', path: '04-选题池', angle: 35},
  {id: 'f:methods', title: '方法库', path: '05-方法库 methods', angle: 0},
  {id: 'f:00-AI热点', title: 'AI 热点', path: '00-AI热点', angle: -35},
  {id: 'f:personal', title: '个人知识库', path: '06-个人知识库', angle: -145}
];

// 首页围绕光球的七个模块；角度与图谱布局的目录锚点一致，背景网络会朝各自模块蔓延。
export const MODULES = [
  {id: 'works', title: '作品库', en: 'Works', kind: 'post', folder: 'f:works', angle: 180, icon: 'works', page: 'library'},
  {id: 'concepts', title: '概念网络', en: 'Concepts', kind: 'concept', angle: -90, icon: 'concept'},
  {id: 'methods', title: '方法库', en: 'Methods', kind: 'note', folder: 'f:methods', angle: 0, icon: 'methods', page: 'methods'},
  {id: 'ideas', title: '选题池', en: 'Ideas', kind: 'idea', folder: 'f:ideas', angle: 35, icon: 'idea', page: 'ideas'},
  {id: 'drafts', title: '创作台', en: 'Drafts', kind: 'draft', folder: 'f:drafts', angle: 145, icon: 'draft', page: 'drafts'},
  {id: 'news', title: 'AI 热点', en: 'AI Radar', kind: 'news', folder: 'f:00-AI热点', angle: -35, icon: 'news'},
  {id: 'personal', title: '个人知识库', en: 'Knowledge', kind: 'personal', folder: 'f:personal', angle: -145, icon: 'personal', page: 'knowledge'}
];
export const moduleOf = node => MODULES.find(m => m.kind === node?.kind) || null;

export const cleanTitle = t => String(t || '').replace(/^\d+[A-Z]?-☑️/, '').replace(/^\d+-/, '').replace(/_/g, ' · ');
// 标题归一化：去掉 Obsidian 前缀、编号和多余空白，用于「草稿 → 选题 / 作品」的自动回连。
export const normTitle = t => cleanTitle(String(t || '').replace(/^Obsidian[：:]\s*/i, ''))
  .replace(/[·_\s]+/g, ' ').trim().toLowerCase();
// 作品正文按**同一条作品**取，而不是按标题取：两篇同名作品（不同平台各发一次、
// 或导入时标题重复）会让后一篇拿到前一篇的正文/标签/media，分析栏与封面全错。
// 数组下标对齐时优先用下标（note-api 与 sample 的 postContent 都跟 posts 同序），
// 对不上再退回标题匹配（手写数据可能只给了一部分正文）。
const contentOf = id => {
  const i = posts.findIndex(p => p.id === id);
  if (i < 0) return null;
  const byIdx = workContent[i];
  if (byIdx && byIdx.title === posts[i].title) return byIdx;
  return workContent.find(c => c.title === posts[i].title) || null;
};
export const postMedia = post => contentOf(post.id) || null;

export function buildGraph({ideas = [], drafts = []} = {}) {
  const nodes = new Map();
  const add = n => { if (!nodes.has(n.id)) nodes.set(n.id, {tags: [], text: '', ...n}); return nodes.get(n.id); };
  const edges = new Map();
  const link = (s, t, kind, w = 1) => {
    if (!nodes.has(s) || !nodes.has(t) || s === t) return;
    const [a, b] = s < t ? [s, t] : [t, s];
    const key = a + '|' + b + '|' + kind;
    const e = edges.get(key) || {a, b, kind, ab: 0, ba: 0, w: 0};
    if (s === a) e.ab += 1; else e.ba += 1;
    e.w = Math.max(e.w, w);
    edges.set(key, e);
  };

  add({id: 'core', kind: 'core', title: CONFIG.workspace, path: '/', text: ''});
  for (const f of FOLDERS) { add({...f, kind: 'folder'}); link('core', f.id, 'contain'); }

  // 作品：指标、正文和话题。
  // 作品：指标、正文和话题。
  // cover：postContent 里没有 cover 字段（note-api 只回 title/body/tags/media，sample 也没有），
  // 但 Analyzer / 作品卡都在读它。有显式封面就用，没有就退回这篇的第一个附件——
  // 否则「作品封面」这条分支永远是死代码。
  const figuresOf = getFigures() || {};
  for (const p of posts) {
    const c = contentOf(p.id);
    const cover = c?.cover || figuresOf['post:' + p.id]?.[0] || null;
    add({id: 'post:' + p.id, kind: 'post', title: p.title, short: p.title.replace(/^Obsidian[：:]/, ''), path: '02-作品库/' + p.title, folder: 'f:works', text: p.title + '\n' + (c?.body || ''), body: c?.body || '', date: p.date, post: p, media: c?.media, cover, tags: c?.tags || []});
    link('f:works', 'post:' + p.id, 'contain');
  }

  // 方法笔记与子目录；AI 热点日报（kind: 'news'）挂 00-AI热点 目录节点；
  // 个人知识库（kind: 'personal'：灵感 / 制度 / 推文剪藏）挂 06-个人知识库 目录节点。
  for (const n of notesRaw) {
    // path 缺失/畸形（手写 my-data.local.js、旧导入器产物、Windows 反斜杠路径）时不能直接
    // `n.path.split('/')`：这里抛错发生在模块 import 期，整站白屏，boot 的 try/catch 兜不住。
    const parts = String(n.path || '').split(/[\\/]/).filter(Boolean);
    const isNews = n.kind === 'news';
    const isPersonal = n.kind === 'personal';
    // 方法库根目录下的笔记（05-方法库 methods/foo.md）没有子目录，parts[1] 就是文件名本身：
    // 直接拿它当子目录会造出一个 f:foo.md 幽灵目录节点。与服务端 vault.mjs 一样兜到「未分类」。
    const sub = isNews ? (parts[0] || '00-AI热点') : isPersonal ? '06-个人知识库' : (parts.length > 2 ? parts[1] : '未分类');
    // 个人知识库的目录节点 id 必须复用 FOLDERS 里的 f:personal：
    // 否则会多出一个 f:个人知识库 的重复目录节点，还被当方法库子目录锚到 0° 方向。
    const subId = isPersonal ? 'f:personal' : isNews ? 'f:00-AI热点' : 'f:' + sub;
    if (!isPersonal && !isNews) add({id: subId, kind: 'folder', title: sub.replace(/^\d+-/, '').replace(/\s+[a-z-]+$/i, ''), path: parts.slice(0, 2).join('/'), level: 2});
    link(isNews ? 'f:00-AI热点' : isPersonal ? 'f:personal' : 'f:methods', subId, 'contain');
    const kind = isNews ? 'news' : isPersonal ? 'personal' : 'note';
    // 前缀必须和 note-api 的 noteNodeId() 一致：日报也是 note:（服务端 /api/note 的 id 映射、
    // 以及 /api/ai/relate 写出的语义边都用 note:）。用 news: 会让日报既不能编辑正文，也永远接不上语义边。
    const id = (isPersonal ? 'personal:' : 'note:') + n.id;
    add({id, kind, title: n.title, short: cleanTitle(n.title), path: n.path, folder: subId, partition: n.partition || 'knowledge', text: n.title + '\n' + n.body, body: n.body, tags: n.tags || [],
      ...(isPersonal ? {personal: n} : {})});
    link(subId, id, 'contain');
  }

  for (const i of ideas) {
    add({id: 'idea:' + i.id, kind: 'idea', title: i.title || '未命名选题', short: i.title, path: '04-选题池/' + i.title, folder: 'f:ideas', text: i.title + '\n' + (i.note || ''), idea: i});
    link('f:ideas', 'idea:' + i.id, 'contain');
  }
  for (const d of drafts) {
    add({id: 'draft:' + d.id, kind: 'draft', title: d.title || '未命名草稿', short: d.title, path: '03-创作台/正在写/' + d.title, folder: 'f:drafts', text: d.title + '\n' + (d.body || ''), body: d.body || '', draft: d});
    link('f:drafts', 'draft:' + d.id, 'contain');
  }

  // 选题 ⇄ 草稿：草稿记录来源选题；没有 source 时按同名标题回连（导入或手工草稿也能自动接上）。
  for (const d of drafts) {
    let idea = d.source != null ? ideas.find(i => i.id === d.source) : null;
    if (!idea) idea = ideas.find(i => normTitle(i.title) === normTitle(d.title));
    if (!idea) continue;
    link('draft:' + d.id, 'idea:' + idea.id, 'source');
    if (idea.status === '已转草稿') link('idea:' + idea.id, 'draft:' + d.id, 'source');
  }

  // 草稿 → 作品：标题归一化后相同即视为这篇草稿已经发布。发布后通常会把文件移进
  // 02-作品库，标题保持不变，这条边让创作台和作品库自动接上。
  // 同名标题只认同一条（先注册的优先）：两篇同名作品时，后写覆盖会让所有同名草稿
  // 都指到「列表靠后的那一篇」，看起来像随机连错。
  const postByTitle = new Map();
  for (const p of posts) {
    const k = normTitle(p.title);
    if (!postByTitle.has(k)) postByTitle.set(k, 'post:' + p.id);
  }
  for (const d of drafts) {
    const pid = postByTitle.get(normTitle(d.title));
    if (pid) link('draft:' + d.id, pid, 'publish');
  }

  // 选题 → 作品：发布接口（/api/publish）会把来源选题的稳定 id 写进作品 frontmatter，
  // 因为草稿文件发布后被移走，上面那条标题回连就不再成立。这条边补上「选题 → 草稿 → 作品」
  // 的最后一跳；没有该字段的老作品不连（不猜标题，避免同名错连）。
  const ideaById = new Map(ideas.map(i => [String(i.id), i]));
  for (const p of posts) {
    const idea = p.sourceIdeaId ? ideaById.get(String(p.sourceIdeaId)) : null;
    if (idea) link('post:' + p.id, 'idea:' + idea.id, 'source');
  }

  // 热点日报 → 选题：自动生成的选题在 frontmatter 里记录 sourceNews（YYYY-MM-DD）。
  // 日报节点按路径/标题里的日期匹配，手动建的选题没有这个字段就不连。
  const newsByDate = new Map();
  for (const n of nodes.values()) {
    if (n.kind !== 'news') continue;
    const date = (String(n.path || '').match(/(\d{4}-\d{2}-\d{2})\.md$/) || String(n.title || '').match(/(\d{4}-\d{2}-\d{2})/))?.[1];
    if (date && !newsByDate.has(date)) newsByDate.set(date, n.id);
  }
  for (const i of ideas) {
    const date = String(i.sourceNews || '').match(/(\d{4}-\d{2}-\d{2})/)?.[1];
    const newsId = date && newsByDate.get(date);
    if (newsId) link('idea:' + i.id, newsId, 'news');
  }

  // [[双链]]：方法笔记与草稿正文。能对应到现有内容即为实链，否则是「未创建」笔记。
  const byName = new Map();
  // 同名笔记（不同子目录）同样只认先注册的：后写覆盖会让 [[同名]] 静默连到顺序靠后的那篇。
  for (const n of nodes.values()) if (CONTENT.has(n.kind)) {
    const t = String(n.title).toLowerCase();
    if (!byName.has(t)) byName.set(t, n.id);
    const base = n.path ? String(n.path).split(/[\\/]/).pop().replace(/\.md$/, '').toLowerCase() : '';
    if (base && !byName.has(base)) byName.set(base, n.id);
  }
  for (const n of [...nodes.values()]) {
    if (n.kind !== 'note' && n.kind !== 'draft') continue;
    const wikiLink = (target, alias) => {
      if (target.includes('{{')) return;
      // 目标先去锚点/路径，再剥 .md：byName 注册文件名时已经剥过扩展名（上面 194 行），
      // 这里不剥的话 [[观察记录方法.md]] 永远命中不了，会造一个 ghost 节点，
      // 还沿用它拼出 `观察记录方法.md.md` 的假路径。
      const name = target.split('#')[0].split('/').pop().replace(/\.md$/i, '').trim();
      if (!name) return;
      let id = byName.get(name.toLowerCase());
      if (!id) {
        id = 'ghost:' + name.toLowerCase();
        // ghost 继承来源节点的分区：否则 PARTITION_OF 把「未创建」一律算进作品侧，
        // 方法笔记指向的未创建笔记会被锚到作品的方位，moduleOf 也变成 null。
        add({id, kind: 'ghost', title: alias?.trim() || name, short: alias?.trim() || cleanTitle(name), path: target.trim() + '.md', text: '', partition: n.partition || 'works'});
      }
      link(n.id, id, 'wiki');
    };
    // Obsidian 双链 [[目标|别名]]
    for (const m of (n.body || '').matchAll(/\[\[([^\]]+)\]\]/g)) wikiLink(...m[1].split('|'));
    // 中性链接 [标题](相对路径.md)：标准 Markdown 语法，与 [[双链]] 等效（obsidian-independence P2）。
    // 目标先剥掉 .md 扩展名（与 byName 注册口径一致），否则命中不了已有笔记、会误建带 .md 的 ghost。
    for (const m of (n.body || '').matchAll(/\[([^\]]+)\]\(([^)\s]+\.md)\)/g)) wikiLink(m[2].replace(/\.md$/i, ''), m[1]);
  }

  // 话题标签：frontmatter 的 tags 与正文里的 #话题 都自动成为节点（大小写合并）。
  // `#` 前面的字符不限于空白：中文写作里「这条讲的是#选题方法论」极常见，原来只认
  // 行首或空格，整类话题被静默丢掉。服务端 server/vault.mjs 用同一个正则，两处要同步。
  const HASHTAG_RE = /(?:^|[\s，。,.!?！？、；;:：()（）\[\]{}【「《>])#([^\s#，。,.!?！？、；;:：()（）\[\]{}]+)/g;
  const hashtagsOf = text => {
    const out = [];
    for (const m of String(text || '').matchAll(HASHTAG_RE)) {
      const t = m[1].replace(/^#/, '').trim();
      if (t && !/^\d+$/.test(t)) out.push(t);
    }
    return [...new Set(out)];
  };
  for (const n of nodes.values()) {
    if (!CONTENT.has(n.kind)) continue;
    // 去重按小写比，但保留第一次出现的原始写法：#AI热点 与 #ai热点 是同一个话题节点的
    // 同一个 id（tag: 前缀统一 toLowerCase），不合并就会把同一条边连两遍，
    // link() 的 ab/ba 各加一次 → 本该单向的「话题」边被画成双向，UI 还多一个 chip。
    const seen = new Map();
    for (const t of [...(n.tags || []), ...hashtagsOf(n.text)]) {
      const k = String(t).toLowerCase();
      if (k && !seen.has(k)) seen.set(k, String(t));
    }
    n.tags = [...seen.values()].slice(0, 12);
  }
  for (const n of [...nodes.values()]) for (const tag of n.tags || []) {
    const id = 'tag:' + tag.toLowerCase();
    add({id, kind: 'tag', title: '#' + tag, short: '#' + tag, text: ''});
    link(n.id, id, 'tag');
  }

  // 概念提及 + 双向共振（概念词表见 src/data/sample.js）。
  // 按分区各建一套概念节点：方法笔记的「Agent」和作品的「Agent」是两个节点，图谱上各成各的团。
  const content = [...nodes.values()].filter(n => CONTENT.has(n.kind));
  // 正文（最长 6000 字）只小写一次：原来每个 (概念 × 节点) 组合都要 toLowerCase 一遍，
  // 20 个概念 × 1500 节点 = 3 万次、累计上亿字符的临时分配，一次刷新多花 0.2–0.5 s。
  const lowOf = new Map(content.map(n => [n.id, String(n.text || '').toLowerCase()]));
  const mentions = new Map();
  // 词表里的词可能是中文（子串匹配）或拉丁（必须按词边界匹配）。
  // ・拉丁词用 includes 会在别的单词里命中：「AI」→ ai 命中 said / email / main，
  //   于是凭空长出概念节点，还会凑够两条共现长出 resonance 边；
  // ・反过来，手写词表 ["AI", ["AI"]] 时正文已小写、词没小写，永远命中不了，概念整体消失。
  // 所以：词先小写；纯拉丁词用前后不能粘字母数字的边界匹配，其余仍按子串。
  const matchersOf = terms => terms
    .map(t => String(t).toLowerCase().trim())
    .filter(Boolean)
    .map(t => {
      if (!/^[a-z0-9][a-z0-9 +#._-]*$/.test(t)) return text => text.includes(t);
      const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return text => new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`).test(text);
    });
  for (const [name, terms] of CONCEPTS) {
    const byPart = new Map();
    const match = matchersOf(terms);
    for (const n of content) {
      const low = lowOf.get(n.id) || '';
      if (!match.some(f => f(low))) continue;
      const p = PARTITION_OF(n);
      byPart.set(p, [...(byPart.get(p) || []), n]);
    }
    for (const [p, hits] of byPart) {
      if (hits.length < 2) continue; // 至少两条内容提及才成为节点
      const id = p === 'knowledge' ? 'concept:kb:' + name : 'concept:' + name;
      add({id, kind: 'concept', title: name, short: name, text: '', terms, partition: p});
      for (const h of hits) { link(h.id, id, 'mention'); mentions.set(h.id, [...(mentions.get(h.id) || []), p + ':' + name]); }
    }
  }
  // 两两求交用 Set：这是 O(N²/2) 的全对循环，用 Array.includes 在内层扫 20 元素数组，
  // 1500 条内容就是 110 万对；Set 版在内层是 O(1)。
  const mentionSets = new Map([...mentions].map(([k, v]) => [k, new Set(v)]));
  for (let i = 0; i < content.length; i++) for (let j = i + 1; j < content.length; j++) {
    const A = mentions.get(content[i].id), B = mentionSets.get(content[j].id);
    if (!A || !B) continue;
    const shared = A.filter(x => B.has(x));
    if (shared.length >= 2) { link(content[i].id, content[j].id, 'resonance', shared.length); link(content[j].id, content[i].id, 'resonance', shared.length); }
  }

  // 同名概念桥：知识分区（方法笔记 / AI 热点）和作品分区各有一个同名概念节点时，自动连一条桥。
  const conceptByName = new Map();
  for (const n of nodes.values()) if (n.kind === 'concept') {
    const group = conceptByName.get(n.title.toLowerCase()) || {};
    group[PARTITION_OF(n)] = n.id;
    conceptByName.set(n.title.toLowerCase(), group);
  }
  for (const group of conceptByName.values()) if (group.knowledge && group.works) link(group.knowledge, group.works, 'bridge');

  // AI 语义边（/api/ai/relate 的 embedding 结果）。服务端持久化，前端任务完成后也会
  // 通过 setSemantic 更新运行时仓，所以图谱无需刷新就能重建。
  // 语义相关本来没有方向：同一对以 a→b、b→a 两条进来时必须先去重，
  // 否则 link() 的 ab/ba 各加一次 → both:true，stats.mutual 与节点的「双向」计数虚增。
  const seenPairs = new Set();
  for (const e of (getData().semantic || [])) {
    if (!e?.a || !e?.b || e.a === e.b) continue;
    const [x, y] = e.a < e.b ? [e.a, e.b] : [e.b, e.a];
    const pair = x + '\u0000' + y;
    if (seenPairs.has(pair)) continue;
    seenPairs.add(pair);
    link(x, y, 'semantic', e.sim ? Math.max(1, Math.round(e.sim * 10)) : 1);
  }

  const list = [...nodes.values()];
  const links = [...edges.values()].map(e => ({...e, both: e.ab > 0 && e.ba > 0, s: e.ab ? e.a : e.b, t: e.ab ? e.b : e.a}));
  for (const n of list) { n.out = 0; n.in = 0; n.deg = 0; n.mutual = 0; }
  const idx = new Map(list.map(n => [n.id, n]));
  for (const l of links) {
    const A = idx.get(l.a), B = idx.get(l.b);
    if (l.kind === 'contain') continue;
    A.deg++; B.deg++;
    if (l.both) { A.mutual++; B.mutual++; A.out++; B.out++; A.in++; B.in++; }
    else { idx.get(l.s).out++; idx.get(l.t).in++; }
  }
  for (const n of list) {
    n.shared = mentions.get(n.id) || [];
    // shared 里存的是「分区:概念名」（knowledge:复盘），比较时要用带前缀的键，
    // 但界面上直接 join 会显示成 works:复盘。另给一份只有概念名的视图供展示用。
    n.sharedNames = n.shared.map(s => s.slice(s.indexOf(':') + 1));
  }
  return {nodes: list, links, index: idx};
}

// 同一对内容之间可能同时有多种连接（如互相双链 + 双向共振），每个对象只保留一条：双向优先，其次权重高的。
export function neighbors(graph, id) {
  const best = new Map();
  const rank = x => (x.dir === 'mutual' ? 100 : 0) + x.link.w;
  for (const l of graph.links) {
    if ((l.a !== id && l.b !== id) || l.kind === 'contain') continue;
    const other = l.a === id ? l.b : l.a;
    const item = {id: other, link: l, dir: l.both ? 'mutual' : l.s === id ? 'out' : 'back'};
    const prev = best.get(other);
    if (!prev || rank(item) > rank(prev)) best.set(other, item);
  }
  const lists = {out: [], back: [], mutual: []};
  for (const x of best.values()) lists[x.dir].push({id: x.id, link: x.link});
  return lists;
}

// 二度关联：没有直接相连，但共享概念或话题的内容。
export function latent(graph, id) {
  const near = new Set([id, ...graph.links.filter(l => l.a === id || l.b === id).map(l => l.a === id ? l.b : l.a)]);
  const hubs = graph.links.filter(l => (l.a === id || l.b === id) && (l.kind === 'mention' || l.kind === 'tag')).map(l => l.a === id ? l.b : l.a);
  const score = new Map();
  for (const h of hubs) for (const l of graph.links) {
    if (l.a !== h && l.b !== h) continue;
    const other = l.a === h ? l.b : l.a;
    if (near.has(other) || !CONTENT.has(graph.index.get(other)?.kind)) continue;
    score.set(other, [...(score.get(other) || []), graph.index.get(h).title]);
  }
  return [...score].sort((a, b) => b[1].length - a[1].length).map(([other, via]) => ({id: other, via}));
}

export function stats(graph) {
  const content = graph.nodes.filter(n => CONTENT.has(n.kind));
  const real = graph.links.filter(l => l.kind !== 'contain');
  // 有连接的内容节点用 Set 一次收集：原来每个节点都对全部链接 some() 一遍
  // （1500×4000 = 600 万次比较），而 Home 每次 render 都会调用 stats()。
  const touched = new Set();
  for (const l of real) { touched.add(l.a); touched.add(l.b); }
  return {
    content: content.length,
    links: real.length,
    mutual: real.filter(l => l.both).length,
    wiki: graph.links.filter(l => l.kind === 'wiki').length,
    ghosts: graph.nodes.filter(n => n.kind === 'ghost').length,
    lonely: content.filter(n => !touched.has(n.id)).length,
    backlinked: content.filter(n => n.in > 0).length
  };
}

// —— 布局 ——
function rng(seed) { let s = 0; for (const c of seed) s = (s * 31 + c.charCodeAt(0)) >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const rad = d => d * Math.PI / 180;

// 上一次算好的位置。数据刷新（AI 语义边写回、外部改动轮询命中、任何一次保存后的
// refreshData）都会重建图谱，而 forceLayout 是 O(N²×iters)：1500 节点 ≈ 1 亿次两两运算，
// 同步跑在主线程上要 1.5–2.5 s（手机上更久）。已有节点沿用旧位置、只对新节点做松弛，
// 视觉上还是「小范围漂移」而不是整张图重排一次。
const lastPos = new Map();

export function forceLayout(graph) {
  const N = graph.nodes, idx = graph.index;
  const anchor = id => {
    const n = idx.get(id);
    // 概念各归各的分区：作品侧偏左上、方法笔记侧偏右上，两团在图上分开
    if (n.kind === 'concept') return PARTITION_OF(n) === 'knowledge' ? [.62, -.78] : [-.62, -.78];
    const f = FOLDERS.find(f => f.id === (n.level === 2 ? 'f:methods' : n.folder) || f.id === id);
    return f ? [Math.cos(rad(f.angle)), Math.sin(rad(f.angle))] : null;
  };
  let fresh = 0;
  for (const n of N) {
    const prev = lastPos.get(n.id);
    if (prev) { n.x = prev[0]; n.y = prev[1] / .82; n.vx = 0; n.vy = 0; continue; }
    fresh++;
    const r = rng(n.id), a = anchor(n.id);
    const R = n.kind === 'core' ? 0 : n.kind === 'folder' ? (n.level ? 300 : 210) : CONTENT.has(n.kind) ? 330 : 420;
    const base = a ? Math.atan2(a[1], a[0]) : r() * Math.PI * 2;
    const ang = base + (r() - .5) * (a ? 1.1 : 6.28);
    n.x = Math.cos(ang) * R * (0.8 + r() * .4); n.y = Math.sin(ang) * R * (0.8 + r() * .4); n.vx = 0; n.vy = 0;
  }
  const rest = {contain: 120, wiki: 95, source: 90, news: 110, publish: 130, tag: 52, mention: 135, resonance: 170, bridge: 240, semantic: 150};
  const strength = {contain: .05, wiki: .06, source: .08, news: .06, publish: .06, tag: .09, mention: .018, resonance: .006, bridge: .004, semantic: .008};
  // 迭代数按节点数分档：520 轮全对迭代是 O(N²)，上千节点在手机上要几秒，
  // 而布局每次数据刷新与每段草稿停顿都会重算——节点多时先降迭代数，观感损失远小于白帧。
  const iters = N.length > 1200 ? 90 : N.length > 700 ? 160 : N.length > 400 ? 300 : 520;
  // 位置已经沿用上一次的热启动时，只需要小幅松弛：绝大多数节点没动，重排 90 轮纯属浪费。
  const warm = N.length > 200 && fresh / Math.max(1, N.length) < .15;
  // 一条新节点都没有（fresh === 0）时全部位置都能原样沿用，迭代只会把它们从上次的结果上
  // 推走：直接 0 轮。数据每次刷新、每段草稿停顿都会走到这里，上千节点时这是白帧的主因。
  const steps = fresh === 0 ? 0 : warm ? Math.max(12, Math.round(iters * .3)) : iters;
  for (let it = 0; it < steps; it++) {
    const alpha = 1 - it / steps;
    for (let i = 0; i < N.length; i++) for (let j = i + 1; j < N.length; j++) {
      const A = N[i], B = N[j];
      let dx = B.x - A.x, dy = B.y - A.y, d2 = dx * dx + dy * dy || .01;
      const charge = (A.kind === 'tag' || B.kind === 'tag' ? 900 : 2600) * (A.kind === 'folder' && B.kind === 'folder' ? 3 : 1);
      const f = charge / d2 * alpha, d = Math.sqrt(d2);
      dx /= d; dy /= d;
      A.vx -= dx * f; A.vy -= dy * f; B.vx += dx * f; B.vy += dy * f;
    }
    for (const l of graph.links) {
      const A = idx.get(l.a), B = idx.get(l.b);
      const dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy) || .01;
      const k = (d - rest[l.kind]) * strength[l.kind] * alpha;
      A.vx += dx / d * k; A.vy += dy / d * k; B.vx -= dx / d * k; B.vy -= dy / d * k;
    }
    for (const n of N) {
      const a = anchor(n.id);
      if (n.kind === 'folder' && a) { const R = n.level ? 300 : 230; n.vx += (a[0] * R - n.x) * .04; n.vy += (a[1] * R - n.y) * .04; }
      else if (a && CONTENT.has(n.kind)) { n.vx += (a[0] * 380 - n.x) * .006; n.vy += (a[1] * 380 - n.y) * .006; }
      else if (a) { n.vx += (a[0] * 300 - n.x) * .004; n.vy += (a[1] * 300 - n.y) * .004; }
      n.vx -= n.x * .002; n.vy -= n.y * .002;
      if (n.kind === 'core') { n.x = 0; n.y = 0; n.vx = 0; n.vy = 0; continue; }
      n.x += n.vx; n.y += n.vy; n.vx *= .55; n.vy *= .55;
    }
  }
  lastPos.clear();
  for (const n of N) lastPos.set(n.id, [n.x, n.y * .82]);
  return Object.fromEntries(N.map(n => [n.id, [n.x, n.y * .82]]));
}

// 放射层级：以创作空间为圆心，按链接层数排成同心环。
export function radialLayout(graph) {
  const depth = new Map([['core', 0]]), parent = new Map(), q = ['core'];
  const adj = new Map(graph.nodes.map(n => [n.id, []]));
  const order = {contain: 0, source: 1, news: 1, publish: 1, wiki: 1, semantic: 2, tag: 2, mention: 3, resonance: 4, bridge: 5};
  for (const l of [...graph.links].sort((a, b) => order[a.kind] - order[b.kind])) { adj.get(l.a).push(l.b); adj.get(l.b).push(l.a); }
  while (q.length) { const id = q.shift(); for (const o of adj.get(id)) if (!depth.has(o)) { depth.set(o, depth.get(id) + 1); parent.set(o, id); q.push(o); } }
  const pos = {core: [0, 0]};
  // 子节点表与叶子数都预计算：kids() 原来是「每个节点过滤一遍全部节点」（O(N²)），
  // leaves() 还在这之上递归重复计算，1500 节点时一次布局要做几百万次比较。
  const childMap = new Map();
  for (const n of graph.nodes) {
    const p = parent.get(n.id);
    if (!p) continue;
    if (!childMap.has(p)) childMap.set(p, []);
    childMap.get(p).push(n.id);
  }
  const kids = id => childMap.get(id) || [];
  const leafMemo = new Map();
  const leaves = id => {
    const hit = leafMemo.get(id);
    if (hit != null) return hit;
    const k = kids(id);
    const v = k.length ? k.reduce((s, c) => s + leaves(c), 0) : 1;
    leafMemo.set(id, v);
    return v;
  };
  const place = (id, a0, a1) => {
    const k = kids(id); let a = a0; const total = k.reduce((s, c) => s + leaves(c), 0) || 1;
    for (const c of k) {
      const span = (a1 - a0) * leaves(c) / total, mid = a + span / 2, R = [0, 150, 290, 410, 520][Math.min(depth.get(c), 4)];
      pos[c] = [Math.cos(mid) * R, Math.sin(mid) * R * .82];
      place(c, a, a + span); a += span;
    }
  };
  place('core', -Math.PI, Math.PI);
  // 没接上 core 的节点（只在 semantic / wiki 之间成团、或 ghost 孤立）以前全部堆在 (0,560)，
  // 一堆节点完全重叠、点不中任何单个。按序号沿最外环铺开，至少每个都点得到。
  const orphan = graph.nodes.filter(n => !pos[n.id]).map(n => n.id);
  orphan.forEach((id, i) => {
    const a = -Math.PI + (Math.PI * 2 * (i + 0.5)) / orphan.length;
    pos[id] = [Math.cos(a) * 600, Math.sin(a) * 600 * .82];
  });
  return pos;
}

// —— 本地图谱检索（规则匹配，未调用 AI）——
// 检索词：中文没有空格，整句会被当成一个 token，`title.includes(整句)` 几乎永不命中
// （「哪些笔记提到了提示词工程」这类问句在改造前一律落到「没有找到匹配」）。
// 所以拆成单字 + 相邻二元组：二元组更像词，权重高；英文/数字串整体当一个词。
const searchTerms = q => {
  const chunks = String(q || '').replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
  const out = new Map();
  for (const c of chunks) {
    if (/^[A-Za-z0-9]+$/.test(c)) { out.set(c.toLowerCase(), 3); continue; }
    const chars = [...c];
    if (chars.length === 1) { out.set(c, 1); continue; }
    for (let i = 0; i < chars.length - 1; i++) {
      const t = chars[i] + chars[i + 1];
      out.set(t, Math.max(out.get(t) || 0, 2));
    }
  }
  return [...out];
};

export function askGraph(graph, question, scope) {
  const q = question.trim();
  const C = graph.nodes.filter(n => CONTENT.has(n.kind));
  const real = graph.links.filter(l => l.kind !== 'contain');
  const name = id => graph.index.get(id)?.short || graph.index.get(id)?.title;
  const cards = [];
  // 命中一个意图就不再走兜底搜索；但意图之间不再互斥（单链 if/else-if 时，
  // 问「孤立作品里有没有未创建链接」只会得到第一张卡）。
  let matched = false;
  const on = (re, fn) => { if (!re.test(q)) return; matched = true; fn(); };
  on(/孤|没有连接|没链接|零散|断开/, () => {
    const lonely = C.filter(n => !real.some(l => l.a === n.id || l.b === n.id));
    const weak = C.filter(n => n.in === 0 && !lonely.includes(n));
    cards.push({tone: 'warn', title: '孤立内容', en: 'Isolated', text: lonely.length ? `${lonely.length} 条内容除了目录外没有任何连接。` : '没有完全孤立的内容。', items: lonely.map(n => n.id)});
    cards.push({tone: 'info', title: '没有反链的内容', en: 'No backlinks', text: `${weak.length} 条内容只向外链接，还没有被其他内容引用。`, items: weak.slice(0, 8).map(n => n.id)});
  });
  on(/双向|互链|共振|互相/, () => {
    const mutual = real.filter(l => l.both).sort((a, b) => b.w - a.w);
    cards.push({tone: 'gold', title: '双向连接', en: 'Bidirectional', text: `共 ${mutual.length} 组：正文共同提及 ≥2 个概念，或选题与草稿互相记录。`, pairs: mutual.slice(0, 8).map(l => [l.a, l.b, l.kind === 'resonance' ? `共同提及 ${l.w} 个概念` : LINK_KINDS[l.kind]])});
  });
  on(/未创建|空链|断链|缺/, () => {
    const ghosts = graph.nodes.filter(n => n.kind === 'ghost');
    cards.push({tone: 'warn', title: '未创建的笔记', en: 'Unresolved links', text: `${ghosts.length} 个 [[双链]] 指向尚未在看板资料中出现的笔记，多来自生成模板。`, items: ghosts.map(n => n.id)});
  });
  on(/核心|枢纽|中心|最重要|反链最多|被引用/, () => {
    const top = [...C].sort((a, b) => (b.in + b.mutual) - (a.in + a.mutual) || b.deg - a.deg).slice(0, 6);
    cards.push({tone: 'gold', title: '连接最密的内容', en: 'Most connected', text: '按反链与双向连接数排序。', items: top.map(n => n.id), meta: top.map(n => `${n.deg} 条连接`)});
    // 概念按分区各有节点（同名两条），这里按名字合并报数
    const groups = new Map();
    for (const n of graph.nodes) if (n.kind === 'concept') {
      const g = groups.get(n.title) || {name: n.title, deg: 0, ids: []};
      g.deg += n.deg; g.ids.push(n.id); groups.set(n.title, g);
    }
    const hubs = [...groups.values()].sort((a, b) => b.deg - a.deg).slice(0, 5);
    cards.push({tone: 'info', title: '最常被提及的概念', en: 'Top concepts', text: hubs.map(h => `${h.name}（${h.deg}）`).join('、'), items: hubs.flatMap(h => h.ids)});
  });
  on(/下一篇|写什么|选题|延伸/, () => {
    // 只取连接最多的 8 条选题：300 条选题全量出卡会把面板淹没，而且每条都要跑一次 latent()（全图扫描）。
    const ideas = C.filter(n => n.kind === 'idea').sort((a, b) => b.deg - a.deg).slice(0, 8);
    for (const idea of ideas) {
      const rel = latent(graph, idea.id).filter(r => graph.index.get(r.id)?.kind === 'post');
      cards.push({tone: 'info', title: idea.short, en: 'Next piece', text: rel.length ? `可以延伸 ${rel.length} 篇已发布作品，共享：${[...new Set(rel.flatMap(r => r.via))].slice(0, 4).join('、')}` : '暂未与已发布作品共享概念，可补充正文后再看。', items: [idea.id, ...rel.slice(0, 3).map(r => r.id)]});
    }
    if (!ideas.length) cards.push({tone: 'info', title: '还没有选题', en: 'Next piece', text: '在选题池里新建一条选题，这里会给出可以延伸的作品。', items: []});
  });
  on(/表现|观看|最好|数据|收藏/, () => {
    const ps = C.filter(n => n.kind === 'post').sort((a, b) => b.post.views - a.post.views);
    // 空库必须给文案而不是 ps[0].short：纯静态模式/新 vault 里没有已发布作品，
    // 这里一抛错，Assistant 的 busy 状态就再也回不来（发送按钮永久禁用）。
    cards.push(ps.length
      ? {tone: 'gold', title: '作品表现', en: 'Performance', text: `观看最高：${ps[0].short}（${ps[0].post.views}）。下面按观看排序。`, items: ps.map(n => n.id), meta: ps.map(n => `${n.post.views} 观看 · ${n.post.saves} 收藏`)}
      : {tone: 'info', title: '作品表现', en: 'Performance', text: '还没有已发布的作品，发布并回填指标后再看。', items: []});
  });
  if (!matched) {
    const terms = searchTerms(q);
    // 每个节点的小写长文只算一次并缓存：否则每次提问都要把上千条正文各 toLowerCase() 一遍。
    const hay = n => n._hay || (n._hay = (String(n.title) + ' ' + (n.text || '') + ' ' + (n.path || '')).toLowerCase());
    const hits = graph.nodes.filter(n => n.kind !== 'core').map(n => {
      const h = hay(n), tl = String(n.title).toLowerCase();
      let score = 0;
      for (const [w, weight] of terms) score += tl.includes(w) ? weight * 2 : h.includes(w) ? weight : 0;
      return {n, score};
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 8);
    cards.push(hits.length
      ? {tone: 'info', title: `与「${q}」相关`, en: 'Search', text: `在标题、正文和路径中找到 ${hits.length} 处匹配。点击可聚焦。`, items: hits.map(h => h.n.id)}
      : {tone: 'warn', title: '没有找到匹配', en: 'No match', text: '试试：孤立内容、双向连接、未创建的笔记、核心内容、下一篇写什么。', items: []});
  }
  if (scope) cards.forEach(c => { if (c.items) c.items.sort((a, b) => (b === scope) - (a === scope)); });
  return cards.map(c => ({...c, names: (c.items || []).map(name)}));
}
