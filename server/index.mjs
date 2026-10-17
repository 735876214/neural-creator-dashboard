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
import {readVault} from './vault.mjs';
import {writeDoc, hasKey, attachmentsOf} from './frontmatter.mjs';
import {openIndex, hashOf} from './db.mjs';

const VAULT = resolve(process.env.VAULT_DIR || '');
const DATA_DIR = resolve(process.env.DATA_DIR || '.note-api');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const STATIC_DIR = process.env.STATIC_DIR ? resolve(process.env.STATIC_DIR) : null;
const API_TOKEN = process.env.API_TOKEN || '';
const VAULT_GIT = process.env.VAULT_GIT !== '0';
const MAX_BODY = Number(process.env.MAX_BODY || 2 * 1024 * 1024);
const KIND_DIR = {idea: '04-选题池', draft: '03-创作台', note: '05-方法库', post: '02-作品库'};

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

  return json(res, 404, {error: '没有这个接口', path: p});
}

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

server.listen(PORT, HOST, () => {
  console.error(`[note-api] http://${HOST}:${PORT}  笔记库：${VAULT}${STATIC_DIR ? `  静态目录：${STATIC_DIR}` : ''}${API_TOKEN ? '  （已开启 token 鉴权）' : ''}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { index.close(); process.exit(0); });

export {server, index, loadData, reindex, target, writeExisting, createNote, removeNote, renameTo, inside, safeName};
