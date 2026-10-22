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
import {readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync, renameSync, readdirSync, copyFileSync, chmodSync, accessSync, createReadStream, openSync, fsyncSync, closeSync, linkSync, realpathSync, constants as fsConstants} from 'node:fs';
import {join, resolve, sep, dirname, extname, basename, posix} from 'node:path';
import {execFileSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import {readVault, vaultStamp, vaultStampCached, bumpVaultStamp, parse, ATTACHMENTS_DIR} from './vault.mjs';
import {writeDoc, hasKey, attachmentsOf} from './frontmatter.mjs';
import {openIndex, hashOf, cosine} from './db.mjs';
import {aiEnabled, embedEnabled, aiInfo, analyzeNote, analyzeWebPage, generateIdeas, answer, embed, listModels, validModel, taskModel, taskModelsSnapshot} from './ai.mjs';
import {setAiRuntime} from './ai.mjs';
import {fetchPage, htmlToText, htmlTitle, FetchError} from './webclip.mjs';
import {parseUpload, ParseError} from './docparse.mjs';
import {refreshNews, forceRefresh, startNewsCron, listNews, ideasFromNews} from './news.mjs';
import {platformInfo, pullAll, pullOne, startPlatformsCron, bindSettingsReader} from './platforms.mjs';
import {randomBytes, createHmac, timingSafeEqual, randomUUID} from 'node:crypto';

// fsync 一个路径（文件或目录）。strict=true 时把错误抛出去（数据没落盘不能假装成功）；
// 目录 fsync 在 Windows 上会抛 EISDIR/EPERM，走 strict=false。
function fsyncPath(p, strict) {
  let fd;
  try { fd = openSync(p, 'r'); fsyncSync(fd); }
  catch (e) { if (strict) throw e; }
  finally { try { closeSync(fd); } catch {} }
}

// 同目录临时文件 + rename + fsync：rename 只保证「目录项切换是原子的、不会出现半截文件」，
// 它不保证新 inode 的数据块先落盘 —— 掉电 / 硬重启后目录项可能已指向新 inode 而数据还在
// 页缓存里，恢复后就是 0 字节或半截。所以：写 tmp → fsync 文件 → rename → fsync 目录。
function writeAtomicSync(abs, data, opts) {
  const tmp = join(dirname(abs), `.${basename(abs)}.${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, data, opts);
    fsyncPath(tmp, true);
    renameSync(tmp, abs);
    fsyncPath(dirname(abs), false);
  } catch (e) {
    try { rmSync(tmp, {force: true}); } catch {}
    throw e;
  }
}

const VAULT = resolve(process.env.VAULT_DIR || '');
const DATA_DIR = resolve(process.env.DATA_DIR || '.note-api');
// 笔记库的真实路径：字符串前缀校验挡不住符号链接（vault/inner -> /etc 时
// vault/inner/x.md 前缀合法、实际落在库外）。所有路径校验都要对着它再核一次真实位置。
const VAULT_REAL = (() => { try { return realpathSync(VAULT); } catch { return VAULT; } })();
// 取离 p 最近的已存在祖先目录的真实路径（新建的多级目录还没创建时，只能核到已有的那层）。
function realAncestor(p) {
  let d = dirname(p);
  for (let i = 0; i < 40; i++) {
    try { return realpathSync(d); } catch {}
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}
const insideRealVault = p => {
  const d = realAncestor(p);
  return !d || d === VAULT_REAL || d.startsWith(VAULT_REAL + sep);
};
// 看板设置（月目标、AI 模型选择）是用户数据，放 vault 内隐藏目录：
// 随 vault 的 Syncthing/git 备份，且以点开头，readVault 的 walk() 会跳过，不会进图谱。
const SETTINGS_DIR = join(VAULT, '.dashboard');
const SETTINGS_FILE = join(SETTINGS_DIR, 'settings.json');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const STATIC_DIR = process.env.STATIC_DIR ? resolve(process.env.STATIC_DIR) : null;
const API_TOKEN = process.env.API_TOKEN || '';
const VAULT_GIT = process.env.VAULT_GIT !== '0';
// 请求体上限：与 deploy/.env.example、docker-compose.yml 里写的「默认 4 MB」保持一致。
// 原来代码默认 2 MB、模板写 4 MB，直接 `npm run api` 与容器行为不同，按文档传 3 MB 的 PDF 会 413。
const MAX_BODY = Number(process.env.MAX_BODY || 4 * 1024 * 1024);
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

// 「今天是哪天」必须用显式时区偏移算：容器默认 UTC（镜像不装 tzdata），
// 东八区 00:00–07:59 之间发布的作品会被 toISOString() 记成前一天，
// 而作品 date 决定排序、月目标进度与时间区间——一处写错整屏统计都错。
const TZ_OFFSET_RAW = Number(process.env.DASHBOARD_TZ_OFFSET ?? process.env.NEWS_TZ_OFFSET);
const TZ_OFFSET = Number.isFinite(TZ_OFFSET_RAW) ? TZ_OFFSET_RAW : 8;
const localYmd = (ms = Date.now()) => {
  const d = new Date(ms + TZ_OFFSET * 3600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

if (!process.env.VAULT_DIR) {
  console.error('请用 VAULT_DIR 指定笔记库目录，例如：VAULT_DIR=./examples/vault node server/index.mjs');
  process.exit(1);
}
if (!existsSync(VAULT) || !statSync(VAULT).isDirectory()) {
  console.error(`笔记库目录不存在：${VAULT}`);
  process.exit(1);
}

// 建索引失败几乎只有一种原因：/data 目录属主不是当前进程 uid（PUID 与数据卷不一致，
// 或从 root 版镜像升级过来卷还是 root 属主）。顶层抛 EACCES 只会在日志里留一段堆栈，
// 配合 restart: unless-stopped 就变成无限重启、用户完全看不出该改什么，所以这里给出可执行的提示。
let index;
try {
  index = openIndex(join(DATA_DIR, 'index.sqlite'));
} catch (e) {
  if (e && (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS' || /readonly/i.test(e.message || ''))) {
    console.error(`无法在 ${DATA_DIR} 建立 SQLite 索引：${e.message}`);
    console.error(`当前进程 uid=${process.getuid?.() ?? '?'} gid=${process.getgid?.() ?? '?'}，`
      + `请把 ${DATA_DIR} 的属主改成同一个 uid/gid（PUID/PGID 只换进程身份，不会改数据卷属主）：`);
    console.error(`  chown -R ${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000} <宿主机上的 note-api-data 目录>`);
  } else {
    console.error(`无法在 ${DATA_DIR} 建立 SQLite 索引：`, e);
  }
  process.exit(1);
}

// —— 通用小工具 ——
class HttpError extends Error {
  constructor(code, message, extra) { super(message); this.code = code; this.extra = extra; }
}
const fail = (code, message, extra) => { throw new HttpError(code, message, extra); };

// 部署模式下静态资源与 /api 都由 note-api 直出（镜像里没有 nginx），所以压缩必须在这里做：
// /api/data 在真实库上常是 1–3 MB 中文 JSON（压缩比 6–10×），手机上不压缩就是几秒白屏。
function acceptsGzip(req) {
  return /\bgzip\b/.test(String(req?.headers?.['accept-encoding'] || ''));
}

// 所有响应（JSON、静态、HTML）都要带的基础安全头。
// 原来只有附件与知识库快照这两条边缘路径有 CSP，index.html / login.html / assets / 全部 JSON
// 一条都没有：登录页可被任意站点 iframe 套一层透明层骗取密码；笔记正文一旦有 XSS 也没有兜底。
// 这里只上「不影响现有功能」的四条：login.html 与看板都用内联 script / inline style / canvas，
// 所以先不加 script-src（白名单是后续单独立项），但 frame-ancestors 已经能挡点击劫持。
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
};

function json(res, code, obj) {
  let body = Buffer.from(JSON.stringify(obj));
  const head = {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'vary': 'accept-encoding', ...SECURITY_HEADERS};
  if (body.length > 1024 && acceptsGzip(res.req)) { body = gzipSync(body); head['content-encoding'] = 'gzip'; }
  head['content-length'] = body.length;
  res.writeHead(code, head);
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  let limited = false;
  for await (const c of req) {
    size += c.length;
    // 超限后继续 drain（丢弃多余字节）而不是 destroy：destroy 会把 socket 立刻掐掉，
    // 下面这个 413 根本发不出去，客户端只拿到连接重置（fetch 里就是「网络错误」），
    // 而 /api/ai/info 已经把 maxUpload 公布成契约了。drain 同时保证 keep-alive 上不留半截 body。
    if (size > MAX_BODY) { limited = true; chunks.length = 0; continue; }
    chunks.push(c);
  }
  if (limited) fail(413, '请求体过大');
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { fail(400, '请求体不是合法 JSON'); }
  // 顶层必须是对象：null / 数组 / 裸字符串会让 `const {x} = body` 或 `'k' in body` 抛 TypeError，
  // 兜底成 500 时还会把内部报错原文回给调用方（信息泄露，且前端看不懂）。
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) fail(400, '请求体必须是 JSON 对象');
  return parsed;
}

// 可选请求体：只有「确实没有 body」才当 {}。原来的 `readBody(req).catch(() => ({}))`
// 把 413（过大）与 400（JSON 非法）一起吞成空对象，超限请求既不报错也不处理。
async function readBodyOrEmpty(req) {
  const hasBody = Number(req.headers['content-length'] || 0) > 0 || !!req.headers['transfer-encoding'];
  if (!hasBody) return {};
  return readBody(req);
}

// 原始二进制请求体（文件上传用，同样受 MAX_BODY 约束）
async function readRaw(req) {
  const chunks = [];
  let size = 0;
  let limited = false;
  for await (const c of req) {
    size += c.length;
    // 同 readBody：drain 而不是 destroy，否则 413 发不出去，前端看不到「文件过大」的原因
    if (size > MAX_BODY) { limited = true; chunks.length = 0; continue; }
    chunks.push(c);
  }
  if (limited) fail(413, '文件过大（上限 ' + Math.round(MAX_BODY / 1024 / 1024) + ' MB）');
  return Buffer.concat(chunks);
}

// 附件流式下载必须自己兜住读流错误：pipe 不转发 'error'，一旦 open/read 失败（文件被
// Syncthing 改名的窗口期 ENOENT、同名目录 EISDIR）就会冒到顶层 uncaughtException，
// process.exit(1) —— 一次 GET 就能打掉整个 note-api。
function pipeAttachment(abs, start, end, res, rel) {
  const s = end == null ? createReadStream(abs) : createReadStream(abs, {start, end});
  s.on('error', (err) => {
    if (!res.headersSent) return json(res, 404, {error: '附件读取失败', path: rel});
    console.error('[note-api] 附件读取失败', rel, err.code);
    res.destroy(); // 头已发出，只能断连，别让客户端把截断的 200 当成功
  });
  res.on('close', () => s.destroy()); // 客户端提前断开时释放 fd
  return s.pipe(res);
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

// 读并校验登录配置。auth.json 存在却读不懂时必须抛错，绝不能退化成「没有鉴权」：
// authed() 把 null 当成免登录，一次截断写入 / 卷挂载中断就会让整个笔记库对 0.0.0.0 裸奔。
function loadAuthConfig() {
  if (DASHBOARD_PASSWORD) {
    // 整个笔记库只靠这一个口令守着，又是公网可达的端口。太短的口令拦不住在线爆破
    // （限流是 8 次/5 分钟/IP，分布式来源等于没有），但历史上有人就是这么配的，所以只告警不改行为。
    if (String(DASHBOARD_PASSWORD).trim().length < 12) {
      console.error('[note-api] 警告：DASHBOARD_PASSWORD 少于 12 个字符，容易被在线爆破。建议改成 16 位以上的随机串。');
    }
    return {user: DASHBOARD_USER, password: DASHBOARD_PASSWORD};
  }
  if (!AUTH_FILE) return null;
  if (!existsSync(AUTH_FILE)) {
    // bootstrapAuth() 已经在前面跑过（设置了 AUTH_FILE 就一定会生成文件）：
    // 到这里还没有文件说明自举被跳过或失败，绝不能当成「没配置登录」——那等于免登录。
    throw new Error(`AUTH_FILE 已配置但文件不存在：${AUTH_FILE}`);
  }
  let raw;
  try { raw = JSON.parse(readFileSync(AUTH_FILE, 'utf8')); }
  catch (e) { throw new Error(`auth.json 不是合法 JSON（${AUTH_FILE}）：${e.message}`); }
  if (!raw || typeof raw !== 'object' || typeof raw.password !== 'string' || !raw.password) {
    throw new Error(`auth.json 缺少可用的 password 字段（${AUTH_FILE}）`);
  }
  return {user: String(raw.user || DASHBOARD_USER), password: raw.password};
}

// 启动时定型并缓存：请求路径上不再读磁盘，也不会中途因文件损坏而静默降级。
let AUTH_CONFIG = null;
function currentAuth() { return AUTH_CONFIG; }

// auth 自举：设置了 DASHBOARD_PASSWORD 用它；否则若指定了 AUTH_FILE 且文件不存在，
// 首次启动生成随机密码写入并打印到日志（替代旧的独立 auth 一次性容器，
// 少拉一个镜像；文件已在卷里时沿用原密码，重启不会换密码）。
function bootstrapAuth() {
  if (DASHBOARD_PASSWORD || !AUTH_FILE) return;
  let hasFile = false;
  try { hasFile = existsSync(AUTH_FILE) && statSync(AUTH_FILE).size > 0; } catch {}
  if (hasFile) return; // 已存在：交给启动时的 loadAuthConfig() 校验（坏文件直接拒绝启动）
  try {
    mkdirSync(dirname(AUTH_FILE), {recursive: true});
    const password = randomBytes(9).toString('base64url');
    const body = JSON.stringify({user: DASHBOARD_USER, password, createdAt: new Date().toISOString()}, null, 2) + '\n';
    writeFileSync(AUTH_FILE, body, {mode: 0o600});
    // mode 只在「新建」时生效：AUTH_FILE 若是个已存在的空文件（手搓过、卷里残留），
    // 覆盖写会保留原有 0644，密码就以组/其他人可读落盘，与文档承诺不符。
    chmodSync(AUTH_FILE, 0o600);
    console.error('');
    console.error('========== 看板登录 ==========');
    console.error('用户名：' + DASHBOARD_USER);
    console.error('密码：  ' + password);
    console.error('（这行只在首次启动时打印一次，密码同时写在 AUTH_FILE 里；');
    console.error('  想固定密码：在 .env 设置 DASHBOARD_PASSWORD=你的密码）');
    console.error('==============================');
    console.error('');
  } catch (e) {
    // 绝不能退化成「不开启登录」：authed() 把 null 当免登录，AUTH_FILE 所在卷只读一次，
    // 整个笔记库（含写入、删除、改 AI key）就对 0.0.0.0 裸奔，而这里原本只留一行 stderr。
    console.error('[note-api] 生成登录密码失败，已拒绝启动：' + e.message);
    console.error('[note-api] 修好 AUTH_FILE 所在目录的权限，或显式设置 DASHBOARD_PASSWORD。');
    process.exit(1);
  }
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
    try { chmodSync(SESSION_KEY_FILE, 0o600); } catch {}
  } catch (e) {
    // 退回进程内密钥：重启就要重新登录，多副本之间也互相不认。功能还在，但必须留下痕迹。
    console.error('[note-api] 会话密钥无法写入 DATA_DIR（本次退回进程内密钥，重启后需重新登录）：' + e.message);
  }
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

// 登出必须能让服务端签名失效：签名 Cookie 在 TTL 内是自证的，只清浏览器里的那份，
// 任何曾经拿到过它的人（另一台设备、浏览器同步、代理日志）都能继续用到过期为止。
// 单用户部署，吊销表放内存即可：重启丢表等价于「重新登录」，与 TTL 语义一致。
const revokedSessions = new Map(); // jti -> exp（毫秒）
function revokeSession(raw) {
  const i = String(raw || '').lastIndexOf('.');
  if (i <= 0) return;
  try {
    const data = JSON.parse(Buffer.from(raw.slice(0, i), 'base64url').toString('utf8'));
    if (data?.jti) {
      const now = Date.now();
      if (revokedSessions.size > 256) for (const [k, exp] of revokedSessions) if (!(exp > now)) revokedSessions.delete(k);
      revokedSessions.set(data.jti, Number(data.exp) || now);
    }
  } catch { /* 解不开的 Cookie 本来就用不了 */ }
}

function signSession(payload, auth) {
  return createHmac('sha256', SESSION_KEY + '\n' + auth.password).update(payload).digest('base64url');
}

function makeSession(auth) {
  const payload = Buffer.from(JSON.stringify({
    u: auth.user,
    exp: Date.now() + SESSION_TTL * 1000,
    jti: randomBytes(9).toString('base64url') // 登出吊销用；老 Cookie 没有它，照旧有效
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
    if (data.jti && revokedSessions.has(data.jti)) return null;
    return data;
  } catch { return null; }
}

function cookieHeader(value, req) {
  // 转发头只有在显式信任代理时才认：客户端自带 `X-Forwarded-Proto: https` 就能让 Cookie 带上
  // Secure，纯 HTTP 部署下会把自己锁进「登录成功但仍未登录」的循环。
  // 多级反代是「客户端值 + 逐跳追加」，只有最右一段由最近一跳代理亲自写入。
  const protoList = TRUST_PROXY ? String(req.headers['x-forwarded-proto'] || '').split(',') : [];
  const proto = (protoList[protoList.length - 1] || '').trim();
  const secure = proto === 'https' || !!req.socket.encrypted;
  const age = value ? `Max-Age=${SESSION_TTL}` : 'Max-Age=0';
  return `${SESSION_COOKIE}=${encodeURIComponent(value || '')}; Path=/; HttpOnly; SameSite=Lax; ${age}${secure ? '; Secure' : ''}`;
}

// 只有在显式信任代理（TRUST_PROXY=1，反向代理/nginx 部署）时才读转发头：
// 部署版 note-api 直接发布端口，客户端自带 x-forwarded-for 就能让每个请求都是新 IP、
// 把登录失败计数拆散到无限多个 key 上（限流形同虚设）。
const TRUST_PROXY = /^(1|true|yes)$/i.test(String(process.env.TRUST_PROXY || ''));
function clientIp(req) {
  if (TRUST_PROXY) {
    // 只认最右一段（最近一跳代理追加的那一跳）：最左段完全由客户端决定，
    // 拿它当身份就能给每个请求换一个 IP，把失败计数拆散到无限多个 key 上。
    // 也不读 x-real-ip：Caddy / Traefik 默认不设置它，客户端自带的值会原样穿透。
    const hops = String(req.headers['x-forwarded-for'] || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const last = hops[hops.length - 1];
    if (last) return last;
  }
  return req.socket.remoteAddress || 'unknown';
}

// 把客户端给的相对路径钉死在笔记库内部，只允许 .md。
// 服务端私有目录（回收站 / 看板设置 / 网页快照）一律不开放读写：否则任何登录用户都能
// 覆盖回滚备份、改 settings.json，或读到全部历史版本（实测 GET /api/note?path=.trash/… 返回 200）。
const PRIVATE_DIRS = ['.trash/', '.dashboard/', SNAPSHOTS_DIR + '/'];
function inside(rel) {
  const raw = String(rel || '').replace(/\\/g, '/').trim();
  if (!raw || raw.includes('\0')) fail(400, '缺少路径');
  if (!raw.toLowerCase().endsWith('.md')) fail(400, '只允许读写 .md 文件');
  const p = resolve(VAULT, raw);
  if (p !== VAULT && !p.startsWith(VAULT + sep)) fail(400, '路径越界');
  // 真实位置校验：符号链接目录会让上面的字符串前缀检查形同虚设（写/删都会落到库外）。
  if (!insideRealVault(p)) fail(400, '路径越界');
  const norm = p.slice(VAULT.length + 1).split(sep).join('/');
  // 黑名单必须逐段归一化再比：Windows / APFS 上 `.trash./x.md`、`.TRASH/x.md`、`.trash /x.md`
  // 都会解析到真实 .trash 目录，而字符串 startsWith 判不出来（本机实测 Test-Path '.trash.' 为真）。
  const segs = norm.split('/').map(s => s.replace(/[. ]+$/, '').toLowerCase());
  if (segs.some(s => s === '.trash' || s === '.dashboard')) fail(400, '这个目录只允许服务端内部访问');
  if (segs[0] === '06-个人知识库' && segs[1] === '.snapshots') fail(400, '这个目录只允许服务端内部访问');
  return {abs: p, rel: norm};
}

// 网页快照路径：只允许 06-个人知识库/.snapshots/ 下的 .html（剪藏 HTML 不可信，读取时由路由加 CSP）。
function insideHtml(rel) {
  const raw = String(rel || '').replace(/\\/g, '/').trim();
  if (!raw || raw.includes('\0')) fail(400, '缺少路径');
  if (!raw.toLowerCase().endsWith('.html')) fail(400, '只允许 .html 快照');
  const p = resolve(VAULT, raw);
  const expected = join(VAULT, SNAPSHOTS_DIR + sep);
  if (!p.startsWith(expected)) fail(400, '快照必须位于 ' + SNAPSHOTS_DIR + '/ 下');
  if (!insideRealVault(p)) fail(400, '路径越界');
  return {abs: p, rel: p.slice(VAULT.length + 1).split(sep).join('/')};
}

const mtimeOf = abs => statSync(abs).mtimeMs;

// —— 笔记库读取（带短缓存；写操作会立即失效）——
// 注意 readVault 全程是同步 fs：多个标签页同时冷启动也只会有一个真正去读盘（其余请求在
// 事件循环里排队，等到的就是已经填好的缓存），所以这里不需要 single-flight 去重。
let cache = {at: 0, data: null};
function loadData(maxAge = 1500) {
  if (cache.data && Date.now() - cache.at < maxAge) return cache.data;
  const data = readVault({vault: VAULT});
  const files = {};
  const figures = {};
  const mtimes = {};
  // 附件（figures）由 readVault 在读取正文时顺手算好：这里原来把每个文件再读一遍，
  // 几千篇的库等于每次 /api/data 都把整个 vault 读两遍；而且截断到 6000 字的正文
  // 拿不到后面的图片引用，作品详情页报的「N 张图」会偏少。
  const add = (id, rel, attachments) => {
    files[id] = rel;
    if (attachments?.length) figures[id] = attachments;
  };
  for (const w of data.works) add('post:' + w.post.id, w.rel, w.attachments);
  // personal / news 的 id 规则跟索引、图谱共用 noteNodeId()：personal 用自己的前缀，news 沿用 note:（历史语义边依赖它）。
  for (const n of data.notes) add(noteNodeId(n), n.rel, n.attachments);
  for (const i of data.ideas) add('idea:' + i.id, i.rel, null);
  for (const d of data.drafts) add('draft:' + d.id, d.rel, null);
  // mtime 只能现取（乐观锁必须是最新的），但一次 stat 比「读全文 + 正则匹配附件」便宜一个数量级
  for (const [id, rel] of Object.entries(files)) {
    try { mtimes[id] = mtimeOf(join(VAULT, rel)); } catch {}
  }
  cache = {at: Date.now(), data: {...data, files, figures, mtimes, generatedAt: new Date().toISOString()}};
  return cache.data;
}
const invalidate = () => { cache = {at: 0, data: null}; };

// 写入的目标一律用「相对路径」定位，不用 n1 / w1 这类位置 id——
// 位置 id 在笔记增删后会整体位移，拿它当写入口令迟早会写到别的文件上。
function target({path, id}) {
  // path 与 id 同时给出时以前是 path 静默胜出，调用方以为按 id 定位成功
  if (path && id) fail(400, 'path 与 id 只能二选一');
  if (path) return inside(path).rel;
  if (!id) fail(400, '缺少 path（写入必须用相对路径定位文件）');
  const rel = loadData().files[id];
  // 「给了 id 但查不到」是 404，不是「参数没给」：原实现把两者并成一个 400，
  // 前端只看到「缺少 path」，失效 id 的真实原因被掩盖。
  if (!rel) fail(404, `找不到该 id 对应的文件：${id}`);
  return rel;
}

// —— 写回 ——
// 备份不能每次都写同一个 .trash/<rel>：同一篇笔记被反复删除/编辑时第二次会静默覆盖第一次，
// 「误写可回滚」就只剩最近一版（实测 A 版永久丢失）。首次仍用 .trash/<rel>（沿用既有预期），
// 已存在时追加时间戳 + 随机后缀，保留历史版本。
function backup(rel, text) {
  let dest = join(VAULT, '.trash', rel);
  if (existsSync(dest)) {
    const ext = extname(dest);
    const stem = dest.slice(0, dest.length - ext.length);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\..*$/, '');
    dest = `${stem}.${stamp}-${randomBytes(2).toString('hex')}${ext}`;
    for (let i = 2; existsSync(dest) && i < 100; i++) dest = `${stem}.${stamp}-${randomBytes(2).toString('hex')}${ext}`;
  }
  mkdirSync(dirname(dest), {recursive: true});
  // 备份自身也要原子：写一半崩溃会留下残缺备份，正好在最需要回滚时不可用
  try { writeAtomicSync(dest, text, 'utf8'); }
  catch (e) { throw new Error(`写备份 ${rel} 失败：${e.message}`); }
  pruneTrash();
}

// .trash 只增不删：每改一次正文就留一份全文，笔记库天天改，一年下来能把 NAS 塞满，
// 而「误写可回滚」只需要最近若干版。每小时最多裁一次，删掉超过 TRASH_KEEP_DAYS 天的旧备份。
const TRASH_KEEP_DAYS = Number(process.env.TRASH_KEEP_DAYS || 30);
let trashPrunedAt = 0;
function pruneTrash() {
  const now = Date.now();
  if (!(TRASH_KEEP_DAYS > 0) || now - trashPrunedAt < 3600_000) return;
  trashPrunedAt = now;
  const root = join(VAULT, '.trash');
  let entries;
  try { entries = readdirSync(root, {recursive: true, withFileTypes: true}); } catch { return; }
  const cutoff = now - TRASH_KEEP_DAYS * 86400_000;
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const abs = join(ent.parentPath || root, ent.name);
    try { if (statSync(abs).mtimeMs < cutoff) rmSync(abs, {force: true}); } catch {}
  }
}

// git 自动提交：失败绝不能静默。文档承诺「笔记库是 git 仓库，误写可回滚」，用户按此理解
// 自己的数据可恢复性；容器里 .git 属主与进程 UID 不一致（换 UID 后常见）、index.lock 残留、
// 磁盘满、safe.directory 不匹配任意一种都会走到 catch。写回本身已成功，所以只警告不失败，
// 但必须留痕，否则历史静默断档而没人知道。
const GIT_TIMEOUT = 5000; // 同步调用在请求路径上：大 vault 上不设超时会阻塞整个事件循环
function gitCommit(rel, message) {
  if (!VAULT_GIT || !existsSync(join(VAULT, '.git'))) return false;
  try {
    execFileSync('git', ['add', '--', rel], {cwd: VAULT, stdio: 'ignore', timeout: GIT_TIMEOUT});
    execFileSync('git', ['commit', '-m', message, '--', rel], {cwd: VAULT, stdio: 'ignore', timeout: GIT_TIMEOUT});
    return true;
  } catch (e) {
    console.warn('[note-api] git 提交失败（文件已写入，只是没进版本库）：', rel, e.status ?? e.message);
    return false;
  }
}

// 多文件提交（网页剪藏：md + 快照一起进版本库）。路径已由调用方各自校验。
function gitCommitMulti(rels, message) {
  if (!VAULT_GIT || !existsSync(join(VAULT, '.git'))) return false;
  try {
    execFileSync('git', ['add', '--', ...rels], {cwd: VAULT, stdio: 'ignore', timeout: GIT_TIMEOUT});
    execFileSync('git', ['commit', '-m', message, '--', ...rels], {cwd: VAULT, stdio: 'ignore', timeout: GIT_TIMEOUT});
    return true;
  } catch (e) {
    console.warn('[note-api] git 提交失败（文件已写入，只是没进版本库）：', rels.join(', '), e.status ?? e.message);
    return false;
  }
}

// —— 看板设置（vault/.dashboard/settings.json）——
// 只存少量不属于笔记的看板偏好：月目标、用户选的 AI 模型、发布平台凭据与同步时间。
const SETTINGS_DEFAULTS = {version: 1, goal: 8, aiModel: null, aiBaseUrl: null, platforms: {}, syncHour: null};
const SETTINGS_KEYS = new Set(['goal', 'aiModel', 'aiBaseUrl', 'platforms', 'syncHour']);
// 平台凭据的 secret 与 AI key 同策略：存 DATA_DIR（0o600），不进 vault。
// settings.json 会被 gitCommit 进 vault 并随 Syncthing 分发，明文 AppSecret 一旦进 git 历史就删不掉，
// 用户只能去微信后台重置——所以 platform-secrets.json 是唯一的存放处，settings.json 只留 appid。
const PLATFORM_SECRETS_FILE = join(DATA_DIR, 'platform-secrets.json');
function loadPlatformSecrets() {
  try {
    const raw = JSON.parse(readFileSync(PLATFORM_SECRETS_FILE, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}
function savePlatformSecrets(map) {
  mkdirSync(DATA_DIR, {recursive: true});
  try {
    writeAtomicSync(PLATFORM_SECRETS_FILE, JSON.stringify(map, null, 2) + '\n', {encoding: 'utf8', mode: 0o600});
  } catch (e) {
    throw new Error(`写入平台凭据失败：${e.message}`);
  }
}
// AI key 存 DATA_DIR/ai-secrets.json（0o600）：settings.json 会 gitCommit 进 vault 并随 Syncthing 分发，key 不能放那里。
const AI_SECRETS_FILE = join(DATA_DIR, 'ai-secrets.json');
function loadAiSecret() {
  try { return String(JSON.parse(readFileSync(AI_SECRETS_FILE, 'utf8')).aiApiKey || ''); } catch { return ''; }
}
function saveAiSecret(key) {
  mkdirSync(DATA_DIR, {recursive: true});
  try {
    writeAtomicSync(AI_SECRETS_FILE, JSON.stringify({aiApiKey: key}, null, 2) + '\n', {encoding: 'utf8', mode: 0o600});
  } catch (e) {
    throw new Error(`写入 AI key 失败：${e.message}`);
  }
}
// 启动时应用持久化的运行时配置（env 是初始值，settings 有值才覆盖）
try {
  const s0 = readSettings();
  setAiRuntime({baseUrl: s0.aiBaseUrl || null, apiKey: loadAiSecret() || null, model: s0.aiModel || null});
} catch (e) { console.error('[note-api] 启动应用 AI 运行时配置失败（沿用 env 缺省）：', e.message); }

// settings.json 里的平台凭据形状：{公众号: {appid, secret, ...}}。
// 校验白名单：只认公众号，secret 必须是非空字符串；写盘前原样存，读出来给 platforms.mjs 用。
// 读取路径要容忍历史/手写配置（早期版本用英文键 wechat 存过凭据），
// 写路径仍然严格：读的时候抛错会被 readSettings 的 catch 整段吞成默认值，
// 结果是「月目标 / 全局模型 / 同步时间」一起被静默重置，比报错难查得多。
function cleanPlatforms(raw, {strict = true} = {}) {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    if (strict) fail(400, 'platforms 必须是对象');
    return {};
  }
  const out = {};
  for (const [name, cfg] of Object.entries(raw)) {
    if (name !== '公众号') {
      if (strict) fail(400, `不支持的平台：${name}（个人号没有数据接口，指标请在看板手动补填）`);
      // 非严格读取：只有能归一化成公众号的形状才收，其余忽略
      const a = typeof cfg?.appid === 'string' ? cfg.appid.trim() : '';
      const sec = typeof cfg?.secret === 'string' ? cfg.secret.trim() : '';
      if (a && sec && cfg && typeof cfg === 'object') out['公众号'] = {appid: a, secret: sec};
      continue;
    }
    if (cfg == null) continue; // 传 null 清除该平台凭据
    if (typeof cfg !== 'object') {
      if (strict) fail(400, '平台配置必须是对象');
      continue;
    }
    const appid = typeof cfg.appid === 'string' ? cfg.appid.trim() : '';
    const secret = typeof cfg.secret === 'string' ? cfg.secret.trim() : '';
    if (appid && secret) out[name] = {appid, secret};
    else if ((appid || secret) && strict) fail(400, '公众号 AppID 和 Secret 要一起填');
    // 非严格读取：settings.json 里只存 appid，secret 在 DATA_DIR；先收下，由 readSettings 补 secret 后判定。
    else if ((appid || secret) && !strict) out[name] = {appid, secret};
  }
  return out;
}

function readSettings() {
  try {
    if (!existsSync(SETTINGS_FILE)) return {...SETTINGS_DEFAULTS};
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
    const goal = Number.isInteger(raw?.goal) && raw.goal >= 1 && raw.goal <= 100 ? raw.goal : SETTINGS_DEFAULTS.goal;
    const aiModel = typeof raw?.aiModel === 'string' && raw.aiModel ? raw.aiModel : null;
    const aiBaseUrl = typeof raw?.aiBaseUrl === 'string' ? raw.aiBaseUrl : null;
    const platforms = cleanPlatforms(raw?.platforms, {strict: false});
    // 补上 DATA_DIR 里的 secret，并把「配了一半」的条目丢掉（否则 platforms.mjs 会拿空 secret 去换 token）
    const storedSecrets = loadPlatformSecrets();
    for (const [k, v] of Object.entries(platforms)) {
      if (!v.secret && typeof storedSecrets[k] === 'string') v.secret = storedSecrets[k];
      if (!v.appid || !v.secret) delete platforms[k];
    }
    const syncHour = Number.isInteger(raw?.syncHour) && raw.syncHour >= 0 && raw.syncHour <= 23 ? raw.syncHour : null;
    return {version: 1, goal, aiModel, aiBaseUrl, platforms, syncHour, ...(raw?.updatedAt ? {updatedAt: String(raw.updatedAt)} : {})};
  } catch {
    return {...SETTINGS_DEFAULTS};
  }
}

// 给前端的设置视图：secret 一律不回传，只报「已配置」。
function publicSettings() {
  const s = readSettings();
  return {
    ...s,
    aiKeyConfigured: !!loadAiSecret(),
    platforms: Object.fromEntries(Object.entries(s.platforms).map(([k, v]) => [k, {
      appid: v.appid, configured: true, secretMasked: '••••••'
    }]))
  };
}

function writeSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail(400, '设置必须是对象');
  for (const k of Object.keys(patch)) if (!SETTINGS_KEYS.has(k)) fail(400, `未知设置项：${k}`);
  if ('goal' in patch && !(Number.isInteger(patch.goal) && patch.goal >= 1 && patch.goal <= 100)) fail(400, '目标必须是 1–100 的整数');
  if ('aiModel' in patch && !(patch.aiModel === null || (typeof patch.aiModel === 'string' && patch.aiModel))) fail(400, 'AI 模型必须是字符串或 null');
  if ('aiBaseUrl' in patch && !(patch.aiBaseUrl === null || (typeof patch.aiBaseUrl === 'string' && (/^https?:\/\//.test(patch.aiBaseUrl) || patch.aiBaseUrl === '')))) fail(400, 'AI 接口地址必须以 http(s):// 开头（留空回退环境变量）');
  if ('platforms' in patch) {
    // 前端看不到 secret（只有掩码），只改 AppID 时 secret 不重填。
    // 必须先把已存的 secret 补回去再校验：直接交给 cleanPlatforms 会先抛
    // 「AppID 和 Secret 要一起填」，后面的沿用逻辑永远走不到（改 AppID 必然 400）。
    const cur = readSettings().platforms;
    const raw = patch.platforms;
    const filled = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.fromEntries(Object.entries(raw).map(([k, v]) => [k,
          // 只有「留空 secret 但要保留凭据」（appid 仍填着）才沿用旧 secret。
          // 两个输入框都清空是「关掉同步」的合法操作，这里补回 secret 会让 cleanPlatforms
          // 走进「AppID 和 Secret 要一起填」→ 400，用户再没有关掉同步的入口。
          v && typeof v === 'object' && !Array.isArray(v) && !String(v.secret ?? '').trim()
            && String(v.appid ?? '').trim() && cur[k]?.secret
            ? {...v, secret: cur[k].secret} : v]))
      : raw;
    // secret 分流到 DATA_DIR：settings.json 只留 appid，避免明文凭据进 vault 的 git 历史
    const clean = cleanPlatforms(filled);
    const secrets = loadPlatformSecrets();
    for (const [k, v] of Object.entries(clean)) secrets[k] = v.secret;
    for (const k of Object.keys(secrets)) if (!(k in clean)) delete secrets[k];
    savePlatformSecrets(secrets);
    patch = {...patch, platforms: Object.fromEntries(Object.entries(clean).map(([k, v]) => [k, {appid: v.appid}]))};
  }
  if ('syncHour' in patch && !(patch.syncHour === null || (Number.isInteger(patch.syncHour) && patch.syncHour >= 0 && patch.syncHour <= 23))) fail(400, '同步时间必须是 0–23 的整数或 null');
  const next = {...readSettings(), ...patch, version: 1, updatedAt: new Date().toISOString()};
  // readSettings 会把 DATA_DIR 的 secret 合进来供 platforms.mjs 使用；写回文件前必须剥掉
  next.platforms = Object.fromEntries(Object.entries(next.platforms || {}).map(([k, v]) => [k, {appid: v.appid}]));
  mkdirSync(SETTINGS_DIR, {recursive: true});
  try {
    writeAtomicSync(SETTINGS_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
  } catch (e) {
    throw new Error(`写入设置失败：${e.message}`);
  }
  gitCommit('.dashboard/settings.json', '更新看板设置');
  // AI 运行时应用集中在 /api/settings 的 PUT 路由（key 在那里分流后才可用），这里只管持久化。
  return next;
}

// idea / draft 的 frontmatter 白名单校验：只接受约定字段，非法值直接 400，
// 避免把前端的临时状态写进笔记文件。
bindSettingsReader(readSettings);
// 一次性迁移：旧版本把平台 secret 明文写进了 settings.json（已进 vault 的 git 历史）。
// 这里搬到 DATA_DIR 并从 settings.json 删掉；历史里的旧值无法回滚，提示用户去平台后台重置。
function migratePlatformSecrets() {
  try {
    if (!existsSync(SETTINGS_FILE)) return;
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
    const ps = raw && typeof raw.platforms === 'object' && raw.platforms ? raw.platforms : null;
    if (!ps) return;
    const secrets = loadPlatformSecrets();
    const keep = {};
    let moved = false;
    for (const [k, v] of Object.entries(ps)) {
      const appid = typeof v?.appid === 'string' ? v.appid.trim() : '';
      const secret = typeof v?.secret === 'string' ? v.secret.trim() : '';
      if (secret) { secrets[k] = secret; moved = true; }
      if (appid) keep[k] = {appid};
    }
    if (!moved) return;
    savePlatformSecrets(secrets);
    raw.platforms = keep;
    writeAtomicSync(SETTINGS_FILE, JSON.stringify(raw, null, 2) + '\n', 'utf8');
    gitCommit('.dashboard/settings.json', '平台 Secret 移出 vault（改存 DATA_DIR）');
    console.error('[note-api] 平台 Secret 已移到 DATA_DIR；vault 的 git 历史里仍有旧值，建议在平台后台重置一次');
  } catch (e) {
    console.error('[note-api] 平台凭据迁移失败（沿用 settings.json 里的旧值）：', e.message);
  }
}
migratePlatformSecrets();
function cleanFm(kind, fm) {
  if (fm == null) return {};
  if (typeof fm !== 'object' || Array.isArray(fm)) fail(400, 'fm 必须是对象');
  const out = {};
  if (kind === 'idea') {
    for (const k of ['platform', 'priority', 'status', 'note', 'sourceNews', 'id', 'sourceIdeaId']) {
      if (!(k in fm)) continue;
      if (typeof fm[k] !== 'string') fail(400, `选题属性 ${k} 必须是字符串`);
      if (k === 'id' && fm.id.length > 32) fail(400, 'id 过长');
      out[k] = fm[k];
    }
    if ('priority' in out && !['高', '中', '低'].includes(out.priority)) fail(400, '优先级必须是 高/中/低');
    if ('status' in out && !['待写', '待扩展', '已转草稿'].includes(out.status)) fail(400, '状态必须是 待写/待扩展/已转草稿');
  } else {
    // 草稿也允许带稳定 id：/api/publish 要靠它把「草稿 → 作品」这一跳写进作品 frontmatter
    // （发布时草稿文件被移走，只有 id 能在移走前后都成立）。格式与选题的稳定 id 一致，只放行短字符串。
    if ('id' in fm) {
      if (typeof fm.id !== 'string') fail(400, 'id 必须是字符串');
      if (fm.id.length > 32) fail(400, 'id 过长');
      out.id = fm.id;
    }
    if ('source' in fm) {
      if (!(typeof fm.source === 'string' || typeof fm.source === 'number')) fail(400, 'source 必须是选题标题或选题 id');
      out.source = String(fm.source);
    }
    if ('sourceIdeaId' in fm) {
      if (typeof fm.sourceIdeaId !== 'string') fail(400, 'sourceIdeaId 必须是字符串（选题的稳定 id）');
      out.sourceIdeaId = fm.sourceIdeaId;
    }
    // 草稿 / 作品的发布来源字段（半自动发布回填；作品走 /api/note 的 fm 白名单之外另行处理）
    for (const k of ['platform', 'url', 'platformId', 'syncedAt']) {
      if (!(k in fm)) continue;
      if (typeof fm[k] !== 'string') fail(400, `发布来源 ${k} 必须是字符串`);
      out[k] = fm[k];
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
function writeExisting(rel, {body, fm, mtime, requireMtime}) {
  const {abs} = inside(rel);
  if (!existsSync(abs)) fail(404, `文件不存在：${rel}`);
  const before = readFileSync(abs, 'utf8');
  const current = mtimeOf(abs);
  if (mtime != null) {
    const want = Number(mtime);
    // NaN 会让下面的比较恒为 false，乐观锁静默失效：实测 mtime:"abc" 直接覆盖成功且回 200。
    if (!Number.isFinite(want)) fail(400, 'mtime 必须是毫秒时间戳');
    if (Math.abs(want - current) > 1) {
      fail(409, '文件已被其他地方改动', {path: rel, mtime: current, content: before});
    }
  } else if (requireMtime && body !== undefined) {
    // 写正文却一个 mtime 都不带 = 整把锁被跳过（实测直接 200 覆盖）。只有 /api/note（笔记正文编辑器）
    // 打开这条硬约束：它读完整全文再写回，前端一定带着 mtime；选题 / 草稿的新建式 PUT 与
    // frontmatter-only 的回写（发布、AI 打标）走的是别的契约，保持原样。
    fail(409, '缺少 mtime：写回正文必须带上读到的 mtime', {path: rel, mtime: current, content: before});
  }
  const after = writeDoc(before, {fm: alignKeys(fm, before), body});
  if (after === before) return {path: rel, mtime: current, changed: false, text: after};
  backup(rel, before);
  // 同目录临时文件 + rename + fsync：写盘中途被杀/断电时只会留下完整旧版或完整新版，
  // 不会把 .md 截成半截（原地覆盖写坏的文件，乐观锁也分不清「写坏」和「被改」）。
  // fsync 不能省：rename 只保证目录项原子，掉电后新 inode 的数据块可能还在页缓存里。
  try {
    writeAtomicSync(abs, after, 'utf8');
  } catch (e) {
    throw new Error(`写入 ${rel} 失败：${e.message}`);
  }
  gitCommit(rel, `更新 ${rel}`);
  invalidate();
  return {path: rel, mtime: mtimeOf(abs), changed: true, text: after};
}

// create 的幂等键：请求已在服务端落盘但响应丢了（nginx 504、切后台断连）时，客户端的重试
// 不能再写第二份 —— 否则库里会多出一份没人编辑的「标题 2.md」孤儿文件。同一个 requestId
// 在 10 分钟内重复出现就返回第一次写的那个文件。
const createMemo = new Map();
const CREATE_MEMO_TTL = 10 * 60_000;
function createMemoHit(requestId) {
  if (!requestId) return null;
  const hit = createMemo.get(requestId);
  if (!hit) return null;
  if (Date.now() - hit.at > CREATE_MEMO_TTL) { createMemo.delete(requestId); return null; }
  return existsSync(join(VAULT, hit.path)) ? hit.path : null;
}
function createMemoPut(requestId, rel) {
  if (!requestId || !rel) return;
  if (createMemo.size > 512) {
    for (const [k, v] of createMemo) if (Date.now() - v.at > CREATE_MEMO_TTL) createMemo.delete(k);
  }
  createMemo.set(requestId, {path: rel, at: Date.now()});
}

// 新建一篇笔记。标题做文件名，重名时加序号；正文与 frontmatter 用固定模板写出。
function createNote(kind, {title, body = '', fm = {}, requestId}) {
  const reused = createMemoHit(requestId);
  if (reused) {
    invalidate();
    return {path: reused, mtime: mtimeOf(join(VAULT, reused)), text: readFileSync(join(VAULT, reused), 'utf8'), reused: true};
  }
  const dir = KIND_DIR[kind] || KIND_DIR.note;
  const name = safeName(title);
  const text = writeDoc('', {fm, body});
  mkdirSync(join(VAULT, dir), {recursive: true});
  // 独占创建 + 原子落盘的组合：先把整篇写进 .tmp（TEMP_FILE_RE 认得出并会清理），
  // 再用 link 把 tmp 挂到最终文件名上 —— 目标已存在就抛 EEXIST（等价于原来的 'wx'），
  // 而内容永远不会以半截形式出现在真实文件名上（原来的 'wx' 只防覆盖、不防写一半崩溃）。
  let rel = '';
  for (let i = 1; i < 1000 && !rel; i++) {
    const cand = posix.join(dir, (i === 1 ? name : `${name} ${i}`) + '.md');
    const tmpAbs = join(VAULT, posix.join(dir, `.${posix.basename(cand)}.${process.pid}-${Date.now()}.tmp`));
    try {
      writeFileSync(tmpAbs, text, 'utf8');
      fsyncPath(tmpAbs, true);
      linkSync(tmpAbs, join(VAULT, cand));
      rel = cand;
    } catch (e) {
      // 个别 SMB/CIFS 挂载不支持硬链接（EPERM/ENOSYS/EXDEV）：退回独占复制，语义相同
      if (e.code === 'EPERM' || e.code === 'ENOSYS' || e.code === 'EXDEV') {
        try { copyFileSync(tmpAbs, join(VAULT, cand), fsConstants.COPYFILE_EXCL); rel = cand; }
        catch (e2) { if (e2.code !== 'EEXIST') throw e2; }
      } else if (e.code !== 'EEXIST') throw e;
    } finally {
      try { rmSync(tmpAbs, {force: true}); } catch {}
    }
  }
  if (!rel) fail(409, `同名文件过多：${name}`);
  const abs = join(VAULT, rel);
  createMemoPut(requestId, rel);
  gitCommit(rel, `新增 ${rel}`);
  invalidate();
  return {path: rel, mtime: mtimeOf(abs), text};
}

// Obsidian 禁止出现在文件名里的字符，另外把双链里有歧义的 # ^ [ ] | 也换掉
const safeName = t => {
  const name = String(t || '').replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ').replace(/^\.+/, '').trim().slice(0, 80)
    // 结尾的点与空格在 Windows / SMB 上会被系统吞掉：落盘名与 rel 不一致，
    // 之后按 rel 找不到文件（每次保存都像新建）。统一去掉。
    .replace(/[. ]+$/, '');
  if (!name) return '未命名';
  // Windows 保留设备名（CON / NUL / COM1…）在 SMB 目标上会 EINVAL，前加下划线躲开。
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name) ? '_' + name : name;
};
// 新建时给重名笔记加的后缀：「标题 N」
const dedupName = name => new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\d+$');

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

// —— 崩溃残留清理 ——
// 所有落盘都是「写 tmp → rename」，进程在这两步之间被杀就会在目录里留下
// `.<名字>.<pid>-<时间戳>.tmp`。它们会被 Obsidian / Syncthing / git 当成普通文件同步与提交。
// 只删 1 小时前的：刚写出来的可能是另一个实例此刻正在用的临时文件。
const TEMP_FILE_RE = /^\..+\.\d+-\d+\.tmp$/;
function cleanupTempFiles(root, depth = 0) {
  if (!root || depth > 6) return 0;
  let entries;
  try { entries = readdirSync(root, {withFileTypes: true}); } catch { return 0; }
  const cutoff = Date.now() - 3600_000;
  let removed = 0;
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      removed += cleanupTempFiles(p, depth + 1);
      continue;
    }
    if (!TEMP_FILE_RE.test(e.name)) continue;
    try { if (statSync(p).mtimeMs < cutoff) { rmSync(p, {force: true}); removed++; } } catch {}
  }
  return removed;
}

// —— 索引 ——
function reindex(data = loadData()) {
  const rows = [];
  // 1.5s 快照缓存里的文件可能刚被外部删掉/改名：statSync 抛 ENOENT 会让整个 /api/data 500，
  // 这里按 loadData 收集 mtimes 的同一策略兜底，缺文件的行跳过（下一次 loadData 就不再包含它）。
  //
  // 少读到一篇 ≠ 它被删了（SMB 抖动、被独占、权限）：readVault 对读不出正文的文件是 continue，
  // 这时如果照常做「删掉不在 rows 里的 id」与批量清扫，那一篇的向量、AI 摘要、语义边会被
  // 永久删除（下次 relate 要全量重算 embedding、analyze 要重烧 token）。所以统计缺文件数，
  // 只要有一个，这一轮就只增只改、不删不清。
  const mtimes = data.mtimes || {};
  let missing = 0;
  const at = (id, rel) => {
    // loadData 已经为每个文件 stat 过一次（乐观锁用的就是它），这里直接复用，
    // 不再对同一批路径 stat 第二遍（几千篇的库等于每次 /api/data 多几千次系统调用）。
    const known = mtimes[id];
    if (Number.isFinite(known)) return new Date(known).toISOString();
    try { return new Date(statSync(join(VAULT, rel)).mtimeMs).toISOString(); } catch { missing++; return null; }
  };
  const push = (id, rel, title, kind, body) => {
    const mtime = at(id, rel);
    if (!mtime) return;
    rows.push({id, path: rel, title, kind, body, hash: hashOf(body), mtime});
  };
  for (const w of data.works) push('post:' + w.post.id, w.rel, w.post.title, 'post', w.content.body);
  for (const n of data.notes) push(noteNodeId(n), n.rel, n.title, n.kind, n.body);
  for (const i of data.ideas) push('idea:' + i.id, i.rel, i.title, 'idea', i.note || '');
  for (const d of data.drafts) push('draft:' + d.id, d.rel, d.title, 'draft', d.body);
  return index.syncNotes(rows, {prune: missing === 0 && !data.unreadable});
}

// 索引只覆盖 /api/data 的展示窗口（作品 30、方法笔记 40、日报 60、个人库 120、选题草稿 300）：
// 窗口外的文件搜不到，也不会进 RAG 上下文——文件明明躺在库里却回答「没有相关内容」。
// 命中为空时用一次全量读兜底（只在未命中时付这份钱，正常检索零额外开销）。
function searchAll(q, limit = 20) {
  const term = String(q || '').trim();
  const hits = index.search(term, limit);
  if (hits.length || [...term].length < 2) return hits;
  try {
    const full = readVault({vault: VAULT, full: true});
    const pool = [
      ...full.works.map(w => ({id: 'post:' + w.post.id, title: w.post.title, kind: 'post', rel: w.rel, body: w.content?.body || ''})),
      ...full.notes.map(n => ({id: noteNodeId(n), title: n.title, kind: n.kind, rel: n.rel, body: n.body})),
      ...full.ideas.map(i => ({id: 'idea:' + i.id, title: i.title, kind: 'idea', rel: i.rel, body: i.note || ''})),
      ...full.drafts.map(x => ({id: 'draft:' + x.id, title: x.title, kind: 'draft', rel: x.rel, body: x.body || ''}))
    ];
    const seen = new Set(hits.map(h => h.id));
    const needle = term.toLowerCase();
    for (const x of pool) {
      if (hits.length >= limit) break;
      if (seen.has(x.id)) continue;
      const at = (x.title + '\n' + x.body).toLowerCase().indexOf(needle);
      if (at < 0) continue;
      seen.add(x.id);
      hits.push({id: x.id, title: x.title, kind: x.kind, path: x.rel, snip: x.body.slice(Math.max(0, at - 40), at + 80)});
    }
  } catch (e) { console.error('[note-api] 全量检索兜底失败：', e.message); }
  return hits;
}

// —— 静态托管（可选，用来省掉单独的 nginx）——
const MIME = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.map': 'application/json; charset=utf-8'};
function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname).replace(/\\/g, '/').replace(/^\/+/, ''); }
  catch { rel = ''; } // 畸形 URL 当作没这个文件，走 SPA 回退
  // 反斜杠必须先归一化成 '/' 再判 ..：Windows 上 join/resolve 把 \ 当分隔符，
  // 只按 '/' 切分时 `..\dist2\leak.js` 能跳出 STATIC_DIR（原实现实测可读到相邻目录文件）。
  if (rel.includes('\0') || rel.split('/').includes('..')) return false;
  let abs = resolve(STATIC_DIR, rel);
  // 前缀比较必须带分隔符：`…/dist2` 也 startsWith(`…/dist`) 成立
  if (abs !== STATIC_DIR && !abs.startsWith(STATIC_DIR + sep)) return false;
  const missing = !existsSync(abs) || statSync(abs).isDirectory();
  if (missing) {
    // 只在「看起来是页面路由」（没有扩展名）时才回退到 index.html。
    // 原来任何未命中的路径都回 index.html + 200：`/foo/assets/main.js` 这种深链会先拿 200
    // 空壳页，再让浏览器把一段 HTML 当 JS 解析（控制台一串 Unexpected token '<'），
    // 真正的 404 反而被吞掉。
    if (extname(rel)) return false;
    abs = join(STATIC_DIR, 'index.html');
    if (!existsSync(abs)) return false;
  }
  const st = statSync(abs);
  const type = MIME[extname(abs).toLowerCase()] || 'application/octet-stream';
  // Vite 产物带内容 hash，可以永久缓存；入口 HTML 必须每次协商（否则改了 index.html 拉不到新版）。
  // 原来统一 no-cache 且没有 ETag：每次刷新都全量重传 JS/CSS，而 no-cache 的协商缓存又完全失效。
  // 回退出来的 index.html 不是构建产物：必须每次协商，否则入口 HTML 被 immutable 钉一年
  const isAsset = !missing && rel.startsWith('assets/');
  const cacheControl = isAsset ? 'public, max-age=31536000, immutable' : 'no-cache';
  const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
  const head = {'content-type': type, 'cache-control': cacheControl, etag, 'vary': 'accept-encoding', ...SECURITY_HEADERS};
  if (String(req.headers['if-none-match'] || '') === etag) {
    res.writeHead(304, head);
    res.end();
    return true;
  }
  let body = readFileSync(abs);
  // 文本类资源（js/css/html/svg/json）压缩后再发；图片字体不需要
  if (body.length > 1024 && /^(text\/|application\/(json|javascript|manifest))/.test(type) && acceptsGzip(req)) {
    body = gzipSync(body); head['content-encoding'] = 'gzip';
  }
  head['content-length'] = body.length;
  res.writeHead(200, head);
  res.end(body);
  return true;
}

// —— 鉴权 ——
function tokenAuthed(req) {
  if (!API_TOKEN) return false;
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-api-token'] || '');
  // 常量时间比较：`t === API_TOKEN` 会按首个不同字符的位置泄漏前缀信息
  return safeEqual(t, API_TOKEN);
}

function authed(req) {
  if (tokenAuthed(req)) return true;
  const auth = currentAuth();
  return !auth || !!verifySession(req, auth);
}

// —— 路由 ——
// 这两个端点的请求体是原始二进制（Content-Type 由上传的文件决定），不走「必须是 JSON」的闸。
const RAW_UPLOADS = new Set(['/api/attachment', '/api/knowledge/upload']);

async function route(req, res, url) {
  const p = url.pathname.replace(/\/+$/, '') || '/';

  // —— CSRF / 简单请求闸 ——
  // 会话 Cookie 是 SameSite=Lax，同站（evil.example.com → dash.example.com）仍会带上；
  // 而 `text/plain` 的 JSON body 属于「简单请求」，浏览器不发预检。原来只剩 SameSite 一道防线。
  // 因此非 GET/HEAD 一律要求 JSON Content-Type，并要求 sec-fetch-site 同源（无该头的老客户端不拦）。
  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (site && site !== 'same-origin' && site !== 'none') return json(res, 403, {error: '跨站请求被拒绝'});
    if (!RAW_UPLOADS.has(p)) {
      const hasBody = Number(req.headers['content-length'] || 0) > 0 || !!req.headers['transfer-encoding'];
      const ctype = String(req.headers['content-type'] || '').toLowerCase();
      if (hasBody && !ctype.startsWith('application/json')) {
        return json(res, 415, {error: '要求 Content-Type: application/json'});
      }
    }
  }

  // 健康检查默认只回 ok：绝对路径与索引条数不该对未鉴权请求暴露。
  // ?deep=1 再检查 vault 可读、DATA_DIR 可写（只回布尔，不含路径）：卷被快照锁定、配额满、
  // 或换个 UID 后 chown 改错时，容器必须显示 unhealthy —— 否则「页面能开、保存全失败」
  // 而 docker ps 一直 healthy，容器编排永远不会重启它，也没有任何健康信号指向根因。
  if (p === '/api/health') {
    if (url.searchParams.get('deep') !== '1') return json(res, 200, {ok: true});
    const can = fn => { try { fn(); return true; } catch { return false; } };
    const checks = {
      vault: can(() => accessSync(VAULT, fsConstants.R_OK)),
      data: can(() => accessSync(DATA_DIR, fsConstants.W_OK))
    };
    const ok = checks.vault && checks.data;
    return json(res, ok ? 200 : 503, {ok, checks});
  }

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
    // 失败记录只在成功登录时清除；不定期清过期项的话 Map 会随来源 IP 一直长
    if (loginFailures.size > 512) for (const [k, v] of loginFailures) if (v.reset <= now) loginFailures.delete(k);
    const bump = (k, at) => {
      const r = loginFailures.get(k);
      const next = r && r.reset > at ? {n: r.n + 1, reset: r.reset} : {n: 1, reset: at + LOGIN_WINDOW};
      loginFailures.set(k, next);
      return next;
    };
    // 只按 IP 计数会被两种情况打穿：反代后未设 TRUST_PROXY 时所有客户端共用一个 key
    // （一个人失败 8 次就能把主人锁在门外 5 分钟）；设了 TRUST_PROXY 时只有最右一跳可信，
    // 伪装最左段 x-forwarded-for 不再能拆 key。
    // 所以 IP 维度只做宽松上限（3×），精确计数落在「IP + 用户名」上。
    const ipKey = 'ip:' + ip;
    const ipRec = loginFailures.get(ipKey);
    if (ipRec && ipRec.reset > now && ipRec.n >= LOGIN_MAX * 3) {
      res.setHeader('retry-after', String(Math.ceil((ipRec.reset - now) / 1000)));
      return json(res, 429, {error: '尝试太频繁，请稍后再试'});
    }
    const {username, password} = await readBody(req);
    const key = ipKey + '|' + String(username ?? '').slice(0, 64);
    const rec = loginFailures.get(key);
    if (rec && rec.reset > now && rec.n >= LOGIN_MAX) {
      res.setHeader('retry-after', String(Math.ceil((rec.reset - now) / 1000)));
      return json(res, 429, {error: '尝试太频繁，请稍后再试'});
    }
    const ok = safeEqual(username ?? '', auth.user) & safeEqual(password ?? '', auth.password);
    if (!ok) {
      bump(ipKey, now);
      const next = bump(key, now);
      // 失败必须有痕迹：这是唯一能发现「有人在爆破」的地方（密码本身绝不入日志）。
      console.error(`[note-api] 登录失败 ip=${ip} user=${String(username ?? '').slice(0, 64)} n=${next.n}/${LOGIN_MAX}`);
      return json(res, 401, {error: '用户名或密码不正确', attemptsLeft: Math.max(0, LOGIN_MAX - next.n)});
    }
    loginFailures.delete(key);
    loginFailures.delete(ipKey);
    res.setHeader('set-cookie', cookieHeader(makeSession(auth), req));
    return json(res, 200, {ok: true, user: auth.user});
  }

  if (p === '/api/logout' && req.method === 'POST') {
    revokeSession(readCookie(req, SESSION_COOKIE));
    res.setHeader('set-cookie', cookieHeader('', req));
    return json(res, 200, {ok: true});
  }

  // 兼容旧反代的鉴权子请求约定：204 = 放行，401 = 拒绝。
  // 现在的镜像里没有 nginx，鉴权由 note-api 自己做（页面 302 到 login.html，其余 401），
  // 这个端点只作为外部反代 / 脚本的探针保留。
  if (p === '/api/auth-check') {
    if (authed(req)) {
      res.writeHead(204, {'cache-control': 'no-store'});
      return res.end();
    }
    return json(res, 401, {error: '未登录'});
  }

  if (!authed(req)) return json(res, 401, {error: '未登录'});

  // 任何写请求都先让 /api/version 的短缓存失效：否则「保存完立刻轮询」会读到 3 秒前的
  // 旧指纹，前端据此判断「没有变化」，刚写的内容不刷新（外部编辑器的改动最多滞后 3 秒）。
  if (req.method !== 'GET' && req.method !== 'HEAD') bumpVaultStamp();

  // 轻量指纹：外部编辑器改动 vault 后前端轮询这里决定要不要重新拉 /api/data。
  // v = 各文件 mtime 汇总（+ 条目数），不精确到单文件但足够发现「有变化」。
  if (p === '/api/version' && req.method === 'GET') {
    // 前端每 5 秒轮询一次：这里只能做 walk + stat 的轻量指纹。
    // 以前走全量数据装载（1.5s 缓存永远命中不了）＝ 每个标签页每 5 秒把整个 vault 读两遍。
    // 短缓存 3 秒：多标签页各自 5 秒轮询时，把全库 stat 合并成一次。
    const stamp = vaultStampCached(VAULT);
    return json(res, 200, {v: stamp.v, files: stamp.n, generatedAt: new Date().toISOString()});
  }

  if (p === '/api/data' && req.method === 'GET') {
    const d = loadData(url.searchParams.has('fresh') ? 0 : 1500);
    // 索引是派生数据，坏了应该「退化成搜不到」，而不是把读路径打死：
    // 两个实例共用 DATA_DIR / 磁盘满时，syncNotes 的写事务会抛错（database is locked、SQLITE_FULL），
    // 原来这里不拦就让整个 /api/data 500 —— 看板直接白屏。
    try { reindex(d); } catch (e) { console.error('[note-api] 索引同步失败（本次跳过）：', e.message); }
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
      settings: publicSettings(),
      semantic: index.semanticEdges(),
      ai: aiInfo(),
      platforms: platformInfo(),
      meta: {vaultName: basename(VAULT), counts: d.counts, generatedAt: d.generatedAt, indexed: index.count()}
    });
  }

  if (p === '/api/settings' && req.method === 'GET') return json(res, 200, publicSettings());

  if (p === '/api/settings' && req.method === 'PUT') {
    const body = await readBody(req);
    // AI key 单独分流：不进 settings.json（那会被 git 提交进 vault），存 DATA_DIR 秘密文件。
    // '' = 清除恢复 env 缺省；缺字段 = 不改动。
    // 先做全部校验（key 的类型 + writeSettings 的 settings 校验，非法时抛 400、不落任何东西），
    // 校验通过后才落 key——避免「key 已换、settings 未变」的状态分裂。
    let keyToApply;
    if ('aiApiKey' in body) {
      if (typeof body.aiApiKey !== 'string') fail(400, 'aiApiKey 必须是字符串（空字符串表示清除）');
      keyToApply = body.aiApiKey.trim();
      delete body.aiApiKey; // aiApiKey 不在 SETTINGS_KEYS，writeSettings 会拒绝未知键
    }
    // 先落 key 再落 settings：反过来的话 settings 写成功、key 写失败，就会留下
    // 「模型已换、key 还是旧的」，前端显示保存成功但 AI 仍然按旧凭据跑。
    // settings 校验失败（400）时把 key 回滚成旧值，不让一次失败的请求留下半套配置。
    const prevKey = loadAiSecret();
    if (keyToApply != null) saveAiSecret(keyToApply);
    let next;
    try {
      next = writeSettings(body);
    } catch (e) {
      if (keyToApply != null) { try { saveAiSecret(prevKey); } catch {} }
      throw e;
    }
    // 运行时应用不依赖是否带了 key：只改模型/接口地址也要即时生效（否则保存成功但仍在用旧配置）。
    // key：本次带 aiApiKey 才落秘密文件；'' 表示清除（恢复 env 缺省）。
    if (keyToApply != null) saveAiSecret(keyToApply);
    setAiRuntime({
      baseUrl: next.aiBaseUrl || '',
      apiKey: keyToApply != null ? keyToApply : (loadAiSecret() || ''),
      model: next.aiModel || ''
    });
    // 返回脱敏视图，secret 不回传；与 GET /api/data 的 settings 形状一致。
    return json(res, 200, {...next, aiKeyConfigured: !!loadAiSecret(), platforms: Object.fromEntries(Object.entries(next.platforms).map(([k, v]) => [k, {appid: v.appid, configured: true, secretMasked: '••••••'}]))});
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
    // body 必须是字符串：原来只挡了 undefined，`body: null` 会走进 frontmatter.setBody 的
    // `String(newBody == null ? '' : newBody)` 把整篇正文清空并回 200（静默数据丢失），body:{} 会写成 [object Object]。
    if (body !== undefined && typeof body !== 'string') fail(400, 'body 必须是字符串');
    if (body === undefined && (!fm || !Object.keys(fm).length)) fail(400, '没有要写入的内容');
    // 手动补填作品指标走这条路由：只放行指标键与发布来源键，防止任意键写入。
    // 非对象（字符串/数组）必须在这里挡掉：它会一路进 Object.entries，把 0/1/2 这类脏键写进笔记。
    if (fm != null && (typeof fm !== 'object' || Array.isArray(fm))) fail(400, 'fm 必须是对象');
    if (fm) {
      const allowed = new Set(['views', 'likes', 'comments', 'saves', 'shares', 'follows', 'impressions', 'ctr', 'duration', 'platform', 'url', 'platformId', 'syncedAt', 'tags', 'summary']);
      for (const k of Object.keys(fm)) if (!allowed.has(k)) fail(400, `不允许写入的键：${k}`);
      // 逐键校验「值的形状」：白名单只挡住了键名——实测 tags:{a:1} 会写成 `tags: "[object Object]"`、
      // views:'abc' 会把数字指标变成字符串，前端的月目标/排序随即变 NaN。
      if ('tags' in fm) {
        if (!Array.isArray(fm.tags) || fm.tags.some(t => typeof t !== 'string')) fail(400, 'tags 必须是字符串数组');
        fm.tags = fm.tags.map(t => t.trim()).filter(Boolean);
      }
      for (const k of ['views', 'likes', 'comments', 'saves', 'shares', 'follows', 'impressions', 'ctr', 'duration']) {
        if (!(k in fm)) continue;
        if (fm[k] === null || fm[k] === '') continue; // 留空表示不写
        const n = Number(fm[k]);
        if (!Number.isFinite(n) || n < 0) fail(400, `${k} 必须是非负数字`);
        fm[k] = n;
      }
      for (const k of ['platform', 'url', 'platformId', 'syncedAt', 'summary']) {
        if (k in fm && typeof fm[k] !== 'string') fail(400, `${k} 必须是字符串`);
      }
    }
    const r = writeExisting(target({path, id}), {body, fm, mtime, requireMtime: true});
    return json(res, 200, {path: r.path, mtime: r.mtime, changed: r.changed, hash: hashOf(r.text)});
  }

  if (p === '/api/note' && req.method === 'DELETE') {
    const rel = target({path: url.searchParams.get('path'), id: url.searchParams.get('id')});
    // 个人知识库的剪藏：顺带删掉快照文件。顺序必须是「先删正文、再删快照」——
    // 反过来时 removeNote 一旦失败（权限、git 冲突），快照已经永久消失，
    // 而从 .trash 恢复回来的 .md 会指向一个不存在的网页存档。
    let snapAbs = null, snapRel = null;
    try {
      const n = loadData().notes.find(x => x.kind === 'personal' && x.rel === rel);
      if (n?.snapshot) {
        const {abs} = insideHtml(n.snapshot);
        if (existsSync(abs)) { snapAbs = abs; snapRel = n.snapshot; }
      }
    } catch {}
    const r = removeNote(rel);
    if (snapAbs) { try { rmSync(snapAbs); } catch (e) { console.error('[note-api] 删除网页快照失败（正文已删除）：', e.message); } }
    if (snapRel) gitCommitMulti([rel, snapRel], `删除 ${rel}（已备份到 .trash/）`);
    return json(res, 200, r);
  }

  if ((p === '/api/idea' || p === '/api/draft') && req.method === 'PUT') {
    const kind = p === '/api/idea' ? 'idea' : 'draft';
    const {path, id, title, body, fm, mtime, requestId} = await readBody(req);
    // 给了 id 却查不到 = 目标文件已失效（发布 / 改名 / 同步后位置 id 会整体位移），
    // 绝不能当成「新建」：原来会静默在目录里生成一个孤儿文件，前端以为更新成功，图谱多出一条重复条目。
    const known = id ? loadData().files[id] : null;
    if (id && !path && !known) fail(404, `找不到该 id 对应的${kind === 'idea' ? '选题' : '草稿'}：${id}`);
    // 有 path / id 就是改现有的；都没有就新建
    if (path || known) {
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
    const fmClean = cleanFm(kind, fm);
    // 选题 / 草稿创建时写一次稳定 id：此后增删其他文件、改名都不影响关联
    // （草稿的 id 供 /api/publish 写 sourceDraftId，否则这一跳在 UI 路径上永远为空）。
    if ((kind === 'idea' || kind === 'draft') && !fmClean.id) fmClean.id = randomUUID().slice(0, 8);
    const r = createNote(kind, {title, body, fm: fmClean, requestId});
    return json(res, r.reused ? 200 : 201, {path: r.path, mtime: r.mtime, created: true, id: fmClean.id, reused: r.reused || undefined});
  }

  // 新建方法笔记（脱离编辑器独立创作）：作品不在这里建——作品的唯一入口是草稿发布。
  if (p === '/api/note-new' && req.method === 'POST') {
    const {kind, title, body, fm, requestId} = await readBody(req);
    if (kind && kind !== 'note') fail(400, 'note-new 只支持新建方法笔记（kind: note）；作品请从草稿发布');
    if (typeof title !== 'string' || !title.trim()) fail(400, '需要一个标题');
    if (fm != null && (typeof fm !== 'object' || Array.isArray(fm))) fail(400, 'fm 必须是对象');
    const clean = {};
    if (fm) {
      for (const k of ['tags', 'summary']) if (fm[k] != null && fm[k] !== '') {
        if (k === 'tags') {
          if (!Array.isArray(fm.tags)) fail(400, 'tags 必须是数组');
          clean.tags = fm.tags.map(String).filter(Boolean);
        } else clean[k] = String(fm[k]);
      }
    }
    const r = createNote('note', {title: title.trim(), body: String(body || ''), fm: clean, requestId});
    // 幂等重放（同一 requestId）拿到的是第一次写的那个文件：不能再提交一次，
    // 也不能再报 created:true——前端会当成新建成功，库里凭空多出一个节点。
    if (r.reused) return json(res, 200, {path: r.path, mtime: r.mtime, created: false, reused: true});
    gitCommit(r.path, `新建方法笔记 ${r.path}`);
    invalidate();
    return json(res, 201, {path: r.path, mtime: r.mtime, created: true});
  }

  // 草稿发布为作品：把 03-创作台/ 下的 .md 移到 02-作品库/ 并写入指标 frontmatter。
  // 这是作品的唯一创建入口（脱离外部编辑器的独立生产链）。
  if (p === '/api/publish' && req.method === 'POST') {
    // 发布是「探名 → 建目标 → 删源」三步，中间不能被另一个发布请求插进来：
    // 两边都看到目标不存在时，rename 到已存在路径会**静默覆盖**对方刚建的文件，
    // 而那一刻 git 还没提交、.trash 也没有备份 —— 内容直接永久丢失。
    const gate = acquireJob('publish');
    try {
      const {path, id, title, metrics} = await readBody(req);
      const from = target({path, id});
      if (!from.startsWith('03-创作台/')) fail(400, '只能发布 03-创作台/ 下的草稿');
      const fromAbs = join(VAULT, from);
      if (!existsSync(fromAbs)) fail(404, `草稿不存在：${from}`);
      // title 传对象/数字时 String() 变成 [object Object]，会直接落成文件名
      if (title != null && typeof title !== 'string') fail(400, '标题必须是字符串');

      if (metrics != null && (typeof metrics !== 'object' || Array.isArray(metrics))) fail(400, 'metrics 必须是对象');
      const METRIC_KEYS = ['views', 'likes', 'comments', 'saves', 'shares', 'follows', 'impressions', 'ctr', 'duration'];
      // 草稿先读一次：既用来解析来源 id，也用来取 mtime 给写回做乐观锁
      // （原来传 mtime:null 并注释「刚读过」，实际并没读，外部编辑器同时改这篇草稿会被静默覆盖）。
      let draftFm = {};
      let draftMtime = null;
      try {
        draftMtime = mtimeOf(fromAbs);
        draftFm = parse(readFileSync(fromAbs, 'utf8')).fm || {};
      } catch (e) { console.error('[note-api] 发布前读取草稿失败：', e.message); }
      // 草稿里已经写了 date（计划发布日期）就保留：不能被「今天」覆盖用户的选择
      const draftDate = String(draftFm.date || draftFm['日期'] || '').trim();
      // 发布时间必须按本地时区算：toISOString() 在 UTC 容器里会把东八区凌晨发布记成前一天
      const fm = {date: draftDate || localYmd()};
      if (metrics) for (const k of METRIC_KEYS) {
        if (metrics[k] == null || metrics[k] === '') continue;
        const n = Number(String(metrics[k]).replace(/[,，\s]/g, ''));
        if (!Number.isFinite(n)) fail(400, `指标 ${k} 不是数字`);
        fm[k] = n;
      }

      // 目标文件名：显式 title > 草稿现有文件名；重名加序号（与 createNote 同规则）
      const baseName = safeName(title || from.slice('03-创作台/'.length).replace(/\.md$/i, ''));
      let destRel = posix.join('02-作品库', baseName + '.md');
      for (let i = 2; existsSync(join(VAULT, destRel)); i++) destRel = posix.join('02-作品库', `${baseName} ${i}.md`);
      const destAbs = join(VAULT, destRel);

    // 草稿文件发布后就没了，图谱里「选题 → 草稿 → 作品」会断在最后一跳：
    // 移动前先把草稿 sources 解析成选题的稳定 id，随作品 frontmatter 一起落盘，
    // buildGraph 才能直接接边（老的标题回连只在草稿还在库里时成立）。
    let sourceIdeaId = '', sourceDraftId = '';
    try {
      const firstOf = keys => {
        for (const k of keys) {
          const v = draftFm[k];
          if (v != null && String(v).trim()) return String(v).trim();
        }
        return '';
      };
      sourceDraftId = firstOf(['id', '编号']);
      const rawId = firstOf(['sourceIdeaId']);
      const rawSource = firstOf(['source', '来源选题', '选题']);
      const ideas = loadData().ideas || [];
      const idea = (rawId && ideas.find(i => String(i.id) === rawId))
        || (rawSource && (ideas.find(i => String(i.id) === rawSource) || ideas.find(i => i.title === rawSource)));
      if (idea) sourceIdeaId = String(idea.id);
    } catch (e) { console.error('[note-api] 发布前解析草稿来源失败：', e.message); }
    if (sourceIdeaId) fm.sourceIdeaId = sourceIdeaId;
    if (sourceDraftId) fm.sourceDraftId = sourceDraftId;

    // 先写 frontmatter，再移动文件：反过来的话，写盘失败（磁盘满、只读挂载、权限）时
    // 草稿已经没了、作品又没指标，而那条 rename 的 git 提交已经把「草稿被删」记进历史。
    // 只有真的写进去了才报 metricsWritten：date 无论如何都要写（缺了会退化成文件 mtime，
    // 之后任何一次编辑都会把发布时间改成那天，月目标、时间区间、排序全跟着错）。
    // 来源字段（sourceIdeaId / sourceDraftId）不是指标，不能把「没填指标」算成已写入。
    const hasMetrics = METRIC_KEYS.some(k => k in fm);
    let metricsWritten = false;
    try {
      writeExisting(from, {fm, mtime: draftMtime});
      metricsWritten = hasMetrics;
    } catch (e) {
      // 409 = 草稿在读取之后又被别处改过：绝不能继续「复制 + 删源」，否则冲突被吞掉、
      // 草稿已消失无法重发，作品永久缺 date / sourceIdeaId，而前端还看到「发布成功」。
      if (e && e.code === 409) throw e;
      console.error('[note-api] 发布写 frontmatter 失败：', e.message);
      // 其他写盘失败（磁盘满 / 只读挂载）同样不能往下走：草稿还在，重试即可
      fail(507, '草稿写回失败，未发布（磁盘满或只读）');
    }

    // 移动：目标目录先建好。用「独占创建 + 再删源」而不是 rename ——
    // rename 到已存在路径在 POSIX/Windows 上都是静默覆盖，会吃掉同名作品的整份内容。
    mkdirSync(dirname(destAbs), {recursive: true});
    let placedRel = '';
    for (let i = 0; i < 1000 && !placedRel; i++) {
      const tryRel = i === 0 ? destRel : posix.join('02-作品库', `${baseName} ${i + 1}.md`);
      try {
        copyFileSync(fromAbs, join(VAULT, tryRel), fsConstants.COPYFILE_EXCL);
        placedRel = tryRel;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    if (!placedRel) fail(409, `同名作品过多：${baseName}`);
    rmSync(fromAbs, {force: true});
    const movedRel = placedRel;
    gitCommitMulti([from, movedRel], `发布为作品 ${from} → ${movedRel}`);
    invalidate();
    return json(res, 201, {path: movedRel, from, metricsWritten, sourceIdeaId: sourceIdeaId || undefined});
    } finally { releaseJob(gate); }
  }

  // —— 附件（99-附件/）：图片 / 视频上传与读取，供编辑器插图与预览 ——
  const ATTACH_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.mp4', '.mov', '.mp3', '.pdf']);
  const ATTACH_MIME = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf'};
  function insideAttachment(rel) {
    const raw = String(rel || '').replace(/\\/g, '/').trim();
    if (!raw || raw.includes('\0')) fail(400, '缺少路径');
    const ext = extname(raw).toLowerCase();
    if (!ATTACH_EXT.has(ext)) fail(400, `不支持的附件类型：${ext || '（无扩展名）'}`);
    const p = resolve(VAULT, raw);
    const expected = join(VAULT, ATTACHMENTS_DIR + sep);
    if (!p.startsWith(expected)) fail(400, '附件必须位于 ' + ATTACHMENTS_DIR + '/ 下');
    if (!insideRealVault(p)) fail(400, '路径越界');
    return {abs: p, rel: p.slice(VAULT.length + 1).split(sep).join('/')};
  }

  if (p === '/api/attachment' && req.method === 'POST') {
    const filename = (() => { try { return decodeURIComponent(req.headers['x-filename'] || ''); } catch { return ''; } })();
    if (!filename) fail(400, '缺少 x-filename 头');
    const buf = await readRaw(req);
    if (!buf.length) fail(400, '文件是空的');
    // 统一重命名：安全名 + 时间戳，避免覆盖与路径注入；扩展名按原文件
    const dot = filename.lastIndexOf('.');
    const stem = safeName(dot > 0 ? filename.slice(0, dot) : filename).slice(0, 50).replace(/\s+/g, '-') || 'attachment';
    const ext = extname(filename).toLowerCase();
    // 时间戳只到毫秒：多选两张同名图片（或双击提交同一文件）落在同一毫秒时，原来的
    // writeFileSync 直接截断前一张，两个笔记的 ![[...]] 指向同一路径，前一张永久丢失，
    // 而两次请求都回 201。加随机后缀，与快照命名保持一致。
    const rel = posix.join(ATTACHMENTS_DIR, `${stem}-${Date.now()}-${randomBytes(3).toString('hex')}${ext}`);
    insideAttachment(rel); // 白名单兜底校验（正常必过）
    mkdirSync(join(VAULT, ATTACHMENTS_DIR), {recursive: true});
    // 原子落盘：半截 jpeg/mp4 会被正文的 ![[...]] 永久引用，而名字带时间戳+随机后缀无法重传同路径
    writeAtomicSync(join(VAULT, rel), buf);
    gitCommit(rel, `上传附件 ${rel}`);
    invalidate();
    // name 必须就是真正落盘的文件名：前端拿它拼 ![[...]]。再调一次 Date.now() 会跨毫秒对不上。
    return json(res, 201, {path: rel, name: posix.basename(rel)});
  }

  if (p === '/api/attachment' && req.method === 'GET') {
    const {abs, rel} = insideAttachment(url.searchParams.get('path'));
    let st;
    try { st = statSync(abs); } catch { return json(res, 404, {error: '附件不存在', path: rel}); }
    // 原来 readFileSync 把整片读进堆：99-附件/ 里被 Syncthing 拷进来的大视频，几个并发就
    // 能把进程打满；而且没有 Range 时视频不能拖动、iOS Safari 直接不播。改成流式 + 206。
    const head = {
      'content-type': ATTACH_MIME[extname(rel).toLowerCase()] || 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline';",
      'cache-control': 'private, max-age=3600',
      'accept-ranges': 'bytes'
    };
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (m && (m[1] || m[2])) {
      let start = m[1] === '' ? null : Number(m[1]);
      let end = m[2] === '' ? null : Number(m[2]);
      if (start == null) { start = Math.max(0, st.size - (end || 0)); end = st.size - 1; }
      else if (end == null || end >= st.size) end = st.size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= st.size) {
        res.writeHead(416, {'content-range': `bytes */${st.size}`});
        return res.end();
      }
      res.writeHead(206, {...head, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${st.size}`});
      return pipeAttachment(abs, start, end, res, rel);
    }
    res.writeHead(200, {...head, 'content-length': st.size});
    return pipeAttachment(abs, null, null, res, rel);
  }

  // limit 同样要 clamp：limit=abc → NaN 会让 node:sqlite 抛 datatype mismatch
  if (p === '/api/search' && req.method === 'GET') {
    const rawLimit = Number(url.searchParams.get('limit') || 20);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 20;
    const q = url.searchParams.get('q') || '';
    // 外部编辑器改完立刻搜索：索引只有 /api/data 会同步，这里补一次（hash 短路，无变化时零写入）
    try { reindex(); } catch (e) { console.error('[note-api] 搜索前同步索引失败：', e.message); }
    return json(res, 200, {q, hits: searchAll(q, limit)});
  }

  if (p === '/api/index' && req.method === 'POST') return json(res, 200, {changed: reindex(), indexed: index.count()});

  // —— AI：未配 key 时全部 501，前端据此隐藏 AI 区块 ——
  if (p === '/api/ai/info' && req.method === 'GET') return json(res, 200, {...aiInfo(), maxUpload: MAX_BODY});

  if (p === '/api/ai/models' && req.method === 'GET') return json(res, 200, {models: await listModels(), taskModels: taskModelsSnapshot()});

  // 请求里带的 model 覆盖：白名单校验（只允许网关 /v1/models 里的 id），缺省用任务配置
  async function pickModel(requested, task) {
    if (!requested) return taskModel(task);
    if (!aiEnabled()) return requested;
    if (!await validModel(requested)) fail(400, `未知模型：${requested}（GET /api/ai/models 查看可用列表）`);
    return requested;
  }

  // paths 必须是字符串数组：传字符串时 `paths.includes(rel)` 会做**子串**判断
  // （{paths:'03-创作台'} 会命中该目录下全部草稿），传数字则整个 filter 语义失效。
  function relPaths(raw) {
    if (raw == null) return null;
    if (!Array.isArray(raw) || raw.some(x => typeof x !== 'string')) fail(400, 'paths 必须是字符串数组');
    if (raw.length > 500) fail(400, '一次最多 500 个路径');
    return raw;
  }

  // 任务轮询必须留在闸外：AI 在任务运行期间被关掉时，前端还得能拿到终态，否则永远空转。
  if (p.startsWith('/api/ai/') && !p.startsWith('/api/ai/jobs/') && !aiEnabled() && p !== '/api/ai/info' && p !== '/api/ai/models') return json(res, 501, {error: 'AI 未启用：服务端未配置 AI_API_KEY'});

  // ① 打标签 + 摘要。body: {paths?: [...], dryRun?: bool}
  // 不传 paths 就处理全部方法笔记；按内容 hash 增量，没变过的跳过。
  if (p === '/api/ai/analyze' && req.method === 'POST') {
    const {paths: rawPaths, dryRun, model} = await readBody(req);
    const paths = relPaths(rawPaths);
    const useModel = await pickModel(model, 'analyze');
    const d = loadData(0);
    // 参与分析的内容：方法笔记 / AI 热点日报 / 个人知识库（都在 d.notes 里）＋ 作品（d.works）。
    // id 前缀必须跟图谱一致（note: / personal: / post:）：前端拿 node.id 精确匹配结果，
    // 个人知识库条目在索引里是 personal:pN，用 'note:' + id 永远对不上。
    const targets = [
      ...d.notes.map(n => ({id: noteNodeId(n), rel: n.rel, title: n.title, body: n.body})),
      ...d.works.map(w => ({id: 'post:' + w.post.id, rel: w.rel, title: w.post.title, body: w.content?.body || ''}))
    ].filter(x => !paths?.length || paths.includes(x.rel));
    const cached = index.aiCache();
    const need = targets.filter(x => cached.get(x.id)?.hash !== hashOf(x.body));
    if (dryRun) return json(res, 200, {total: targets.length, todo: need.length, skip: targets.length - need.length, dryRun: true, model: useModel});
    if (!targets.length) return json(res, 200, {total: 0, done: 0, message: '没有匹配到可分析的内容（方法笔记 / AI 热点 / 个人知识库 / 作品）'});
    if (!need.length) return json(res, 200, {total: targets.length, done: 0, message: '全部内容都分析过了'});
    const job = runJob('analyze', need.length, async progress => {
      const results = [];
      for (const n of need) {
        const r = await analyzeNote(n.title, n.body, {model: useModel});
        // 写回内容文件（笔记或作品）的 frontmatter：tags = 已有 ∪ AI 生成（去重，AI 的排后面），
        // summary = AI 生成。写前读原文拿 mtime 做乐观锁；冲突时跳过并在结果里标注。
        let writeErr = null;
        try {
          const cur = readFileSync(join(VAULT, n.rel), 'utf8');
          const curFm = parseFrontmatter(cur);
          // 顺序有讲究：老代码是「已有 ∪ AI 再截断 12 个」，标签多的笔记（≥12 个已有）
          // 会把 AI 结果整批截掉，接口回 written:true 但文件一个字没变。改成先给 AI 留位置。
          const cap = 20;
          const existing = [...new Set(curFm.tags || [])];
          const ai = [...new Set(r.tags)].filter(t => !existing.includes(t));
          const merged = [...existing.slice(0, Math.max(0, cap - ai.length)), ...ai].slice(0, cap);
          // summary 空串在 frontmatter.render() 里表示「删除这个键」：模型没给摘要时不能把
          // 用户已有的 summary 抹掉（写回成功还会把这一篇标记成「已分析」，从此不再重跑）。
          const fmPatch = {tags: merged};
          if (r.summary) fmPatch.summary = r.summary;
          writeExisting(n.rel, {fm: fmPatch, mtime: mtimeOf(join(VAULT, n.rel))});
        } catch (e) { writeErr = e.message; }
        // 缓存必须在写回成功之后才记：先记后写时，一旦写回 409 / ENOENT，下一轮 dryRun 就
        // 算成「已分析」，面板说「写回失败·可重试」，但重试永远返回「这篇已经分析过了」。
        if (!writeErr) index.putAi(n.id, hashOf(n.body), r.tags, r.summary);
        results.push({id: n.id, path: n.rel, title: n.title, ...r, written: !writeErr, error: writeErr});
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
    const {threshold: rawThreshold = 0.82} = await readBody(req);
    // 阈值必须校验：传 "abc" / null / 字符串数字时 `sim >= threshold` 恒为 false（全 NaN 比较），
    // 任务照常跑完却一条边都不产出，前端只能看到「完成」，看不出是参数被吞了。
    const threshold = Number(rawThreshold);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) fail(400, 'threshold 必须是 0–1 之间的数字');
    const d = loadData(0);
    // 语义边覆盖全部内容（obsidian-independence P1）：方法笔记 / 日报 / 个人知识库 /
    // 作品 / 选题 / 草稿，id 前缀与前端图谱一致——跨星团的「灵感↔作品」「制度↔通报」都能连上。
    const items = [
      ...d.notes.map(n => ({id: noteNodeId(n), title: n.title, text: n.title + '\n' + n.body, kind: n.kind})),
      ...d.works.map(w => ({id: 'post:' + w.post.id, title: w.post.title, text: w.post.title + '\n' + (w.content?.body || ''), kind: 'post'})),
      ...d.ideas.map(i => ({id: 'idea:' + i.id, title: i.title, text: (i.title || '') + '\n' + (i.note || ''), kind: 'idea'})),
      ...d.drafts.map(x => ({id: 'draft:' + x.id, title: x.title, text: (x.title || '') + '\n' + (x.body || ''), kind: 'draft'}))
    ];
    const job = runJob('relate', items.length, async progress => {
      const model = process.env.EMBED_MODEL;
      const have = new Map(index.embeddings(model).map(e => [e.id, e]));
      // 每篇一次 HTTP 太浪费：embed() 本来就支持一批 16 条，几百篇的库串行发几百个请求
      // 要跑几分钟，还极易撞网关限流。
      let batch = [];
      const flush = async () => {
        if (!batch.length) return;
        const vecs = await embed(batch.map(b => b.text));
        batch.forEach((b, i) => { if (vecs[i]) index.putEmbedding(b.id, model, vecs[i], b.hash); progress(); });
        batch = [];
      };
      for (const n of items) {
        const id = n.id, h = hashOf(n.text);
        if (have.get(id)?.hash !== h) batch.push({id, hash: h, text: n.text.slice(0, 2000)});
        if (batch.length >= 16) await flush();
        if (have.get(id)?.hash === h) progress();
      }
      await flush();
      const vecs = index.embeddings(model);
      const edges = [];
      for (let i = 0; i < vecs.length; i++) {
        for (let j = i + 1; j < vecs.length; j++) {
          const sim = cosine(vecs[i].vec, vecs[j].vec);
          if (sim >= threshold) edges.push({a: vecs[i].id, b: vecs[j].id, sim: Math.round(sim * 1000) / 1000});
        }
        // 两两余弦是纯 CPU 的同步循环：几百篇 = 几十万次点积全压在同一个 tick 里，
        // 期间所有 HTTP（含 /api/version 轮询与登录）都排队，前端看起来像卡死。
        if (i % 100 === 99) await new Promise(r => setImmediate(r));
      }
      edges.sort((x, y) => y.sim - x.sim);
      return {edges: edges.slice(0, 400), threshold};
    }, {cache: true});
    return json(res, 202, {job});
  }

  // ③ 从笔记生成选题候选。body: {paths: [...]}（必填，用户在前端勾选笔记）
  if (p === '/api/ai/ideas' && req.method === 'POST') {
    const {paths: rawIdeaPaths, model} = await readBody(req);
    const paths = relPaths(rawIdeaPaths);
    const useModel = await pickModel(model, 'ideas');
    if (!paths?.length) fail(400, '请先选择要用哪些笔记（paths）');
    const d = loadData(0);
    const notes = d.notes.filter(n => paths.includes(n.rel));
    if (!notes.length) fail(404, '选中的笔记不存在：/api/ai/ideas 只接受方法笔记 / AI 热点 / 个人知识库（作品请用「打标签 + 摘要」）');
    const candidates = await generateIdeas(notes, {model: useModel});
    return json(res, 200, {candidates, model: useModel});
  }

  // ④ 问答（RAG）：embedding + FTS 混合检索 → 拼上下文 → 回答（非流式，个人规模足够）。
  // body: {question}
  if (p === '/api/ai/ask' && req.method === 'POST') {
    const {question, model: reqModel} = await readBody(req);
    if (!question?.trim()) fail(400, '问题不能为空');
    // 检索的代价随问题长度线性放大：切出的每个短语一次 FTS 查询，2 字词还必然走两条
    // %…% 全表扫（正文每行 6000 字）。请求体上限是 4MB，粘贴几 KB 中文就能让单线程
    // 事件循环被十万级全表扫占死，整个服务（含登录、静态资源）在这段时间无响应。
    const askQ = String(question).slice(0, 300);
    const useModel = await pickModel(reqModel, 'ask');
    const d = loadData(0);
    const hits = new Map();
    // 关键词召回：整句往往不是任何笔记的子串（FTS trigram 是子串匹配），
    // 按标点和常见停用词切成短语，取较长的片段逐个查，命中多的排前面。
    const phrases = [...new Set(String(askQ)
      .split(/[？?！!。，,、；;：:\s（）()\[\]{}"'「」…·—\-]+/)
      .flatMap(seg => seg.length > 10 ? [seg.slice(0, 5), seg.slice(5, 10), seg.slice(10)].filter(Boolean) : [seg])
      .filter(seg => [...seg].length >= 2))].slice(0, 12);
    const scored = new Map();
    for (const ph of phrases.length ? phrases : [askQ]) {
      for (const h of index.search(ph, 8)) scored.set(h.id, (scored.get(h.id) || 0) + [...ph].length);
    }
    // 整句都是口语虚词时（「我的作品里哪篇讲收件箱？」切出「我的作品里 / 哪篇讲收件 / 箱」），
    // 片段一个都命中不了，于是库里明明有也回「没有找到」。用 2 字滑窗再兜一次：
    // trigram 要 ≥3 字，2 字正好走 LIKE 子串匹配，命中条数越多排越前。
    // 只在问题本身不长时启用并限 30 个窗口，避免长句把全表扫放大成百上千次。
    if (!scored.size) {
      const clean = askQ.replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, '');
      if (clean.length <= 60) {
        const seen = new Set();
        let windows = 0;
        for (let i = 0; i + 2 <= clean.length && windows < 30; i++) {
          const w = clean.slice(i, i + 2);
          if (seen.has(w)) continue;
          seen.add(w);
          windows++;
          for (const h of index.search(w, 6)) scored.set(h.id, (scored.get(h.id) || 0) + 1);
        }
      }
    }
    // 全库兜底：索引只覆盖 /api/data 的展示窗口（作品 30 / 方法笔记 40 / 日报 60 / 个人库 120 /
    // 选题草稿 300），窗口外的笔记不在 FTS 里。上面两轮都零命中时像 searchAll 一样读一次全量，
    // 否则第 31 篇及更早的作品一问就「笔记库里没有找到相关内容」。
    const fallback = new Map();
    if (!scored.size) {
      try {
        const full = readVault({vault: VAULT, full: true});
        const pool = [
          ...full.works.map(w => ({id: 'post:' + w.post.id, title: w.post.title, body: w.content?.body || ''})),
          ...full.notes.map(n => ({id: noteNodeId(n), title: n.title, body: n.body})),
          ...full.ideas.map(i => ({id: 'idea:' + i.id, title: i.title, body: i.note || ''})),
          ...full.drafts.map(x => ({id: 'draft:' + x.id, title: x.title, body: x.body || ''}))
        ];
        const needles = (phrases.length ? phrases : [askQ]).map(s => String(s).toLowerCase()).filter(Boolean);
        for (const x of pool) {
          const hay = (x.title + '\n' + x.body).toLowerCase();
          const n = needles.reduce((acc, ph) => acc + (hay.includes(ph) ? 1 : 0), 0);
          if (n) { scored.set(x.id, n); fallback.set(x.id, x); }
        }
      } catch (e) { console.error('[note-api] 问答全量召回失败：', e.message); }
    }
    for (const [id, w] of [...scored].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      const fb = fallback.get(id);
      hits.set(id, {id, title: index.note(id)?.title || fb?.title || '', body: index.note(id)?.body || fb?.body || '', kw: true});
    }
    // 向量召回（可用时）
    if (embedEnabled()) {
      try {
        const model = process.env.EMBED_MODEL;
        const [qv] = await embed([askQ]);
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
    const text = await answer(askQ, contexts, {model: useModel});
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
    // tags 原来被静默丢掉：剪藏时传的标签 201 成功却没进 frontmatter，知识库卡片的 chip 区
    // 永远空、FTS 与 embedding 也少一组关键词（AGENTS.md 里 notes.tags 是有契约的）。
    if (fm.tags != null) {
      if (!Array.isArray(fm.tags) || fm.tags.some(t => typeof t !== 'string')) fail(400, 'tags 必须是字符串数组');
      const list = fm.tags.map(t => t.trim()).filter(Boolean).slice(0, 12);
      if (list.length) out.tags = list;
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
    let finalTitle = (page && htmlTitle(page.html)) || String(title || '').trim() || null;
    const text = page ? htmlToText(page.html) : String(note || '');

    // 标题三级来源：og/title 标签 → AI 从正文提炼 →（仍无则报错）。
    // 提炼这次调用本身就是一次完整分析，成功时直接复用：原来 probe 成功后还会为同一份
    // 8000 字正文再调一次 analyzeWebPage，token 与延迟白翻一倍。
    // analyze:false 的请求只借 AI 提炼标题，不把 summary/keyPoints 写回——尊重「不分析」语义。
    let analysis = null, analysisError = null;
    if (page && !finalTitle && aiEnabled()) {
      try {
        analysis = await analyzeWebPage({url: page.url, title: null, text});
        if (analysis.title) finalTitle = analysis.title;
      } catch (e) { analysisError = e.message; }
    }
    if (!finalTitle) {
      // 提炼失败时必须把 AI 的失败原因说出来：原来 analysisError 在这条路径上是死变量，
      // 用户只看到「网页没有标题」，永远不知道是模型请求挂了。
      fail(400, analysisError
        ? `网页没有标题，AI 提炼也失败了：${analysisError}`
        : '网页没有标题（AI 未启用或未能从正文提炼），请补一个 title');
    }

    // 真正的分析（写 summary/keyPoints）：未启用/失败都不丢剪藏，只带 analysisError。
    // analyze 只认布尔 false 与字符串 'false'：原来 `analyze !== false` 让 'false' 也触发分析。
    const wantAnalyze = page && !(analyze === false || analyze === 'false') && aiEnabled();
    if (wantAnalyze && !analysis) {
      try { analysis = await analyzeWebPage({url: page.url, title: finalTitle, text}); }
      catch (e) { analysisError = e.message; }
    }

    // 快照：抓取成功就存一份 HTML 原文（.snapshots/ 点目录，不会进图谱）
    let snapshotRel = null;
    if (page) {
      const slug = safeName(finalTitle).slice(0, 50).replace(/\s+/g, '-').toLowerCase() || 'page';
      // 加随机后缀：同一篇网页在同一毫秒剪两次会撞同一个文件名，后一次静默覆盖前一次的快照
      snapshotRel = posix.join(SNAPSHOTS_DIR, `${slug}-${Date.now()}-${randomBytes(3).toString('hex')}.html`);
      mkdirSync(join(VAULT, SNAPSHOTS_DIR), {recursive: true});
      // 快照是「我读过原文」的唯一凭据：写一半崩溃会留下截断的 HTML，所以走原子落盘
      writeAtomicSync(join(VAULT, snapshotRel), page.html, 'utf8');
    }

    const fm = cleanPersonalFm({
      category: cat,
      ...(page ? {url: page.url, domain: new URL(page.url).hostname, clipped: new Date().toISOString().slice(0, 10)} : {}),
      ...(analysis?.summary ? {summary: analysis.summary} : {}),
      ...(analysis?.keyPoints?.length ? {keyPoints: analysis.keyPoints} : {}),
      ...(snapshotRel ? {snapshot: snapshotRel} : {}),
      ...(Array.isArray(tags) ? {tags: tags.map(String).filter(Boolean)} : {})
    });
    const body = page
      ? `> [!info] 网页剪藏\n> 来源：${page.url}${analysis ? `\n\n${analysis.summary}\n${(analysis.keyPoints || []).map(k => '- ' + k).join('\n')}` : ''}\n\n---\n\n${text}`
      : String(note || '');
    let r;
    try {
      r = createNote('personal', {title: finalTitle, body, fm});
    } catch (e) {
      // 笔记没写成（同名冲突 409 / 磁盘错）时快照已经落盘：不清理的话 .snapshots/ 会越堆越多
      // 第三方 HTML 孤儿文件，还会被 Syncthing / git 同步出去，界面上完全看不到、也没法清。
      if (snapshotRel) { try { rmSync(join(VAULT, snapshotRel), {force: true}); } catch {} }
      throw e;
    }
    const commitPaths = snapshotRel ? [r.path, snapshotRel] : [r.path];
    gitCommitMulti(commitPaths, `剪藏 ${r.path}`);
    invalidate();
    return json(res, 201, {path: r.path, mtime: r.mtime, created: true, snapshot: snapshotRel, analysis, analysisError});
  }

  // 重新分析已有剪藏：读快照（或重新抓取）→ AI → 写回 frontmatter（乐观锁）
  if (p === '/api/knowledge/analyze' && req.method === 'POST') {
    const {path, id} = await readBody(req);
    // 传了 id 却查不到条目时，target() 会退回「缺少 path」，把「这条不存在」说成「参数没给」。
    if (id && !path && !loadData(0).files[id]) fail(404, `个人知识库里没有这条笔记：${id}`);
    const rel = target({path, id});
    const n = personalByPath(rel);
    // 位置 id（personal:pN 按 rel 排序编号）会随增删位移：分析栏打开到点「重新分析网页」
    // 之间若别处增删了一条，files['personal:pN'] 已经指向另一篇，AI 的 summary/tags 会
    // 静默写进别人家。这里用 rel 反查到的真实 id 复核一次，不一致就要求刷新。
    if (id && noteNodeId(n) !== String(id)) fail(409, `条目已变动（${id} 现在指向另一篇），请刷新后重试`, {path: rel});
    if (!aiEnabled()) return json(res, 501, {error: 'AI 未启用：服务端未配置 AI_API_KEY'});
    let page;
    try { page = await clipTextOf(n); }
    catch (e) { fail(e instanceof FetchError ? 400 : 502, e.message); }
    let analysis;
    try { analysis = await analyzeWebPage({url: n.url, title: n.title, text: page.text}); }
    catch (e) {
      // 原来这条没包 try：AI 抛错直接走到全局兜底，回「服务器内部错误」，
      // 而 /api/knowledge 同条件下会降级保留剪藏并回 analysisError，前端两种口径。
      fail(502, `AI 分析失败：${e.message}`);
    }
    const cur = readFileSync(join(VAULT, rel), 'utf8');
    // mtime 必须取自「读这份正文的同一次 stat」：原来在写之前现取，比较恒等，
    // 读与写之间被 Obsidian / Syncthing 改动时 AI 会静默盖掉别人的修改。
    const curMtime = mtimeOf(join(VAULT, rel));
    const oldTags = parseFrontmatter(cur);
    writeExisting(rel, {
      // summary 只在非空时才写：空串在 render() 里表示删键，会把剪藏原有的摘要抹掉
      fm: {...(analysis.summary ? {summary: analysis.summary} : {}), ...(analysis.keyPoints.length ? {keyPoints: analysis.keyPoints} : {}),
        tags: [...new Set([...(oldTags.tags || []), ...analysis.tags])].slice(0, 12)},
      mtime: curMtime
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
      // default-src 'none' 并不覆盖 form-action / base-uri，也不禁止被 iframe 内嵌：
      // 剪藏页面里的 <form action="https://evil"> + autofocus 能做同源钓鱼跳转，
      // <meta http-equiv=refresh> 能直接跳走，<img src="https://tracker"> 会把
      // 「主人确实看过这篇」回执 + Referer（内网地址端口）发给第三方。
      // sandbox 不给 allow-scripts，脚本、表单、meta 刷新一起废掉。
      'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
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
    // docx / PDF 解析是同步跑在事件循环里的：不加闸时并行传几个畸形 PDF 就能把
    // /api/data、登录、静态资源一起卡到分钟级。与 AI / 日报共用同一把闸。
    const gate = acquireJob('upload');
    try {
      let parsed;
      try { parsed = await parseUpload(filename, buf); }
      catch (e) {
        if (e instanceof ParseError) fail(400, e.message);
        // 非解析类异常（缺 pdfjs-dist、内部 TypeError 等）只写日志：e.message 里有容器
        // 绝对路径与依赖是否存在的信息，直接回浏览器等于免费侦察。
        console.error('[note-api] 文档解析内部错误：', e);
        fail(500, '文档解析失败（服务端内部错误）');
      }
      const r = createNote('personal', {
        title: parsed.title,
        body: parsed.text,
        fm: cleanPersonalFm({category: ['灵感', '制度', '推文'].includes(category) ? category : '制度', sourceFile: filename, uploaded: new Date().toISOString().slice(0, 10)})
      });
      gitCommit(r.path, `上传 ${r.path}`);
      invalidate();
      return json(res, 201, {path: r.path, chars: parsed.text.length});
    } finally {
      releaseJob(gate);
    }
  }

  // —— AI 热点（第六星座的数据）——
  if (p === '/api/news' && req.method === 'GET') {
    // limit 必须校验：NaN 绑进 LIMIT ? 会让 node:sqlite 抛 datatype mismatch（500）
    const raw = Number(url.searchParams.get('limit') || 14);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 90) : 14;
    return json(res, 200, {days: listNews(index, limit)});
  }
  // 日报生成与选题筛选都是几十秒级 AI 调用：必须和 /api/ai/* 共用同一把「同时只跑一个」的闸，
  // 否则 cron 与手动请求会各自调一次模型、各写一份选题。
  if (p === '/api/news/refresh' && req.method === 'POST') {
    const gate = acquireJob('news-refresh');
    try {
      const {force, model: reqModel} = await readBodyOrEmpty(req);
      // force 只认 true：原来写的是 `force ? ... : ...`，字符串 "false" 也是 truthy，
      // 会静默走强制重生成、覆盖用户手改过的当天日报。模型也必须在闸内解析（pickModel 会打网关）。
      const useModel = reqModel === undefined ? undefined : await pickModel(reqModel, 'news');
      const fn = force === true ? forceRefresh : refreshNews;
      const r = await fn(index, VAULT, useModel ? {model: useModel} : {});
      // 日报 .md 刚落地：不失效缓存的话，1.5s 快照窗口内的 /api/data 还是旧数据，
      // /api/search 与 ask 也看不到当天日报，直到下一次轮询。
      if (r) { invalidate(); try { reindex(); } catch (e) { console.error('[note-api] 日报后同步索引失败：', e.message); } }
      return json(res, 200, r || {message: '今天的热点日报已生成过'});
    } catch (e) {
      // news 模块抛的是带 status 的错误（501 未配 AI / 502 RSS 上游失败 / 409 状态不符）。
      // 一律塌成 500「服务器内部错误」会让用户分不清是配置错了还是服务坏了。
      if (e && Number.isInteger(e.status)) return json(res, e.status, {error: e.message});
      throw e;
    } finally { releaseJob(gate); }
  }

  // 从今天的热点里筛选题：auto=true 直接落盘进 04-选题池（射手座），否则只返回候选给前端预览
  if (p === '/api/news/ideas' && req.method === 'POST') {
    const gate = acquireJob('news-ideas');
    try {
      const {model: reqModel, auto} = await readBodyOrEmpty(req);
      // pickModel 会打网关 /v1/models（几百毫秒）：闸必须在它之前就占好
      const useModel = await pickModel(reqModel, 'news');
      const r = await ideasFromNews(index, VAULT, {model: useModel, auto: auto === true, io: {createNote}});
      reindex();
      return json(res, 200, r);
    } catch (e) {
      if (e && Number.isInteger(e.status)) return json(res, e.status, {error: e.message});
      throw e;
    } finally { releaseJob(gate); }
  }

  // 平台指标同步：逐篇尝试拉取（未配凭据/平台不支持时逐篇返回 pullable:false，不报错）。
  // body: {path?} —— 传 path 只拉这一篇；不传则遍历所有有 platform + url 的作品。
  if (p === '/api/platforms/pull' && req.method === 'POST') {
    // 同步会逐篇写回同一批作品：与 cron、另一个标签页并发时，后到的一方拿着旧 mtime 命中 409，
    // 或者两边都成功留下两条互相覆盖的提交。所以复用同一把闸。
    const gate = acquireJob('platforms-pull');
    try {
      const {path} = await readBodyOrEmpty(req);
      // 不能用 loadData()：它的展示窗口只保留最新 30 篇（readVault 的 maxWorks），
      // 第 31 篇及更早的作品永远不会被同步，而日志里的篇数也被同一个上限骗过去。
      const d = readVault({vault: VAULT, full: true});
      let works = d.works.filter(w => w.post.platform && w.post.url);
      if (path) {
        works = works.filter(w => w.rel === path);
        // 过滤为空不能说「没有可同步的作品」：那是「路径写错 / 作品不在库里」，必须 404
        if (!works.length) fail(404, `没有找到这篇作品（或它没有 platform / url）：${path}`);
      }
      // pullAll 内部逐篇 try：单篇失败（文件被外部删掉、写回 409）不会中断整批；
      // 凭据 / token 类失败是整批共有的，会带 aborted 提前收手。
      const {results, aborted, error} = await pullAll({works}, VAULT, {writeExisting, mtimeOf});
      if (results.some(r => r.updated)) reindex();
      if (aborted) return json(res, 502, {results, info: platformInfo(), aborted: true, error: `同步已中止：${error}`});
      return json(res, 200, {results, info: platformInfo()});
    } finally { releaseJob(gate); }
  }

  if (p.startsWith('/api/ai/jobs/') && req.method === 'GET') {
    const job = index.job(p.slice('/api/ai/jobs/'.length));
    if (!job) return json(res, 404, {error: '没有这个任务'});
    return json(res, 200, job);
  }

  // 已知路径但方法不对：回 405（带 Allow），别让调用方把「方法用错」读成「接口不存在」。
  // 原来所有未匹配的请求都是 404，前端一改方法就只能看到「没有这个接口」，排查方向全错。
  const KNOWN_API = new Set(['/api/data', '/api/version', '/api/health', '/api/session', '/api/login', '/api/logout',
    '/api/auth-check', '/api/settings', '/api/note', '/api/note-new', '/api/idea', '/api/draft', '/api/publish',
    '/api/attachment', '/api/knowledge', '/api/knowledge/analyze', '/api/knowledge/upload', '/api/knowledge/snapshot',
    '/api/index', '/api/search', '/api/news', '/api/news/refresh', '/api/news/ideas', '/api/platforms/pull',
    '/api/ai/info', '/api/ai/models', '/api/ai/analyze', '/api/ai/relate', '/api/ai/ideas', '/api/ai/ask']);
  if (KNOWN_API.has(p)) {
    res.setHeader('allow', 'GET, POST, PUT, DELETE');
    return json(res, 405, {error: `不支持的请求方法：${req.method}`, path: p});
  }

  return json(res, 404, {error: '没有这个接口', path: p});
}

// 后台任务：AI 调用秒级到几十秒级，不能阻塞 HTTP。同一时刻只跑一个 AI 任务。
// 闸必须在任何 await 之前**同步**占位：原来的 `if (runningJob) fail()` 与赋值之间夹着
// readBody / pickModel 的 await，两个并发请求都能穿过检查 → 各自调一次模型、各写一份日报与选题，
// 而且后完成者把闸置空，第三个请求又能进来。用 token 释放，避免 A 释放掉 B 的占位。
let runningJob = null;
// 闸现在同时管 AI 任务、日报、平台同步和发布：一律回「已有 AI 任务在运行」会让用户在
// 平台同步期间点 AI 分析时以为是 AI 出了错。按占用者给出具体名称。
const JOB_LABEL = {
  analyze: 'AI 打标签 + 摘要', relate: 'AI 语义关联', ideas: 'AI 生成选题', ask: 'AI 问答',
  'news-refresh': '热点日报生成', 'news-ideas': '热点筛选题', 'news-cron': '定时日报',
  'platforms-pull': '平台指标同步', 'platforms-cron': '定时平台同步', publish: '发布作品', upload: '文档解析入库'
};
const JOB_BUSY = kind => `已有任务在运行（${JOB_LABEL[kind] || kind || '其他任务'}），等它结束后再试`;
function acquireJob(kind) {
  if (runningJob) fail(409, JOB_BUSY(runningJob.kind));
  const token = {kind: kind || 'job'};
  runningJob = token;
  return token;
}
function releaseJob(token) {
  if (token && runningJob === token) runningJob = null;
}
function runJob(kind, total, fn, opts = {}) {
  // 并发跑两个 relate 会各自做全量 embedding 与两两余弦，先启动后完成的还会覆盖较新的语义边
  const gate = acquireJob(kind);
  const id = randomUUID().slice(0, 8);
  // 占位与建行之间必须兜住：createJob 抛错（SQLite busy / 磁盘满 / 短 id 撞主键）时
  // 原来闸就永久留在手里，此后所有 AI / 日报 / 平台同步接口都是 409，只能重启进程。
  try {
    index.createJob(id, kind, total);
  } catch (e) {
    releaseJob(gate);
    throw e;
  }
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
    } finally {
      releaseJob(gate);
      index.pruneJobs(); // 顺手清掉过期的任务记录，别让 /data 里的 jobs 表无限长
    }
  })();
  return {id, kind, total, status: 'running'};
}

// 标题改了就把文件名跟着改：Obsidian 的双链按文件名解析，文件名不跟着动会让链接对不上
function renameTo(title, rel) {
  const {abs} = inside(rel);
  const dir = dirname(abs);
  const name = safeName(title);
  // 文件名已经是「标题」或「标题 N」时说明标题没变，直接返回；否则重名笔记每次保存
  // 都会在 X 2.md / X 3.md 之间来回改名，Obsidian 双链每次断一次。
  const cur = abs.slice(dir.length + 1);
  const stem = cur.endsWith('.md') ? cur.slice(0, -3) : cur;
  if (stem === name) return rel;
  // 文件名是「标题 N」（新建时的重名序号）且同一标题的基名已被别的文件占用 → 标题没变，不能改名。
  // 只凭「空格+数字」判断会把「报告 2026.md 改成标题 报告」这种真实改名误判成未变。
  // 大小写不敏感的文件系统（macOS / Windows / 多数 SMB）上「只改标题大小写」时，
  // baseAbs 与 abs 是同一个文件，字符串比较却判成不同 → 被当成重名，文件名变成「X 2.md」。
  const baseAbs = join(dir, name + '.md');
  const sameFile = baseAbs.toLowerCase() === abs.toLowerCase();
  if (!sameFile && existsSync(baseAbs) && dedupName(name).test(stem)) return rel;
  let next = join(dir, name + '.md');
  if (sameFile) {
    // 只差大小写：直接改名（renameSync 在不敏感盘上是安全的覆盖式重命名）。
    try {
      renameSync(abs, next);
      const nextRel = posix.join(posix.dirname(rel), next.slice(dir.length + 1));
      gitCommit(nextRel, `重命名 ${rel} → ${nextRel}`);
      invalidate();
      return nextRel;
    } catch (e) {
      console.error('[note-api] 重命名失败：', e.message);
      return rel;
    }
  }
  for (let i = 2; i < 1000 && existsSync(next); i++) next = join(dir, `${name} ${i}.md`);
  // 序号用尽时绝不能继续 rename：那时 next 是个已有文件，renameSync 会静默覆盖它
  if (existsSync(next)) fail(409, `同名文件过多，未改名：${rel}`);
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

// 兜底：未捕获的 promise rejection 只记日志，绝不让进程退出。
// createServer 的回调是 async，任何抛在 try 之外的异常都会变成 unhandledRejection，
// 而 Node 默认 unhandled-rejections=throw → 整个服务下线（一次请求即可 DoS）。
process.on('unhandledRejection', e => { console.error('[note-api] unhandledRejection：', e); });
// uncaughtException 相反：同步栈已经断了，进程状态不可信，继续跑只会「僵尸不退出」——
// docker ps 仍显示 Up，restart 策略也不会介入。记完日志主动退出，交给 restart: unless-stopped。
process.on('uncaughtException', e => {
  console.error('[note-api] uncaughtException，进程退出：', e);
  process.exit(1);
});

const server = createServer(async (req, res) => {
  // 访问日志只在 VERBOSE=1 时打（默认不刷屏）：排障时至少能看出是谁在打哪个请求、慢在哪。
  if (process.env.VERBOSE === '1') {
    const startedAt = Date.now();
    res.on('finish', () => console.error(`[note-api] ${req.method} ${req.url} ${res.statusCode} ${clientIp(req)} ${Date.now() - startedAt}ms`));
  }
  try {
    // base 不能用客户端可控的 Host：`Host: a b` 会让 new URL 抛 TypeError，
    // 而那条异常原本在 try 之外 —— 一个畸形头就把服务打挂。路由只用 pathname，固定 base 足够。
    const url = new URL(req.url, 'http://localhost');
    // 大小写不敏感地识别 /api 前缀：`/API/data` 落到静态回退会返回 index.html + 200，
    // 客户端把一段 HTML 当 JSON 解析，错误路径彻底不可读。
    if (/^\/api\//i.test(url.pathname)) return await route(req, res, url);
    if (STATIC_DIR && (req.method === 'GET' || req.method === 'HEAD')) {
      // 登录页与头像必须公开，否则未登录时连登录表单都打不开
      const publicStatic = url.pathname === '/login.html' || url.pathname === '/avatar.svg';
      if (!publicStatic && !authed(req)) {
        // 直接访问页面时跳登录页；静态资源仍返回 401，避免把 HTML 当 JS 返回
        const wantsHtml = String(req.headers.accept || '').includes('text/html') &&
          !url.pathname.startsWith('/assets/');
        if (wantsHtml) {
          // 带上原路径：login.html 的 safeNext() 会在登录后跳回去。
          // 丢掉它意味着从深链进入、或会话过期后被踢，登录完一律回首页，上下文全没了。
          // 含控制字符的路径不往 next 里塞：浏览器解析 URL 前会删掉 \t \r \n，
          // "/%09/evil.example" 这类构造会变成站外跳转，直接回首页最稳。
          const back = url.pathname + url.search;
          const next = '/login.html?next=' + encodeURIComponent(
            /[\u0000-\u001f\u007f]/.test(back) ? '/' : back
          );
          res.writeHead(302, {location: next, 'cache-control': 'no-store', ...SECURITY_HEADERS});
          return res.end();
        }
        return json(res, 401, {error: '未登录'});
      }
      if (serveStatic(req, res, url.pathname)) return;
    }
    json(res, 404, {error: '没有这个路径'});
  } catch (e) {
    if (res.headersSent) return res.end();
    // 只有我们自己 fail() 出来的消息能回给客户端。内部异常（EISDIR / SQLite 报错 / 权限）
    // 的 message 里带服务器绝对路径与内部结构（实测 GET /api/note?path=目录.md 会把
    // `EISDIR: illegal operation on a directory, read` 和临时目录绝对路径回给浏览器）。
    if (e instanceof HttpError) return json(res, e.code, {error: e.message, ...(e.extra || {})});
    console.error('[note-api]', e);
    // 常见文件系统错误映射成语义状态码：「文件不存在」不该说成 500
    const map = {ENOENT: 404, EISDIR: 404, ENOTDIR: 404, EACCES: 403, EPERM: 403, ENOSPC: 507, EROFS: 507};
    const code = map[e.code] || 500;
    const msg = code === 404 ? '文件不存在'
      : code === 403 ? '没有权限访问该文件'
      : code === 507 ? '磁盘空间不足或只读'
      : '服务器内部错误';
    json(res, code, {error: msg});
  }
});

// 监听失败（端口占用是部署期最常见的故障）不能只留一句 throw er 的堆栈
server.on('error', e => {
  console.error(`[note-api] 监听 ${HOST}:${PORT} 失败：${e.message}`);
  process.exit(1);
});

// auth 自举：没有 DASHBOARD_PASSWORD 时生成随机密码写进 AUTH_FILE 并打印（首次启动）
bootstrapAuth();
// 登录配置在启动时定型：读不懂就拒绝启动，绝不降级成「未开启登录」
try { AUTH_CONFIG = loadAuthConfig(); }
catch (e) {
  console.error('[note-api] 登录配置无法读取，已拒绝启动：' + e.message);
  console.error('[note-api] 修好该文件再启动（删掉会重新生成随机密码并打印到日志）。');
  process.exit(1);
}

// vault 子目录自动创建：git clone 后直接 compose up 时挂载进来的 vault 是空的，
// 按看板的目录约定建出标准结构，用户把笔记放进来就能用（已存在的不动）。
for (const dir of [...new Set(Object.values(KIND_DIR))]) {
  try { mkdirSync(join(VAULT, dir), {recursive: true}); } catch {}
}

// 启动时先把索引建好，第一次打开页面就不用等
try { console.error(`[note-api] 索引 ${reindex()} 条，共 ${index.count()} 条`); }
catch (e) { console.error('[note-api] 首次索引失败：', e.message); }
// 上次进程被中断时留在表里的 running 任务永远不会收敛：先标成失败，前端才不会空转到超时
try {
  const stale = index.failRunningJobs();
  if (stale) console.error(`[note-api] 上次运行中断，已把 ${stale} 个未完成的 AI 任务标为失败`);
} catch (e) { console.error('[note-api] 收口未完成任务失败：', e.message); }
// 只在 runJob 的 finally 里清 jobs 表的话，长期不跑 AI 的库里旧行（含 relate 最多 400 条边的
// result JSON）会一直留着，/api/ai/jobs/:id 也永远不返回 404。启动时再收一次。
try { index.pruneJobs(); } catch {}
// 崩溃残留的临时文件：留着会被 Obsidian / Syncthing / git 当成普通笔记同步出去
for (const root of [VAULT, DATA_DIR]) {
  try {
    const n = cleanupTempFiles(root);
    if (n) console.error(`[note-api] 已清理 ${n} 个崩溃残留的临时文件（${root}）`);
  } catch (e) { console.error('[note-api] 清理临时文件失败：', e.message); }
}

// AI 热点日报的定时任务（NEWS_CRON=0 关闭）。日报生成后自动筛选题落进 04-选题池。
if (process.env.NEWS_CRON !== '0') {
  startNewsCron(async () => {
    // cron 也必须走同一把闸：否则它会和手动的 /api/news/refresh 或正在跑的 analyze
    // 同时调模型、同时往 04-选题池 写，后写者覆盖前者（而注释一直声称共用一个闸）。
    let gate;
    try { gate = acquireJob('news-cron'); } catch { return; } // 有任务在跑就跳过这一轮
    try {
      const r = await refreshNews(index, VAULT);
      // 日报落盘后立刻重建索引：原来 reindex 排在 ideasFromNews 之后，一旦筛选题抛错，
      // 当天的日报就永远进不了 notes 索引（/api/search 与 ask/RAG 都搜不到它）。
      if (r) { invalidate(); try { reindex(); } catch (e) { console.error('[news] 日报后同步索引失败：', e.message); } }
      // 手动生成过当天日报时 r 为 null，但那天的选题可能还没筛。幂等统一由 news 表的 ideasAt 判，
      // 不再用 r 决定要不要筛（原来 r 为 null 就永久跳过当天自动选题，而且没有任何日志）。
      try {
        const ideas = await ideasFromNews(index, VAULT, {auto: true, io: {createNote}});
        if (ideas.written?.length) {
          reindex();
          console.error(`[news] 已从热点自动筛出 ${ideas.written.length} 个选题进 04-选题池`);
        }
      } catch (e) {
        console.error('[news] 自动筛选题跳过：', e.message);
      }
    } catch (e) {
      console.error('[news] 定时生成日报失败：', e.message);
    } finally {
      releaseJob(gate);
    }
  });
}

// 平台指标同步的定时任务（PLATFORM_SYNC_CRON=0 关闭）：每天 SYNC_HOUR 点后拉公众号数据回写 vault。
if (process.env.PLATFORM_SYNC_CRON !== '0') {
  startPlatformsCron(async () => {
    // 与 /api/platforms/pull 共用闸：两边同时写同一批作品会产生 409 或重复提交
    let gate;
    try { gate = acquireJob('platforms-cron'); } catch { return; }
    try {
      // 同 /api/platforms/pull：cron 也必须用全量读，不能用带 30 篇展示窗口的 loadData()
      const d = readVault({vault: VAULT, full: true});
      const works = d.works.filter(w => w.post.platform && w.post.url);
      const {results, aborted, error} = await pullAll({works}, VAULT, {writeExisting, mtimeOf});
      if (aborted) console.error(`[platforms] 同步已中止：${error}`);
      if (results.some(r => r.updated)) reindex();
      if (results.length) console.error(`[platforms] ${results.length} 篇有平台来源`);
      // 返回统计给 cron：全部失败 / 凭据类中止时都不能置「今天已同步」，否则当天剩余 tick 全被跳过
      return {
        ok: results.filter(r => r.updated).length,
        failed: results.filter(r => r.error && r.pullable).length,
        aborted: !!aborted
      };
    } finally {
      releaseJob(gate);
    }
  });
}

// 运行期也要收口：只在启动时收一次的话，另一个实例（或本次进程之前的崩溃）留下的 running
// 行要等到下次重启才变 error，而容器 hostname 每次重建都会变，pid 判据也救不了它。
// 10 分钟一次，两条 SQL 的代价，unref 保证它不拖住进程退出。
setInterval(() => {
  try { index.failRunningJobs(); } catch {}
  try { index.pruneJobs(); } catch {}
}, 10 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  const auth = currentAuth();
  const authNote = auth
    ? `  已开启登录（用户 ${auth.user}）`
    : (API_TOKEN ? '  （已开启 token 鉴权）' : '  未开启登录');
  // 版本号必须打出来：容器只挂 :latest 时，升级后行为变了没法知道跑的是哪个 commit，
  // 也没法据此回滚（CI 同时推 sha-xxxxxxx 标签，见 docs/nas-deployment.md）。
  const build = process.env.BUILD_VERSION || 'dev';
  console.error(`[note-api] 版本 ${build}  http://${HOST}:${PORT}  笔记库：${VAULT}${STATIC_DIR ? `  静态目录：${STATIC_DIR}` : ''}${authNote}`);
  // 未开启登录是合法配置（本机开发 / 纯静态），但部署到局域网时它是致命的：所有 /api 裸奔。
  // 原来静默放行，日志里看不出来，这里必须显式告警一次。
  if (!auth) {
    console.error('[note-api] 警告：未配置 DASHBOARD_PASSWORD / AUTH_FILE，所有 /api 请求都不校验身份。');
    console.error('[note-api] 仅供本机开发；要在局域网使用，请设置 DASHBOARD_PASSWORD 或 AUTH_FILE。');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  // 先把飞行中的任务落到终态再关库：否则 runJob 在 await 之后调 updateJob 会抛
  // 「database is not open」，前端只能等下一次启动的收口（而容器 hostname 会变，收口可能永远不生效）。
  try { index.failMyJobs('服务停止中断'); } catch {}
  index.close();
  process.exit(0);
});

export {server, index, loadData, reindex, target, writeExisting, createNote, removeNote, renameTo, inside, safeName};


