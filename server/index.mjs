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
import {aiEnabled, embedEnabled, aiInfo, analyzeNote, analyzeWebPage, generateIdeas, answer, embed, listModels, validModel, TASK_MODELS} from './ai.mjs';
import {fetchPage, htmlToText, htmlTitle, FetchError} from './webclip.mjs';
import {parseUpload, ParseError} from './docparse.mjs';
import {refreshNews, forceRefresh, startNewsCron, listNews, ideasFromNews} from './news.mjs';
import {randomBytes, createHmac, timingSafeEqual, randomUUID} from 'node:crypto';

const VAULT = resolve(process.env.VAULT_DIR || '');
const DATA_DIR = resolve(process.env.DATA_DIR || '.note-api');
// 看板设置（月目标、AI 模型选择）是用户数据，放 vault 内隐藏目录：
// 随 vault 的 Syncthing/git 备份，且以点开头，readVault 的 walk() 会跳过，不会进图谱。
const SETTINGS_DIR = join(VAULT, '.dashboard');
const SETTINGS_FILE = join(SETTINGS_DIR, 'settings.json');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const STATIC_DIR = process.env.STATIC_DIR ? resolve(process.env.STATIC_DIR) : null;
const API_TOKEN = process.env.API_TOKEN || '';
const VAULT_GIT = process.env.VAULT_GIT !== '0';
const MAX_BODY = Number(process.env.MAX_BODY || 2 * 1024 * 1024);
// 登录：密码来自环境变量，或 compose 里 auth 容器生成的只读文件。
// 两者都没有 = 不开启登录（本机开发 / 纯静态）。
const AUTH_FILE = process.env.AUTH_FILE ? resolve(process.env.AUTH_FILE) : '';
const DASHBOARD_USER = process.env.DASHBOARD_USER || 'admin';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const SESSION_ENV_DAYS = Number(process.env.SESSION_DAYS || 30);
const SESSION_DAYS = Number.isFinite(SESSION_ENV_DAYS) && SESSION_ENV_DAYS >= 1
  ? Math.min(365, Math.floor(SESSION_ENV_DAYS)) : 30;
const SESSION_KEY_FILE = join(DATA_DIR, 'session.key');
const KIND_DIR = {idea: '04-选题池', draft: '03-创作台', note: '05-方法库', post: '02-作品库', news: '00-AI热点', personal: '06-个人知识库'};
// notes 表条目的图谱节点 id：personal 有自己的前缀（与 files / reindex / 前端图谱一致），
// news 沿用 note: 前缀（历史语义边依赖它）。relate / ask 必须用这同一套，否则语义边会连到不存在的节点。
const noteNodeId = n => n.kind === 'personal' ? 'personal:' + n.id : 'note:' + n.id;
const SNAPSHOTS_DIR = '06-个人知识库/.snapshots';

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

// 原始二进制请求体（文件上传用，同样受 MAX_BODY 约束）
async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) fail(413, '文件过大（上限 ' + Math.round(MAX_BODY / 1024 / 1024) + ' MB）');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// —— 登录与会话 ——
// 单用户登录。密码要么来自 DASHBOARD_PASSWORD，要么来自 compose 的 auth 容器
// 写出的只读 auth.json（容器卷，不进笔记库、不进前端 bundle）。
// 会话是 HMAC 签名的 HttpOnly Cookie；密钥持久化在 DATA_DIR，重启不会把所有人踢下线。
const SESSION_COOKIE = 'nd_session';
const SESSION_TTL = SESSION_DAYS * 86400;
const LOGIN_WINDOW = 5 * 60 * 1000;
const LOGIN_MAX = 8;
const loginFailures = new Map();

function currentAuth() {
  if (DASHBOARD_PASSWORD) return {user: DASHBOARD_USER, password: DASHBOARD_PASSWORD};
  if (!AUTH_FILE) return null;
  try {
    const raw = JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
    if (!raw?.password) return null;
    return {user: String(raw.user || DASHBOARD_USER), password: String(raw.password)};
  } catch { return null; }
}

function sessionKey() {
  try {
    const key = readFileSync(SESSION_KEY_FILE, 'utf8').trim();
    if (key.length >= 32) return key;
  } catch {}
  const key = randomBytes(32).toString('hex');
  try {
    mkdirSync(DATA_DIR, {recursive: true});
    writeFileSync(SESSION_KEY_FILE, key + '\n', {mode: 0o600});
  } catch {} // 数据目录只读时退回进程内密钥：重启后重新登录，但功能不受影响
  return key;
}
const SESSION_KEY = sessionKey();

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; }
    }
  }
  return '';
}

function signSession(payload, auth) {
  return createHmac('sha256', SESSION_KEY + '\n' + auth.password).update(payload).digest('base64url');
}

function makeSession(auth) {
  const payload = Buffer.from(JSON.stringify({
    u: auth.user,
    exp: Date.now() + SESSION_TTL * 1000
  })).toString('base64url');
  return payload + '.' + signSession(payload, auth);
}

function verifySession(req, auth) {
  if (!auth) return null;
  const raw = readCookie(req, SESSION_COOKIE);
  const i = raw.lastIndexOf('.');
  if (i <= 0) return null;
  const payload = raw.slice(0, i), given = raw.slice(i + 1);
  const expected = signSession(payload, auth);
  const a = Buffer.from(given), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.u !== auth.user || !(Number(data.exp) > Date.now())) return null;
    return data;
  } catch { return null; }
}

function cookieHeader(value, req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const secure = proto === 'https' || !!req.socket.encrypted;
  const age = value ? `Max-Age=${SESSION_TTL}` : 'Max-Age=0';
  return `${SESSION_COOKIE}=${encodeURIComponent(value || '')}; Path=/; HttpOnly; SameSite=Lax; ${age}${secure ? '; Secure' : ''}`;
}

function clientIp(req) {
  const forwarded = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '')
    .split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
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

// 网页快照路径：只允许 06-个人知识库/.snapshots/ 下的 .html（剪藏 HTML 不可信，读取时由路由加 CSP）。
function insideHtml(rel) {
  const raw = String(rel || '').replace(/\\/g, '/').trim();
  if (!raw || raw.includes('\0')) fail(400, '缺少路径');
  if (!raw.toLowerCase().endsWith('.html')) fail(400, '只允许 .html 快照');
  const p = resolve(VAULT, raw);
  const expected = join(VAULT, SNAPSHOTS_DIR + sep);
  if (!p.startsWith(expected)) fail(400, '快照必须位于 ' + SNAPSHOTS_DIR + '/ 下');
  return {abs: p, rel: p.slice(VAULT.length + 1).split(sep).join('/')};
}

const mtimeOf = abs => statSync(abs).mtimeMs;

// —— 笔记库读取（带短缓存；写操作会立即失效）——
let cache = {at: 0, data: null};
function loadData(maxAge = 1500) {
  if (cache.data && Date.now() - cache.at < maxAge) return cache.data;
  const data = readVault({vault: VAULT});
  const files = {};
  let personalSeq = 0;
  for (const w of data.works) files['post:' + w.post.id] = w.rel;
  // personal 用自己的前缀（与前端图谱节点 id 一致）；news 沿用 note: 前缀（历史语义边依赖它）。
  for (const n of data.notes) files[(n.kind === 'personal' ? 'personal:p' + (++personalSeq) : 'note:' + n.id)] = n.rel;
  for (const i of data.ideas) files['idea:' + i.id] = i.rel;
  for (const d of data.drafts) files['draft:' + d.id] = d.rel;
  const figures = {};
  const mtimes = {};
  for (const [id, rel] of Object.entries(files)) {
    const abs = join(VAULT, rel);
    try {
      mtimes[id] = mtimeOf(abs);
      const f = attachmentsOf(readFileSync(abs, 'utf8'));
      if (f.length) figures[id] = f;
    } catch {}
  }
  cache = {at: Date.now(), data: {...data, files, figures, mtimes, generatedAt: new Date().toISOString()}};
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

// 多文件提交（网页剪藏：md + 快照一起进版本库）。路径已由调用方各自校验。
function gitCommitMulti(rels, message) {
  if (!VAULT_GIT || !existsSync(join(VAULT, '.git'))) return false;
  try {
    execFileSync('git', ['add', '--', ...rels], {cwd: VAULT, stdio: 'ignore'});
    execFileSync('git', ['commit', '-m', message, '--', ...rels], {cwd: VAULT, stdio: 'ignore'});
    return true;
  } catch { return false; }
}

// —— 看板设置（vault/.dashboard/settings.json）——
// 只存少量不属于笔记的看板偏好：月目标、用户选的 AI 模型。
const SETTINGS_DEFAULTS = {version: 1, goal: 8, aiModel: null};
const SETTINGS_KEYS = new Set(['goal', 'aiModel']);

function readSettings() {
  try {
    if (!existsSync(SETTINGS_FILE)) return {...SETTINGS_DEFAULTS};
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
    const goal = Number.isInteger(raw?.goal) && raw.goal >= 1 && raw.goal <= 100 ? raw.goal : SETTINGS_DEFAULTS.goal;
    const aiModel = typeof raw?.aiModel === 'string' && raw.aiModel ? raw.aiModel : null;
    return {version: 1, goal, aiModel, ...(raw?.updatedAt ? {updatedAt: String(raw.updatedAt)} : {})};
  } catch {
    return {...SETTINGS_DEFAULTS};
  }
}

function writeSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail(400, '设置必须是对象');
  for (const k of Object.keys(patch)) if (!SETTINGS_KEYS.has(k)) fail(400, `未知设置项：${k}`);
  if ('goal' in patch && !(Number.isInteger(patch.goal) && patch.goal >= 1 && patch.goal <= 100)) fail(400, '目标必须是 1–100 的整数');
  if ('aiModel' in patch && !(patch.aiModel === null || (typeof patch.aiModel === 'string' && patch.aiModel))) fail(400, 'AI 模型必须是字符串或 null');
  const next = {...readSettings(), ...patch, version: 1, updatedAt: new Date().toISOString()};
  mkdirSync(SETTINGS_DIR, {recursive: true});
  const tmp = join(SETTINGS_DIR, `.settings-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    renameSync(tmp, SETTINGS_FILE);
  } catch (e) {
    try { rmSync(tmp, {force: true}); } catch {}
    throw new Error(`写入设置失败：${e.message}`);
  }
  gitCommit('.dashboard/settings.json', '更新看板设置');
  return next;
}

// idea / draft 的 frontmatter 白名单校验：只接受约定字段，非法值直接 400，
// 避免把前端的临时状态写进笔记文件。
function cleanFm(kind, fm) {
  if (fm == null) return {};
  if (typeof fm !== 'object' || Array.isArray(fm)) fail(400, 'fm 必须是对象');
  const out = {};
  if (kind === 'idea') {
    for (const k of ['platform', 'priority', 'status', 'note', 'sourceNews']) {
      if (!(k in fm)) continue;
      if (typeof fm[k] !== 'string') fail(400, `选题属性 ${k} 必须是字符串`);
      out[k] = fm[k];
    }
    if ('priority' in out && !['高', '中', '低'].includes(out.priority)) fail(400, '优先级必须是 高/中/低');
    if ('status' in out && !['待写', '待扩展', '已转草稿'].includes(out.status)) fail(400, '状态必须是 待写/待扩展/已转草稿');
  } else {
    if ('source' in fm) {
      if (!(typeof fm.source === 'string' || typeof fm.source === 'number')) fail(400, 'source 必须是选题标题');
      out.source = String(fm.source);
    }
  }
  return out;
}

// 用户笔记可能用中文键（来源选题 / 状态 / 标签…），前端统一用英文键。
// 写回时优先复用文件里已有的同义键，避免同一语义出现两行（例如 source 与 来源选题并存）。
const KEY_ALIASES = {
  title: ['标题'],
  platform: ['平台'],
  priority: ['优先级'],
  status: ['状态'],
  note: ['备注', 'description', '简介'],
  source: ['来源选题', '选题'],
  tags: ['标签', '话题'],
  summary: ['摘要']
};

function alignKeys(fm, text) {
  if (!fm || !Object.keys(fm).length) return fm;
  const {fm: existing} = parse(text);
  const names = Object.keys(existing);
  const out = {};
  for (const [key, value] of Object.entries(fm)) {
    const hit = (KEY_ALIASES[key] || []).find(alias => names.some(n => n.toLowerCase() === alias.toLowerCase()));
    out[hit || key] = value;
  }
  return out;
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
  const after = writeDoc(before, {fm: alignKeys(fm, before), body});
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
  let personalSeq = 0;
  for (const n of data.notes) push(n.kind === 'personal' ? 'personal:p' + (++personalSeq) : 'note:' + n.id, n.rel, n.title, n.kind, n.body);
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
function tokenAuthed(req) {
  if (!API_TOKEN) return false;
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-api-token'] || '');
  return t === API_TOKEN;
}

function authed(req) {
  if (tokenAuthed(req)) return true;
  const auth = currentAuth();
  return !auth || !!verifySession(req, auth);
}

// —— 路由 ——
async function route(req, res, url) {
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (p === '/api/health') return json(res, 200, {ok: true, vault: VAULT, indexed: index.count()});

  // —— 登录：这几个端点在未登录时也必须可用 ——
  if (p === '/api/session' && req.method === 'GET') {
    const auth = currentAuth();
    const session = auth ? verifySession(req, auth) : null;
    return json(res, 200, {required: !!auth, authenticated: !auth || !!session, user: session?.u || null});
  }

  if (p === '/api/login' && req.method === 'POST') {
    const auth = currentAuth();
    if (!auth) return json(res, 200, {ok: true, required: false});
    const ip = clientIp(req);
    const now = Date.now();
    const rec = loginFailures.get(ip);
    if (rec && rec.reset > now && rec.n >= LOGIN_MAX) {
      res.setHeader('retry-after', String(Math.ceil((rec.reset - now) / 1000)));
      return json(res, 429, {error: '尝试太频繁，请稍后再试'});
    }
    const {username, password} = await readBody(req);
    const ok = safeEqual(username ?? '', auth.user) & safeEqual(password ?? '', auth.password);
    if (!ok) {
      const next = rec && rec.reset > now ? {n: rec.n + 1, reset: rec.reset} : {n: 1, reset: now + LOGIN_WINDOW};
      loginFailures.set(ip, next);
      return json(res, 401, {error: '用户名或密码不正确', attemptsLeft: Math.max(0, LOGIN_MAX - next.n)});
    }
    loginFailures.delete(ip);
    res.setHeader('set-cookie', cookieHeader(makeSession(auth), req));
    return json(res, 200, {ok: true, user: auth.user});
  }

  if (p === '/api/logout' && req.method === 'POST') {
    res.setHeader('set-cookie', cookieHeader('', req));
    return json(res, 200, {ok: true});
  }

  // nginx 的 auth_request 子请求：204 = 放行，401 = 跳登录页
  if (p === '/api/auth-check') {
    if (authed(req)) {
      res.writeHead(204, {'cache-control': 'no-store'});
      return res.end();
    }
    return json(res, 401, {error: '未登录'});
  }

  if (!authed(req)) return json(res, 401, {error: '未登录'});

  if (p === '/api/data' && req.method === 'GET') {
    const d = loadData(url.searchParams.has('fresh') ? 0 : 1500);
    reindex(d);
    return json(res, 200, {
      snapshot: d.snapshot,
      posts: d.works.map(w => w.post),
      postContent: d.works.map(w => w.content),
      notes: d.notes.map(({rel, ...n}) => n),
      seedIdeas: d.ideas.map(({rel, ...i}) => i),
      seedDrafts: d.drafts.map(({rel, ...d}) => d),
      concepts: d.concepts,
      files: d.files,
      figures: d.figures,
      mtimes: d.mtimes || {},
      settings: readSettings(),
      semantic: index.semanticEdges(),
      ai: aiInfo(),
      meta: {vault: VAULT, counts: d.counts, generatedAt: d.generatedAt, indexed: index.count()}
    });
  }

  if (p === '/api/settings' && req.method === 'GET') return json(res, 200, readSettings());

  if (p === '/api/settings' && req.method === 'PUT') {
    return json(res, 200, writeSettings(await readBody(req)));
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
    const rel = target({path: url.searchParams.get('path'), id: url.searchParams.get('id')});
    // 个人知识库的剪藏：顺带删掉快照文件（尽力而为，失败不阻塞删除）
    let snapRel = null;
    try {
      const n = loadData().notes.find(x => x.kind === 'personal' && x.rel === rel);
      if (n?.snapshot) {
        const {abs} = insideHtml(n.snapshot);
        if (existsSync(abs)) { rmSync(abs); snapRel = n.snapshot; }
      }
    } catch {}
    const r = removeNote(rel);
    if (snapRel) gitCommitMulti([rel, snapRel], `删除 ${rel}（已备份到 .trash/）`);
    return json(res, 200, r);
  }

  if ((p === '/api/idea' || p === '/api/draft') && req.method === 'PUT') {
    const kind = p === '/api/idea' ? 'idea' : 'draft';
    const {path, id, title, body, fm, mtime} = await readBody(req);
    // 有 path / id 就是改现有的；都没有就新建
    if (path || (id && loadData().files[id])) {
      const rel = target({path, id});
      // 标题按 Obsidian 的约定就是文件名，不额外写 title 键；
      // 只有用户已经在属性里写了 title 时，才连那一行一起改，免得文件名和属性对不上。
      const fmPatch = cleanFm(kind, fm);
      if (title && hasKey(readFileSync(join(VAULT, rel), 'utf8'), 'title')) fmPatch.title = title;
      const r = writeExisting(rel, {body, fm: fmPatch, mtime});
      const finalRel = title ? renameTo(title, rel) : rel;
      return json(res, 200, {path: finalRel, mtime: r.mtime, changed: r.changed, renamed: finalRel !== rel});
    }
    if (!title) fail(400, '新建需要一个标题');
    const r = createNote(kind, {title, body, fm: cleanFm(kind, fm)});
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
        const id = noteNodeId(n), h = hashOf(n.body);
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
    const byId = new Map([...d.works.map(w => ['post:' + w.post.id, w.rel]), ...d.notes.map(n => [noteNodeId(n), n.rel]), ...d.ideas.map(i => ['idea:' + i.id, i.rel]), ...d.drafts.map(x => ['draft:' + x.id, x.rel])]);
    const refs = contexts.map(c => ({id: c.id, title: c.title, path: byId.get(c.id) || null}));
    return json(res, 200, {answer: text, refs, model: useModel});
  }

  // —— 个人知识库（第七星座）：灵感 / 制度 / 推文剪藏 ——
  // personal 的 frontmatter 白名单：category/url/domain/author/clipped/summary/keyPoints/snapshot
  function cleanPersonalFm(fm) {
    if (fm == null || typeof fm !== 'object' || Array.isArray(fm)) fail(400, 'fm 必须是对象');
    const out = {};
    if ('category' in fm && !(typeof fm.category === 'string' && ['灵感', '制度', '推文'].includes(fm.category))) fail(400, 'category 必须是 灵感/制度/推文');
    for (const k of ['category', 'url', 'domain', 'author', 'clipped', 'summary', 'snapshot', 'sourceFile', 'uploaded']) {
      if (fm[k] == null || fm[k] === '') continue;
      if (typeof fm[k] !== 'string') fail(400, `${k} 必须是字符串`);
      out[k] = fm[k];
    }
    if (fm.keyPoints != null) {
      if (!Array.isArray(fm.keyPoints) || fm.keyPoints.some(p => typeof p !== 'string')) fail(400, 'keyPoints 必须是字符串数组');
      out.keyPoints = fm.keyPoints.filter(Boolean);
    }
    return out;
  }

  // personal 的 files key 是按 notes 顺序生成的 p1/p2…：用 path 精确定位，不猜 id。
  function personalByPath(rel) {
    const d = loadData();
    const hit = d.notes.find(n => n.kind === 'personal' && n.rel === rel);
    if (!hit) fail(404, `个人知识库里没有这篇笔记：${rel}`);
    return hit;
  }

  // 从笔记读出抓取正文：有快照读快照，否则重新抓取。
  async function clipTextOf(n) {
    if (n.snapshot) {
      const {abs} = insideHtml(n.snapshot);
      if (existsSync(abs)) {
        const html = readFileSync(abs, 'utf8');
        return {text: htmlToText(html), title: htmlTitle(html) || n.title, url: n.url, fromSnapshot: true};
      }
    }
    if (!n.url) return {text: n.body, title: n.title, url: null, fromSnapshot: false};
    const {url, html} = await fetchPage(n.url);
    return {text: htmlToText(html), title: htmlTitle(html) || n.title, url, fromSnapshot: false};
  }

  if (p === '/api/knowledge' && req.method === 'POST') {
    const {url, title, note, category, tags, analyze} = await readBody(req);
    const hasUrl = typeof url === 'string' && /^https?:\/\//i.test(url.trim());
    const cat = category ? String(category) : hasUrl ? '推文' : '灵感';
    if (!hasUrl && (typeof title !== 'string' || !title.trim())) fail(400, '需要一个标题（或先填 URL，由网页标题生成）');
    let page = null;
    if (hasUrl) {
      try { page = await fetchPage(url.trim()); }
      catch (e) { fail(e instanceof FetchError ? 400 : 502, e.message); }
    }
    const finalTitle = (page && htmlTitle(page.html)) || String(title || '').trim();
    if (!finalTitle) fail(400, '网页没有标题，请补一个 title');
    const text = page ? htmlToText(page.html) : String(note || '');
    const domain = page ? new URL(page.url).hostname : undefined;

    // AI 分析：未启用/失败都不丢剪藏，只带 analysisError
    let analysis = null, analysisError = null;
    if (page && analyze !== false && aiEnabled()) {
      try { analysis = await analyzeWebPage({url: page.url, title: finalTitle, text}); }
      catch (e) { analysisError = e.message; }
    }

    // 快照：抓取成功就存一份 HTML 原文（.snapshots/ 点目录，不会进图谱）
    let snapshotRel = null;
    if (page) {
      const slug = safeName(finalTitle).slice(0, 50).replace(/\s+/g, '-').toLowerCase() || 'page';
      snapshotRel = posix.join(SNAPSHOTS_DIR, `${slug}-${Date.now()}.html`);
      mkdirSync(join(VAULT, SNAPSHOTS_DIR), {recursive: true});
      writeFileSync(join(VAULT, snapshotRel), page.html, 'utf8');
    }

    const fm = cleanPersonalFm({
      category: cat,
      ...(page ? {url: page.url, domain, clipped: new Date().toISOString().slice(0, 10)} : {}),
      ...(analysis?.summary ? {summary: analysis.summary} : {}),
      ...(analysis?.keyPoints?.length ? {keyPoints: analysis.keyPoints} : {}),
      ...(snapshotRel ? {snapshot: snapshotRel} : {}),
      ...(Array.isArray(tags) ? {tags: tags.map(String).filter(Boolean)} : {})
    });
    const body = page
      ? `> [!info] 网页剪藏\n> 来源：${page.url}${analysis ? `\n\n${analysis.summary}\n${(analysis.keyPoints || []).map(k => '- ' + k).join('\n')}` : ''}\n\n---\n\n${text}`
      : String(note || '');
    const r = createNote('personal', {title: finalTitle, body, fm});
    const commitPaths = snapshotRel ? [r.path, snapshotRel] : [r.path];
    gitCommitMulti(commitPaths, `剪藏 ${r.path}`);
    invalidate();
    return json(res, 201, {path: r.path, mtime: r.mtime, created: true, snapshot: snapshotRel, analysis, analysisError});
  }

  // 重新分析已有剪藏：读快照（或重新抓取）→ AI → 写回 frontmatter（乐观锁）
  if (p === '/api/knowledge/analyze' && req.method === 'POST') {
    const {path, id} = await readBody(req);
    const rel = target({path, id});
    const n = personalByPath(rel);
    if (!aiEnabled()) return json(res, 501, {error: 'AI 未启用：服务端未配置 AI_API_KEY'});
    let page;
    try { page = await clipTextOf(n); }
    catch (e) { fail(e instanceof FetchError ? 400 : 502, e.message); }
    const analysis = await analyzeWebPage({url: n.url, title: n.title, text: page.text});
    const cur = readFileSync(join(VAULT, rel), 'utf8');
    const oldTags = parseFrontmatter(cur);
    writeExisting(rel, {
      fm: {summary: analysis.summary, ...(analysis.keyPoints.length ? {keyPoints: analysis.keyPoints} : {}),
        tags: [...new Set([...(oldTags.tags || []), ...analysis.tags])].slice(0, 12)},
      mtime: mtimeOf(join(VAULT, rel))
    });
    return json(res, 200, {path: rel, analysis});
  }

  // 快照原文：剪藏 HTML 不可信，CSP 封死脚本
  if (p === '/api/knowledge/snapshot' && req.method === 'GET') {
    const {abs, rel} = insideHtml(url.searchParams.get('path'));
    if (!existsSync(abs)) return json(res, 404, {error: '快照不存在', path: rel});
    const body = readFileSync(abs);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': body.length,
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src * data:; font-src *;",
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store'
    });
    return res.end(body);
  }

  // 上传文件入库（个人知识库）：原始 body + x-filename 头。md/txt 直读，
  // docx 手写 zip 解析，PDF 走 pdfjs-dist。提取文本写成 kind: personal 的 md。
  if (p === '/api/knowledge/upload' && req.method === 'POST') {
    const filename = (() => {
      try { return decodeURIComponent(req.headers['x-filename'] || ''); } catch { return ''; }
    })();
    if (!filename) fail(400, '缺少 x-filename 头');
    const category = (() => {
      try { return decodeURIComponent(req.headers['x-category'] || ''); } catch { return ''; }
    })();
    const buf = await readRaw(req);
    if (!buf.length) fail(400, '文件是空的');
    let parsed;
    try { parsed = await parseUpload(filename, buf); }
    catch (e) { fail(e instanceof ParseError ? 400 : 500, e.message); }
    const r = createNote('personal', {
      title: parsed.title,
      body: parsed.text,
      fm: cleanPersonalFm({category: ['灵感', '制度', '推文'].includes(category) ? category : '制度', sourceFile: filename, uploaded: new Date().toISOString().slice(0, 10)})
    });
    gitCommit(r.path, `上传 ${r.path}`);
    invalidate();
    return json(res, 201, {path: r.path, chars: parsed.text.length});
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
      // 语义边写进 SQLite：刷新页面、重启服务后仍然保留，直到下次 relate 覆盖。
      if (opts.cache && Array.isArray(result?.edges)) {
        try { index.replaceSemantic(result.edges); }
        catch (e) { console.error('[note-api] 语义边持久化失败：', e.message); }
      }
    } catch (e) {
      index.updateJob(id, {status: 'error', error: String(e.message || e)});
    } finally { if (runningJob === id) runningJob = null; }
  })();
  return {id, kind, total, status: 'running'};
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
      // 登录页与头像必须公开，否则未登录时连登录表单都打不开
      const publicStatic = url.pathname === '/login.html' || url.pathname === '/avatar.svg';
      if (!publicStatic && !authed(req)) {
        // 直接访问页面时跳登录页；静态资源仍返回 401，避免把 HTML 当 JS 返回
        const wantsHtml = String(req.headers.accept || '').includes('text/html') &&
          !url.pathname.startsWith('/assets/');
        if (wantsHtml) {
          res.writeHead(302, {location: '/login.html', 'cache-control': 'no-store'});
          return res.end();
        }
        return json(res, 401, {error: '未登录'});
      }
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

// AI 热点日报的定时任务（NEWS_CRON=0 关闭）。日报生成后自动筛选题落进 04-选题池。
if (process.env.NEWS_CRON !== '0') {
  startNewsCron(async () => {
    const r = await refreshNews(index, VAULT);
    if (!r) return; // 今天已生成过，不重复筛选
    try {
      const ideas = await ideasFromNews(index, VAULT, {auto: true, io: {createNote}});
      reindex();
      console.error(`[news] 已从热点自动筛出 ${ideas.written.length} 个选题进 04-选题池`);
    } catch (e) { console.error('[news] 自动筛选题失败：', e.message); }
  });
}

server.listen(PORT, HOST, () => {
  const auth = currentAuth();
  const authNote = auth
    ? `  已开启登录（用户 ${auth.user}）`
    : (API_TOKEN ? '  （已开启 token 鉴权）' : '  未开启登录');
  console.error(`[note-api] http://${HOST}:${PORT}  笔记库：${VAULT}${STATIC_DIR ? `  静态目录：${STATIC_DIR}` : ''}${authNote}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { index.close(); process.exit(0); });

export {server, index, loadData, reindex, target, writeExisting, createNote, removeNote, renameTo, inside, safeName};
