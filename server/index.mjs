// note-api：笔记库的读写服务。看板前端从这里取数据、存笔记。
//
// 只用 Node 自带模块（node:http / node:sqlite / node:fs / node:child_process），零依赖、无需原生编译。
//
// 设计要点：
//   * .md 文件是唯一真相。服务只读写文件，SQLite 只是可删可重建的索引。
//   * 写入一律走「最小侵入改写」（见 frontmatter.mjs）：只动指定的 frontmatter 键和正文。
//   * 写前留底到 vault/.trash/，vault 是 git 仓库时自动提交，误写可回滚。
//   * 带 mtime 的乐观锁：文件在别处被改过就返回 409，绝不静默覆盖。
//
// 环境变量：
//   VAULT_DIR   笔记库目录（必填）
//   DATA_DIR    索引与运行时数据目录（默认 <cwd>/.note-api）
//   PORT        监听端口（默认 8787）
//   HOST        监听地址（默认 0.0.0.0）
//   STATIC_DIR  可选：同时托管前端构建产物 dist/，省掉单独的 nginx
//   API_TOKEN   可选：设了之后所有 /api 请求都要带 Authorization: Bearer <token>
//   VAULT_GIT   '1' 开启写入后自动 git commit（默认开启，vault 不是仓库时自动跳过）
import {createServer} from 'node:http';
import {readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync, renameSync} from 'node:fs';
import {join, resolve, sep, dirname, extname, posix} from 'node:path';
import {execFileSync} from 'node:child_process';
import {readVault, parse} from './vault.mjs';
import {writeDoc, hasKey, attachmentsOf} from './frontmatter.mjs';
import {openIndex, hashOf, cosine} from './db.mjs';
import {aiEnabled, embedEnabled, aiInfo, analyzeNote, generateIdeas, answer, embed, listModels, validModel, TASK_MODELS} from './ai.mjs';
import {refreshNews, forceRefresh, startNewsCron, listNews, ideasFromNews} from './news.mjs';
import {randomUUID} from 'node:crypto';

const VAULT = resolve(process.env.VAULT_DIR || '');
const DATA_DIR = resolve(process.env.DATA_DIR || '.note-api');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const STATIC_DIR = process.env.STATIC_DIR ? resolve(process.env.STATIC_DIR) : null;
const API_TOKEN = process.env.API_TOKEN || '';
const VAULT_GIT = process.env.VAULT_GIT !== '0';
const MAX_BODY = Number(process.env.MAX_BODY || 2 * 1024 * 1024);
const KIND_DIR = {idea: '04-选题池', draft: '03-创作台', note: '05-方法库', post: '02-作品库', news: '00-AI热点'};

if (!process.env.VAULT_DIR) {
  console.error('请用 VAULT_DIR 指定笔记库目录，例如：VAULT_DIR=./examples/vault node server/index.mjs');
  process.exit(1);
}
if (!existsSync(VAULT) || !statSync(VAULT).isDirectory()) {
  console.error(`笔记库目录不存在：${VAULT}`);
  process.exit(1);
}

const index = openIndex(join(DATA_DIR, 'index.sqlite'));

// —— 通用小工具 ——
class HttpError extends Error {
  constructor(code, message, extra) { super(message); this.code = code; this.extra = extra; }
}
const fail = (code, message, extra) => { throw new HttpError(code, message, extra); };

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store'});
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) fail(413, '请求体过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, '请求体不是合法 JSON'); }
}

// 把客户端给的相对路径钉死在笔记库内部，只允许 .md。
function inside(rel) {
  const raw = String(rel || '').replace(/\\/g, '/').trim();
  if (!raw || raw.includes('\0')) fail(400, '缺少路径');
  if (!raw.toLowerCase().endsWith('.md')) fail(400, '只允许读写 .md 文件');
  const p = resolve(VAULT, raw);
  if (p !== VAULT && !p.startsWith(VAULT + sep)) fail(400, '路径越界');
  return {abs: p, rel: p.slice(VAULT.length + 1).split(sep).join('/')};
}

const mtimeOf = abs => statSync(abs).mtimeMs;

// —— 笔记库读取（带短缓存；写操作会立即失效）——
let cache = {at: 0, data: null};
function loadData(maxAge = 1500) {
  if (cache.data && Date.now() - cache.at < maxAge) return cache.data;
  const data = readVault({vault: VAULT});
  const files = {};
  for (const w of data.works) files['post:' + w.post.id] = w.rel;
  for (const n of data.notes) files['note:' + n.id] = n.rel;
  for (const i of data.ideas) files['idea:' + i.id] = i.rel;
  for (const d of data.drafts) files['draft:' + d.id] = d.rel;
  const figures = {};
  for (const [id, rel] of Object.entries(files)) {
    try { const f = attachmentsOf(readFileSync(join(VAULT, rel), 'utf8')); if (f.length) figures[id] = f; } catch {}
  }
  cache = {at: Date.now(), data: {...data, files, figures, generatedAt: new Date().toISOString()}};
  return cache.data;
}
const invalidate = () => { cache = {at: 0, data: null}; };

// 写入的目标一律用「相对路径」定位，不用 n1 / w1 这类位置 id——
// 位置 id 在笔记增删后会整体位移，拿它当写入口令迟早会写到别的文件上。
function target({path, id}) {
  if (path) return inside(path).rel;
  if (id) {
    const rel = loadData().files[id];
    if (rel) return rel;
  }
  fail(400, '缺少 path（写入必须用相对路径定位文件）');
}

// —— 写回 ——
function backup(rel, text) {
  const dest = join(VAULT, '.trash', rel);
  mkdirSync(dirname(dest), {recursive: true});
  writeFileSync(dest, text, 'utf8');
}

function gitCommit(rel, message) {
  if (!VAULT_GIT || !existsSync(join(VAULT, '.git'))) return false;
  try {
    execFileSync('git', ['add', '--', rel], {cwd: VAULT, stdio: 'ignore'});
    execFileSync('git', ['commit', '-m', message, '--', rel], {cwd: VAULT, stdio: 'ignore'});
    return true;
  } catch { return false; }
}

// 写一个已存在的笔记：乐观锁 → 备份 → 最小侵入改写 → 落盘 → 提交
function writeExisting(rel, {body, fm, mtime}) {
  const {abs} = inside(rel);
  if (!existsSync(abs)) fail(404, `文件不存在：${rel}`);
  const before = readFileSync(abs, 'utf8');
  const current = mtimeOf(abs);
  if (mtime != null && Math.abs(Number(mtime) - current) > 1) {
    fail(409, '文件已被其他地方改动', {path: rel, mtime: current, content: before});
  }
  const after = writeDoc(before, {fm, body});
  if (after === before) return {path: rel, mtime: current, changed: false, text: after};
  backup(rel, before);
  writeFileSync(abs, after, 'utf8');
  gitCommit(rel, `更新 ${rel}`);
  invalidate();
  return {path: rel, mtime: mtimeOf(abs), changed: true, text: after};
}

// 新建一篇笔记。标题做文件名，重名时加序号；正文与 frontmatter 用固定模板写出。
function createNote(kind, {title, body = '', fm = {}}) {
  const dir = KIND_DIR[kind] || KIND_DIR.note;
  const name = safeName(title);
  let rel = posix.join(dir, name + '.md');
  for (let i = 2; existsSync(join(VAULT, rel)); i++) rel = posix.join(dir, `${name} ${i}.md`);
  const text = writeDoc('', {fm, body});
  const abs = join(VAULT, rel);
  mkdirSync(dirname(abs), {recursive: true});
  writeFileSync(abs, text, 'utf8');
  gitCommit(rel, `新增 ${rel}`);
  invalidate();
  return {path: rel, mtime: mtimeOf(abs), text};
}

// Obsidian 禁止出现在文件名里的字符，另外把双链里有歧义的 # ^ [ ] | 也换掉
const safeName = t => String(t || '').replace(/[\\/:*?"<>|#^[\]]/g, ' ')
  .replace(/\s+/g, ' ').replace(/^\.+/, '').trim().slice(0, 80) || '未命名';

function removeNote(rel) {
  const {abs} = inside(rel);
  if (!existsSync(abs)) fail(404, `文件不存在：${rel}`);
  backup(rel, readFileSync(abs, 'utf8'));
  rmSync(abs);
  gitCommit(rel, `删除 ${rel}（已备份到 .trash/）`);
  invalidate();
  return {path: rel};
}

// 读 frontmatter 里的 tags（AI 写回时合并用）。
function parseFrontmatter(text) {
  const {fm} = parse(text);
  const raw = fm.tags ?? fm.Tags ?? fm.标签 ?? [];
  return {tags: Array.isArray(raw) ? raw : raw ? String(raw).split(/[,，\s]+/).filter(Boolean) : []};
}

// —— 索引 ——
function reindex(data = loadData()) {
  const rows = [];
  const at = rel => new Date(statSync(join(VAULT, rel)).mtimeMs).toISOString();
  const push = (id, rel, title, kind, body) => rows.push({id, path: rel, title, kind, body, hash: hashOf(body), mtime: at(rel)});
  for (const w of data.works) push('post:' + w.post.id, w.rel, w.post.title, 'post', w.content.body);
  for (const n of data.notes) push('note:' + n.id, n.rel, n.title, 'note', n.body);
  for (const i of data.ideas) push('idea:' + i.id, i.rel, i.title, 'idea', i.note || '');
  for (const d of data.drafts) push('draft:' + d.id, d.rel, d.title, 'draft', d.body);
  return index.syncNotes(rows);
}

// —— 静态托管（可选，用来省掉单独的 nginx）——
const MIME = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.map': 'application/json; charset=utf-8'};
function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname).replace(/^\/+/, ''); }
  catch { rel = ''; } // 畸形 URL 当作没这个文件，走 SPA 回退
  if (rel.includes('\0') || rel.split('/').includes('..')) return false;
  let abs = join(STATIC_DIR, rel);
  if (!abs.startsWith(STATIC_DIR)) return false;
  if (!existsSync(abs) || statSync(abs).isDirectory()) abs = join(STATIC_DIR, 'index.html'); // SPA 回退
  if (!existsSync(abs)) return false;
  const body = readFileSync(abs);
  res.writeHead(200, {'content-type': MIME[extname(abs).toLowerCase()] || 'application/octet-stream', 'content-length': body.length});
  res.end(body);
  return true;
}

// —— 鉴权 ——
function authed(req) {
  if (!API_TOKEN) return true;
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-api-token'] || '');
  return t === API_TOKEN;
}

// —— 路由 ——
async function route(req, res, url) {
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (p === '/api/health') return json(res, 200, {ok: true, vault: VAULT, indexed: index.count()});

  if (!authed(req)) return json(res, 401, {error: '未授权'});

  if (p === '/api/data' && req.method === 'GET') {
    const d = loadData(url.searchParams.has('fresh') ? 0 : 1500);
    reindex(d);
    return json(res, 200, {
      snapshot: d.snapshot,
      posts: d.works.map(w => w.post),
      postContent: d.works.map(w => w.content),
      notes: d.notes.map(({tags, rel, ...n}) => n),
      seedIdeas: d.ideas.map(({rel, ...i}) => i),
      seedDrafts: d.drafts.map(({rel, ...d}) => d),
      concepts: d.concepts,
      files: d.files,
      figures: d.figures,
      semantic: aiEdgeCache?.edges || [],
      ai: aiInfo(),
      meta: {vault: VAULT, counts: d.counts, generatedAt: d.generatedAt, indexed: index.count()}
    });
  }

  if (p === '/api/note' && req.method === 'GET') {
    const rel = target({path: url.searchParams.get('path'), id: url.searchParams.get('id')});
    const {abs} = inside(rel);
    if (!existsSync(abs)) return json(res, 404, {error: '文件不存在', path: rel});
    const text = readFileSync(abs, 'utf8');
    return json(res, 200, {path: rel, text, mtime: mtimeOf(abs), hash: hashOf(text), figures: attachmentsOf(text)});
  }

  if (p === '/api/note' && req.method === 'PUT') {
    const {path, id, body, fm, mtime} = await readBody(req);
    if (body === undefined && (!fm || !Object.keys(fm).length)) fail(400, '没有要写入的内容');
    const r = writeExisting(target({path, id}), {body, fm, mtime});
    return json(res, 200, {path: r.path, mtime: r.mtime, changed: r.changed, hash: hashOf(r.text)});
  }

  if (p === '/api/note' && req.method === 'DELETE') {
    return json(res, 200, removeNote(target({path: url.searchParams.get('path'), id: url.searchParams.get('id')})));
  }

  if ((p === '/api/idea' || p === '/api/draft') && req.method === 'PUT') {
    const kind = p === '/api/idea' ? 'idea' : 'draft';
    const {path, id, title, body, fm, mtime} = await readBody(req);
    // 有 path / id 就是改现有的；都没有就新建
    if (path || (id && loadData().files[id])) {
      const rel = target({path, id});
      // 标题按 Obsidian 的约定就是文件名，不额外写 title 键；
      // 只有用户已经在属性里写了 title 时，才连那一行一起改，免得文件名和属性对不上。
      const fmPatch = {...fm};
      if (title && hasKey(readFileSync(join(VAULT, rel), 'utf8'), 'title')) fmPatch.title = title;
      const r = writeExisting(rel, {body, fm: fmPatch, mtime});
      const finalRel = title ? renameTo(title, rel) : rel;
      return json(res, 200, {path: finalRel, mtime: r.mtime, changed: r.changed, renamed: finalRel !== rel});
    }
    if (!title) fail(400, '新建需要一个标题');
    const r = createNote(kind, {title, body, fm});
    return json(res, 201, {path: r.path, mtime: r.mtime, created: true});
  }

  if (p === '/api/search' && req.method === 'GET') {
    return json(res, 200, {q: url.searchParams.get('q') || '', hits: index.search(url.searchParams.get('q') || '', Number(url.searchParams.get('limit') || 20))});
  }

  if (p === '/api/index' && req.method === 'POST') return json(res, 200, {changed: reindex(), indexed: index.count()});

  // —— AI：未配 key 时全部 501，前端据此隐藏 AI 区块 ——
  if (p === '/api/ai/info' && req.method === 'GET') return json(res, 200, aiInfo());

  if (p === '/api/ai/models' && req.method === 'GET') return json(res, 200, {models: await listModels(), taskModels: TASK_MODELS});

  // 请求里带的 model 覆盖：白名单校验（只允许网关 /v1/models 里的 id），缺省用任务配置
  async function pickModel(requested, task) {
    if (!requested) return TASK_MODELS[task];
    if (!aiEnabled()) return requested;
    if (!await validModel(requested)) fail(400, `未知模型：${requested}（GET /api/ai/models 查看可用列表）`);
    return requested;
  }

  if (p.startsWith('/api/ai/') && !aiEnabled() && p !== '/api/ai/info' && p !== '/api/ai/models') return json(res, 501, {error: 'AI 未启用：服务端未配置 AI_API_KEY'});

  // ① 打标签 + 摘要。body: {paths?: [...], dryRun?: bool}
  // 不传 paths 就处理全部方法笔记；按内容 hash 增量，没变过的跳过。
  if (p === '/api/ai/analyze' && req.method === 'POST') {
    const {paths, dryRun, model} = await readBody(req);
    const useModel = await pickModel(model, 'analyze');
    const d = loadData(0);
    const targets = d.notes.filter(n => !paths?.length || paths.includes(n.rel));
    const cached = index.aiCache();
    const need = targets.filter(n => cached.get('note:' + n.id)?.hash !== hashOf(n.body));
    if (dryRun) return json(res, 200, {total: targets.length, todo: need.length, skip: targets.length - need.length, dryRun: true, model: useModel});
    if (!need.length) return json(res, 200, {total: targets.length, done: 0, message: '全部笔记都分析过了'});
    const job = runJob('analyze', need.length, async progress => {
      const results = [];
      for (const n of need) {
        const r = await analyzeNote(n.title, n.body, {model: useModel});
        index.putAi('note:' + n.id, hashOf(n.body), r.tags, r.summary);
        // 写回笔记的 frontmatter：tags = 已有 ∪ AI 生成（去重，AI 的排后面），summary = AI 生成。
        // 写前读原文拿 mtime 做乐观锁；笔记库是自己的，冲突时跳过并在结果里标注。
        let writeErr = null;
        try {
          const cur = readFileSync(join(VAULT, n.rel), 'utf8');
          const curFm = parseFrontmatter(cur);
          const merged = [...new Set([...(curFm.tags || []), ...r.tags])].slice(0, 12);
          writeExisting(n.rel, {fm: {tags: merged, summary: r.summary}, mtime: mtimeOf(join(VAULT, n.rel))});
        } catch (e) { writeErr = e.message; }
        results.push({id: 'note:' + n.id, path: n.rel, title: n.title, ...r, written: !writeErr, error: writeErr});
        progress();
      }
      return results;
    });
    return json(res, 202, {job});
  }

  // ② 语义关联：embedding + 余弦，超阈值产出语义边（只存索引，不写文件）。
  // body: {threshold?: 0.82}
  if (p === '/api/ai/relate' && req.method === 'POST') {
    if (!embedEnabled()) return json(res, 501, {error: 'embedding 未启用：请设置 EMBED_API_KEY 与 EMBED_MODEL（DeepSeek 没有 embedding 接口）'});
    const {threshold = 0.82} = await readBody(req);
    const d = loadData(0);
    const items = d.notes;
    const cached = index.aiCache();
    const job = runJob('relate', items.length, async progress => {
      const model = process.env.EMBED_MODEL;
      const have = new Map(index.embeddings(model).map(e => [e.id, e]));
      for (const n of items) {
        const id = 'note:' + n.id, h = hashOf(n.body);
        if (have.get(id)?.hash !== h) {
          const [vec] = await embed([n.title + '\n' + n.body.slice(0, 2000)]);
          index.putEmbedding(id, model, vec, h);
        }
        progress();
      }
      const vecs = index.embeddings(model);
      const edges = [];
      for (let i = 0; i < vecs.length; i++) for (let j = i + 1; j < vecs.length; j++) {
        const sim = cosine(vecs[i].vec, vecs[j].vec);
        if (sim >= threshold) edges.push({a: vecs[i].id, b: vecs[j].id, sim: Math.round(sim * 1000) / 1000});
      }
      edges.sort((x, y) => y.sim - x.sim);
      return {edges: edges.slice(0, 200), threshold};
    }, {cache: true});
    return json(res, 202, {job});
  }

  // ③ 从笔记生成选题候选。body: {paths: [...]}（必填，用户在前端勾选笔记）
  if (p === '/api/ai/ideas' && req.method === 'POST') {
    const {paths, model} = await readBody(req);
    const useModel = await pickModel(model, 'ideas');
    if (!paths?.length) fail(400, '请先选择要用哪些笔记（paths）');
    const d = loadData(0);
    const notes = d.notes.filter(n => paths.includes(n.rel));
    if (!notes.length) fail(404, '选中的笔记不存在');
    const candidates = await generateIdeas(notes, {model: useModel});
    return json(res, 200, {candidates, model: useModel});
  }

  // ④ 问答（RAG）：embedding + FTS 混合检索 → 拼上下文 → 回答（非流式，个人规模足够）。
  // body: {question}
  if (p === '/api/ai/ask' && req.method === 'POST') {
    const {question, model: reqModel} = await readBody(req);
    if (!question?.trim()) fail(400, '问题不能为空');
    const useModel = await pickModel(reqModel, 'ask');
    const d = loadData(0);
    const hits = new Map();
    // 关键词召回：整句往往不是任何笔记的子串（FTS trigram 是子串匹配），
    // 按标点和常见停用词切成短语，取较长的片段逐个查，命中多的排前面。
    const phrases = String(question)
      .split(/[？?！!。，,、；;：:\s（）()\[\]{}"'「」…·—\-]+/)
      .flatMap(seg => seg.length > 10 ? [seg.slice(0, 5), seg.slice(5, 10), seg.slice(10)].filter(Boolean) : [seg])
      .filter(seg => [...seg].length >= 2);
    const scored = new Map();
    for (const ph of phrases.length ? phrases : [String(question)]) {
      for (const h of index.search(ph, 8)) scored.set(h.id, (scored.get(h.id) || 0) + [...ph].length);
    }
    for (const [id, w] of [...scored].sort((a, b) => b[1] - a[1]).slice(0, 8))
      hits.set(id, {id, title: index.note(id)?.title || '', body: index.note(id)?.body || '', kw: true});
    // 向量召回（可用时）
    if (embedEnabled()) {
      try {
        const model = process.env.EMBED_MODEL;
        const [qv] = await embed([question]);
        const scored = index.embeddings(model)
          .map(e => ({id: e.id, sim: cosine(qv, e.vec)}))
          .sort((a, b) => b.sim - a.sim).slice(0, 6).filter(x => x.sim >= 0.5);
        for (const s of scored) {
          const n = index.note(s.id);
          if (n) hits.set(s.id, {id: s.id, title: n.title, body: n.body, vec: true, sim: Math.round(s.sim * 100) / 100});
        }
      } catch { /* 向量召回失败时靠关键词兜底 */ }
    }
    const contexts = [...hits.values()].slice(0, 8);
    if (!contexts.length) return json(res, 200, {answer: '笔记库里没有找到相关内容。', refs: [], model: useModel});
    const text = await answer(question, contexts, {model: useModel});
    const byId = new Map([...d.works.map(w => ['post:' + w.post.id, w.rel]), ...d.notes.map(n => ['note:' + n.id, n.rel]), ...d.ideas.map(i => ['idea:' + i.id, i.rel]), ...d.drafts.map(x => ['draft:' + x.id, x.rel])]);
    const refs = contexts.map(c => ({id: c.id, title: c.title, path: byId.get(c.id) || null}));
    return json(res, 200, {answer: text, refs, model: useModel});
  }

  // —— AI 热点（第六星座的数据）——
  if (p === '/api/news' && req.method === 'GET') {
    return json(res, 200, {days: listNews(index, Number(url.searchParams.get('limit') || 14))});
  }
  if (p === '/api/news/refresh' && req.method === 'POST') {
    const {force} = await readBody(req).catch(() => ({}));
    const fn = force ? forceRefresh : refreshNews;
    const r = await fn(index, VAULT);
    return json(res, 200, r || {message: '今天的热点日报已生成过'});
  }

  // 从今天的热点里筛选题：auto=true 直接落盘进 04-选题池（射手座），否则只返回候选给前端预览
  if (p === '/api/news/ideas' && req.method === 'POST') {
    const {model: reqModel, auto} = await readBody(req).catch(() => ({}));
    const useModel = await pickModel(reqModel, 'news');
    const r = await ideasFromNews(index, VAULT, {model: useModel, auto: !!auto, io: {createNote}});
    reindex();
    return json(res, 200, r);
  }

  if (p.startsWith('/api/ai/jobs/') && req.method === 'GET') {
    const job = index.job(p.slice('/api/ai/jobs/'.length));
    if (!job) return json(res, 404, {error: '没有这个任务'});
    return json(res, 200, job);
  }

  return json(res, 404, {error: '没有这个接口', path: p});
}

// 后台任务：AI 调用秒级到几十秒级，不能阻塞 HTTP。同一时刻只跑一个 AI 任务。
let runningJob = null;
function runJob(kind, total, fn, opts = {}) {
  const id = randomUUID().slice(0, 8);
  index.createJob(id, kind, total);
  runningJob = id;
  (async () => {
    let done = 0;
    const progress = () => { done++; index.updateJob(id, {done, message: `${done}/${total}`}); };
    try {
      const result = await fn(progress);
      index.updateJob(id, {status: 'done', done: total, message: '完成', result});
      if (opts.cache) aiEdgeCache = result; // 语义边缓存在内存，/api/data 时带上
    } catch (e) {
      index.updateJob(id, {status: 'error', error: String(e.message || e)});
    } finally { if (runningJob === id) runningJob = null; }
  })();
  return {id, kind, total, status: 'running'};
}

// 语义边的内存缓存（ai/relate 的产出）：/api/data 响应里的 semantic 字段直接从这里取。
let aiEdgeCache = null;

// 标题改了就把文件名跟着改：Obsidian 的双链按文件名解析，文件名不跟着动会让链接对不上
function renameTo(title, rel) {
  const {abs} = inside(rel);
  const dir = dirname(abs);
  const name = safeName(title);
  let next = join(dir, name + '.md');
  if (next === abs) return rel;
  for (let i = 2; existsSync(next); i++) next = join(dir, `${name} ${i}.md`);
  const nextRel = posix.join(posix.dirname(rel), next.slice(dir.length + 1));
  try {
    renameSync(abs, next);
    gitCommit(nextRel, `重命名 ${rel} → ${nextRel}`);
    invalidate();
    return nextRel;
  } catch (e) {
    console.error('[note-api] 重命名失败：', e.message);
    return rel;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await route(req, res, url);
    if (STATIC_DIR && (req.method === 'GET' || req.method === 'HEAD')) {
      if (!authed(req)) return json(res, 401, {error: '未授权'});
      if (serveStatic(req, res, url.pathname)) return;
    }
    json(res, 404, {error: '没有这个路径'});
  } catch (e) {
    if (res.headersSent) return res.end();
    const code = e instanceof HttpError ? e.code : 500;
    if (code === 500) console.error('[note-api]', e);
    json(res, code, {error: e.message, ...(e.extra || {})});
  }
});

// 启动时先把索引建好，第一次打开页面就不用等
try { console.error(`[note-api] 索引 ${reindex()} 条，共 ${index.count()} 条`); }
catch (e) { console.error('[note-api] 首次索引失败：', e.message); }

// AI 热点日报的定时任务（NEWS_CRON=0 关闭）
if (process.env.NEWS_CRON !== '0') {
  startNewsCron(() => refreshNews(index, VAULT));
}

server.listen(PORT, HOST, () => {
  console.error(`[note-api] http://${HOST}:${PORT}  笔记库：${VAULT}${STATIC_DIR ? `  静态目录：${STATIC_DIR}` : ''}${API_TOKEN ? '  （已开启 token 鉴权）' : ''}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { index.close(); process.exit(0); });

export {server, index, loadData, reindex, target, writeExisting, createNote, removeNote, renameTo, inside, safeName};
