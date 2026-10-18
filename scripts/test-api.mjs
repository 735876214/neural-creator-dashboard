// note-api 的最小端到端测试：在临时 vault 上起一个真实服务，覆盖最容易回归的路径。
//
// 运行：npm run test:api
// 不联网、不依赖测试框架；用 examples/vault 的临时副本，测试完自动清理。
import {strict as assert} from 'node:assert';
import {spawn} from 'node:child_process';
import {cpSync, existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'ncd-api-'));
const vault = join(tmp, 'vault');
cpSync(join(ROOT, 'examples/vault'), vault, {recursive: true});

const freePort = () => new Promise((ok, fail) => {
  const s = createServer();
  s.once('error', fail);
  s.listen(0, '127.0.0.1', () => {
    const {port} = s.address();
    s.close(() => ok(port));
  });
});

let child;
let authChild;
let logs = '';
let passed = 0;
const ok = msg => { passed++; console.log('  ✓ ' + msg); };

async function waitReady(base) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) return;
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('note-api 未在 10 秒内启动\n' + logs);
}

try {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(ROOT, 'server/index.mjs')], {
    env: {
      ...process.env,
      VAULT_DIR: vault,
      DATA_DIR: join(tmp, 'data'),
      PORT: String(port),
      HOST: '127.0.0.1',
      VAULT_GIT: '0',
      NEWS_CRON: '0',
      AI_API_KEY: '',
      EMBED_API_KEY: '',
      // 基础用例不开启登录，也避免开发机上的环境变量干扰
      DASHBOARD_PASSWORD: '',
      AUTH_FILE: '',
      API_TOKEN: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', d => { logs += d; });
  child.stderr.on('data', d => { logs += d; });
  await waitReady(base);

  const json = async (path, init) => {
    const res = await fetch(base + path, init);
    const body = await res.json().catch(() => null);
    return {status: res.status, body};
  };
  const put = (path, data) => json(path, {
    method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify(data)
  });

  console.log('note-api');

  // 1. /api/data 形状
  const data = await json('/api/data?fresh');
  assert.equal(data.status, 200);
  for (const key of ['posts', 'notes', 'seedIdeas', 'seedDrafts', 'concepts', 'files', 'mtimes', 'settings']) {
    assert.ok(key in data.body, `/api/data 缺少 ${key}`);
  }
  assert.ok(Array.isArray(data.body.posts) && data.body.posts.length, 'posts 应为非空数组');
  assert.equal(typeof data.body.settings.goal, 'number');
  ok('/api/data 形状与 settings / mtimes');

  // 2. 正常写正文
  const rel = data.body.files['note:n1'] || Object.values(data.body.files).find(p => p.endsWith('.md'));
  assert.ok(rel, '找不到可写的笔记');
  const before = await json('/api/note?path=' + encodeURIComponent(rel));
  assert.equal(before.status, 200);
  const appended = before.body.text + '\n\nE2E 测试追加';
  const wrote = await put('/api/note', {path: rel, body: appended, mtime: before.body.mtime});
  assert.equal(wrote.status, 200);
  const after = await json('/api/note?path=' + encodeURIComponent(rel));
  assert.match(after.body.text, /E2E 测试追加/);
  ok('PUT /api/note 正常写入');

  // 3. 旧 mtime 必须 409，且文件不被覆盖
  const conflict = await put('/api/note', {path: rel, body: '不应写入', mtime: before.body.mtime});
  assert.equal(conflict.status, 409);
  const unchanged = await json('/api/note?path=' + encodeURIComponent(rel));
  assert.equal(unchanged.body.text, after.body.text);
  ok('mtime 不一致返回 409 且不覆盖');

  // 4. 设置持久化
  const saved = await put('/api/settings', {goal: 17});
  assert.equal(saved.status, 200);
  assert.equal(saved.body.goal, 17);
  assert.ok(existsSync(join(vault, '.dashboard', 'settings.json')), '设置文件未生成');
  assert.equal((await json('/api/settings')).body.goal, 17);
  ok('PUT/GET /api/settings 与 vault/.dashboard/settings.json');

  // 5. 新建草稿 → 删除 → .trash 备份
  const created = await put('/api/draft', {title: 'e2e-draft', body: 'hello', fm: {source: '一条资料的完整旅程'}});
  assert.equal(created.status, 201);
  const draftPath = created.body.path;
  assert.ok(existsSync(join(vault, draftPath)), '草稿文件未创建');
  assert.match(readFileSync(join(vault, draftPath), 'utf8'), /source:/);
  const removed = await json('/api/note?path=' + encodeURIComponent(draftPath), {method: 'DELETE'});
  assert.equal(removed.status, 200);
  assert.ok(!existsSync(join(vault, draftPath)), '草稿文件未删除');
  assert.ok(existsSync(join(vault, '.trash', draftPath)), '草稿未备份到 .trash');
  ok('新建草稿、DELETE 与 .trash 备份');

  // 6. 非法 frontmatter 值被拒绝
  const bad = await put('/api/idea', {title: 'e2e-bad', fm: {status: '乱写'}});
  assert.equal(bad.status, 400);
  ok('非法选题状态返回 400');

  // 7. 登录：未登录 401 → /api/login 拿 Cookie → 带 Cookie 可读 → auth-check 204
  const authPort = await freePort();
  const authBase = `http://127.0.0.1:${authPort}`;
  authChild = spawn(process.execPath, [join(ROOT, 'server/index.mjs')], {
    env: {
      ...process.env,
      VAULT_DIR: vault,
      DATA_DIR: join(tmp, 'data-auth'),
      PORT: String(authPort),
      HOST: '127.0.0.1',
      VAULT_GIT: '0',
      NEWS_CRON: '0',
      AI_API_KEY: '',
      EMBED_API_KEY: '',
      DASHBOARD_USER: 'tester',
      DASHBOARD_PASSWORD: 'e2e-pass',
      AUTH_FILE: '',
      API_TOKEN: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  authChild.stdout.on('data', d => { logs += d; });
  authChild.stderr.on('data', d => { logs += d; });
  await waitReady(authBase);

  const ajson = async (path, init) => {
    const res = await fetch(authBase + path, init);
    return {status: res.status, body: await res.json().catch(() => null), headers: res.headers};
  };

  const session = await ajson('/api/session');
  assert.equal(session.status, 200);
  assert.equal(session.body.required, true);
  assert.equal(session.body.authenticated, false);
  assert.equal((await ajson('/api/data')).status, 401, '未登录不应读到 /api/data');
  assert.equal((await fetch(authBase + '/api/auth-check')).status, 401);
  ok('开启登录后未登录请求返回 401');

  const wrong = await ajson('/api/login', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({username: 'tester', password: 'wrong'})
  });
  assert.equal(wrong.status, 401);

  const login = await fetch(authBase + '/api/login', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({username: 'tester', password: 'e2e-pass'})
  });
  assert.equal(login.status, 200);
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /^nd_session=/, '登录成功应设置会话 Cookie');
  ok('POST /api/login 校验密码并设置 HttpOnly 会话 Cookie');

  assert.equal((await ajson('/api/data', {headers: {cookie}})).status, 200);
  assert.equal((await fetch(authBase + '/api/auth-check', {headers: {cookie}})).status, 204);
  const signed = await ajson('/api/session', {headers: {cookie}});
  assert.equal(signed.body.authenticated, true);
  assert.equal(signed.body.user, 'tester');
  ok('带会话 Cookie 可读数据，auth-check 放行');

  const logout = await fetch(authBase + '/api/logout', {method: 'POST', headers: {cookie}});
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie') || '', /Max-Age=0/, '登出应让浏览器清掉 Cookie');
  ok('POST /api/logout 清掉会话 Cookie');

  console.log(`\n全部通过（${passed} 项）。`);
} catch (e) {
  console.error('\n未通过：', e.message);
  if (logs) console.error('\n--- note-api 输出 ---\n' + logs);
  process.exitCode = 1;
} finally {
  child?.kill();
  authChild?.kill();
  // Windows 上 index.sqlite 可能还被服务进程占着：等它退出再清理。
  await Promise.all([child, authChild].filter(Boolean).map(c => new Promise(res => {
    if (c.exitCode != null) return res();
    c.once('exit', res);
    setTimeout(res, 3000);
  })));
  rmSync(tmp, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
}
