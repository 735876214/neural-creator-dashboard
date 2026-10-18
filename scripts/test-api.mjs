// note-api 的最小端到端测试：在临时 vault 上起一个真实服务，覆盖最容易回归的路径。
//
// 运行：npm run test:api
// 不联网、不依赖测试框架；用 examples/vault 的临时副本，测试完自动清理。
import {strict as assert} from 'node:assert';
import {spawn} from 'node:child_process';
import {cpSync, existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {createServer} from 'node:http';
import {createServer as createNetServer} from 'node:net';
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
      // 基础用例不开启登录，也避免开发机上的环境变量干扰；网页抓取允许私网（测试用本地 HTTP 服务）
      DASHBOARD_PASSWORD: '',
      AUTH_FILE: '',
      API_TOKEN: '',
      WEB_FETCH_ALLOW_PRIVATE: '1'
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

  // 6a. 发布来源字段：草稿 fm 白名单放行 platform/url/platformId/syncedAt；非法类型 400
  const pub = await put('/api/draft', {title: 'e2e-pub', body: 'x', fm: {platform: '小红书', url: 'https://example.com/x', syncedAt: '手动 2026-10-18'}});
  assert.equal(pub.status, 201);
  const pubText = readFileSync(join(vault, pub.body.path), 'utf8');
  assert.match(pubText, /platform: 小红书/, 'platform 未写入');
  assert.match(pubText, /url: "https:\/\/example.com\/x"|url: https:\/\/example.com\/x/, 'url 未写入');
  const pubPut = await put('/api/note', {path: pub.body.path, fm: {platformId: 'abc123', syncedAt: '手动 2026-10-18'}, mtime: pub.body.mtime});
  assert.equal(pubPut.status, 200);
  assert.match(readFileSync(join(vault, pub.body.path), 'utf8'), /platformId: abc123/, 'platformId 未写入');
  const badSync = await put('/api/draft', {path: pub.body.path, fm: {url: 123}});
  assert.equal(badSync.status, 400);
  const badKey = await put('/api/note', {path: pub.body.path, fm: {任意键: 'x'}});
  assert.equal(badKey.status, 400);
  // /api/platforms/pull：未配凭据时应逐篇 pullable:false，不报错
  const pull = await json('/api/platforms/pull', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'});
  assert.equal(pull.status, 200);
  assert.ok(Array.isArray(pull.body.results));
  ok('发布来源字段与 /api/platforms/pull（未配凭据 pullable:false）');

  // 6b. 个人知识库：本地 HTTP 服务当网页源 → 剪藏 → 快照 → /api/data → 删除备份
  const clipPage = await new Promise(ok2 => {
    const s = createServer((req, res) => {
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
      res.end('<!doctype html><html><head><title>E2E 剪藏测试页</title></head><body><nav>导航噪音</nav><article><h1>正文标题</h1><p>这是一段足够长的测试正文，用来验证 HTML 转文本与网页剪藏落盘链路。' + '内容填充。'.repeat(30) + '</p></article></body></html>');
    });
    s.listen(0, '127.0.0.1', () => { const {port} = s.address(); ok2({port, close: () => s.close()}); });
  });
  const posted = await json('/api/knowledge', {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({url: `http://127.0.0.1:${clipPage.port}/page`, category: '推文'})});
  assert.equal(posted.status, 201, '剪藏应返回 201：' + JSON.stringify(posted.body));
  assert.match(posted.body.path, /^06-个人知识库\//, '剪藏 md 应落在 06-个人知识库/');
  assert.ok(existsSync(join(vault, posted.body.path)), '剪藏 md 未创建');
  assert.match(readFileSync(join(vault, posted.body.path), 'utf8'), /url:/, 'frontmatter 应带 url');
  assert.ok(posted.body.snapshot && existsSync(join(vault, posted.body.snapshot)), 'HTML 快照未落盘');
  const data2 = await json('/api/data?fresh');
  const clipped = data2.body.notes.find(n => n.kind === 'personal');
  assert.ok(clipped && clipped.url, '/api/data 应包含 kind:personal 且带 url');
  assert.equal(data2.body.files['personal:' + clipped.id], clipped.path ?? undefined, 'files 应有 personal: 前缀映射');
  // AI 未启用：重新分析返回 501
  const an501 = await json('/api/knowledge/analyze', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({path: posted.body.path})});
  assert.equal(an501.status, 501);
  // 快照读取：200 + CSP；目录外路径 400
  const snap = await fetch(base + '/api/knowledge/snapshot?path=' + encodeURIComponent(posted.body.snapshot));
  assert.equal(snap.status, 200);
  assert.match(snap.headers.get('content-security-policy') || '', /default-src 'none'/, '快照响应必须带 CSP');
  const snapBad = await json('/api/knowledge/snapshot?path=' + encodeURIComponent('05-方法库 methods/流程/观察记录方法.md'));
  assert.equal(snapBad.status, 400);
  // 非法 category
  const badCat = await json('/api/knowledge', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({title: 'x', category: '乱写'})});
  assert.equal(badCat.status, 400);
  // 缺 title 且缺 url
  const badEmpty = await json('/api/knowledge', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({note: 'x'})});
  assert.equal(badEmpty.status, 400);
  // 删除剪藏 → .trash 备份
  const rmClip = await json('/api/note?path=' + encodeURIComponent(posted.body.path), {method: 'DELETE'});
  assert.equal(rmClip.status, 200);
  assert.ok(existsSync(join(vault, '.trash', posted.body.path)), '剪藏删除后应备份到 .trash');
  clipPage.close();
  ok('个人知识库：剪藏 / 快照 / 501 / 路径白名单 / 删除备份');

  // 6c. 上传文件入库：md 直读 / docx zip 解析 / 非法类型 400
  const upMd = await fetch(base + '/api/knowledge/upload', {method: 'POST',
    headers: {'x-filename': encodeURIComponent('测试文档.md'), 'x-category': encodeURIComponent('制度'), 'content-type': 'application/octet-stream'},
    body: '第一行：上传测试正文。\n第二条制度要点：零依赖解析。'});
  assert.equal(upMd.status, 201, '上传 md 应 201');
  const upMdBody = await upMd.json();
  assert.match(upMdBody.path, /^06-个人知识库\//);
  assert.ok(upMdBody.chars > 10);

  // 最小 docx：手工构造 zip（store 存储，无压缩），word/document.xml 直写
  const crc32 = b => { let c, table = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; } let r = -1; for (const x of b) r = table[(r ^ x) & 0xff] ^ (r >>> 8); return (r ^ -1) >>> 0; };
  const makeZip = entries => { // entries: [{name, data(Buffer)}]，全部 store 不压缩
    const parts = [], central = [];
    let offset = 0;
    for (const {name, data} of entries) {
      const nameBuf = Buffer.from(name, 'utf8');
      const crc = crc32(data);
      const local = Buffer.alloc(30 + nameBuf.length + data.length);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 6);           // version needed
      local.writeUInt16LE(0, 8);            // method = store
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18); // compressed
      local.writeUInt32LE(data.length, 22); // uncompressed
      local.writeUInt16LE(nameBuf.length, 26);
      nameBuf.copy(local, 30); data.copy(local, 30 + nameBuf.length);
      parts.push(local);
      const cd = Buffer.alloc(46 + nameBuf.length);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(0, 10);              // method = store
      cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(data.length, 20);
      cd.writeUInt32LE(data.length, 24);
      cd.writeUInt16LE(nameBuf.length, 28);
      cd.writeUInt32LE(offset, 42);         // local header offset
      nameBuf.copy(cd, 46);
      central.push(cd);
      offset += local.length;
    }
    const cdBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, cdBuf, eocd]);
  };
  const docXml = '<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>第一条</w:t></w:r><w:r><w:t>上传测试制度正文</w:t></w:r></w:p><w:p><w:r><w:t>第二条：E2E 文档解析成功。</w:t></w:r></w:p></w:body></w:document>';
  const docx = makeZip([{name: 'word/document.xml', data: Buffer.from(docXml, 'utf8')}]);
  const upDocxRes = await fetch(base + '/api/knowledge/upload', {method: 'POST',
    headers: {'x-filename': encodeURIComponent('会议纪要.docx'), 'x-category': encodeURIComponent('制度'), 'content-type': 'application/octet-stream'},
    body: docx});
  assert.equal(upDocxRes.status, 201, '上传 docx 应 201：' + JSON.stringify(await upDocxRes.json().catch(() => ({}))));
  const d2 = await (await fetch(base + '/api/data?fresh')).json();
  const docxNote = d2.notes.find(n => n.title === '会议纪要');
  assert.ok(docxNote, '/api/data 应出现 docx 条目');
  const docxMd = readFileSync(join(vault, docxNote.path), 'utf8');
  assert.match(docxMd, /E2E 文档解析成功/, 'docx 正文应被提取');
  assert.match(docxMd, /sourceFile: 会议纪要\.docx/, 'frontmatter 应记 sourceFile');
  // 非法类型
  const upBad = await fetch(base + '/api/knowledge/upload', {method: 'POST',
    headers: {'x-filename': encodeURIComponent('virus.exe'), 'content-type': 'application/octet-stream'}, body: Buffer.from([0, 1, 2])});
  assert.equal(upBad.status, 400);
  // 缺文件名
  const upNoName = await fetch(base + '/api/knowledge/upload', {method: 'POST', headers: {'content-type': 'application/octet-stream'}, body: 'x'});
  assert.equal(upNoName.status, 400);
  ok('上传入库：md / docx / 非法类型 / 缺文件名');

  // 6c2. /api/version：vault 指纹（自动刷新轮询用）——稳定 → 写盘后变化
  const v1 = await json('/api/version');
  assert.equal(v1.status, 200);
  assert.equal(typeof v1.body.v, 'number', 'v 应为数字');
  const vSame = await json('/api/version');
  assert.equal(vSame.body.v, v1.body.v, '无写入时指纹应稳定');
  const cur = await json('/api/note?path=' + encodeURIComponent(rel));
  await put('/api/note', {path: rel, body: cur.body.text + '\n指纹测试', mtime: cur.body.mtime});
  const v2 = await json('/api/version');
  assert.notEqual(v2.body.v, v1.body.v, '写盘后指纹应变化');
  ok('/api/version 指纹（稳定 / 写后变化）');

  // 6d. 独立创作入口：新建方法笔记 / 草稿生成作品 / 附件上传
  const newNote = await json('/api/note-new', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({title: 'e2e 新建笔记', body: 'E2E 独立创建。', fm: {tags: ['e2e']}})});
  assert.equal(newNote.status, 201);
  assert.match(newNote.body.path, /^05-方法库\//);
  const badPostNew = await json('/api/note-new', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({title: 'x', kind: 'post'})});
  assert.equal(badPostNew.status, 400, 'note-new 不开放 post');
  ok('新建方法笔记（/api/note-new）');

  // 6d2. 稳定 ID：选题 fm.id + 草稿 fm.sourceIdeaId 优先关联；老格式 source=标题 回退
  const ideaNew = await put('/api/idea', {title: 'e2e 稳定ID选题', body: 'x', fm: {id: 'idea-e2e1'}});
  assert.equal(ideaNew.status, 201);
  const ideaMd = readFileSync(join(vault, ideaNew.body.path), 'utf8');
  assert.match(ideaMd, /id: idea-e2e1/, '选题应写入稳定 id');
  // 草稿用 sourceIdeaId 关联（不写 source 标题）
  const dStable = await put('/api/draft', {title: 'e2e 稳定ID草稿', body: 'x', fm: {sourceIdeaId: 'idea-e2e1'}});
  assert.equal(dStable.status, 201);
  // 改选题标题 → 关联不断（id 优先）
  const ren = await put('/api/idea', {path: ideaNew.body.path, title: 'e2e 稳定ID选题改'});
  assert.equal(ren.status, 200);
  const dStableData = await json('/api/data?fresh');
  const dStableNote = dStableData.body.seedDrafts.find(d => d.title === 'e2e 稳定ID草稿');
  assert.ok(dStableNote, '稳定ID草稿应出现在 /api/data');
  const ideaRenamed = dStableData.body.seedIdeas.find(i => i.title === 'e2e 稳定ID选题改');
  assert.ok(ideaRenamed, '改名的选题应存在');
  assert.equal(String(dStableNote.source), String(ideaRenamed.id), '改名后 source 仍应按 id 关联');
  // 无 id 的自动生成：新建选题不带 fm.id → 201 且文件里有 id
  const ideaAuto = await put('/api/idea', {title: 'e2e 自动ID选题', body: 'x'});
  assert.equal(ideaAuto.status, 201);
  assert.match(readFileSync(join(vault, ideaAuto.body.path), 'utf8'), /id: "?[A-Za-z0-9_-]+"?/, '新建选题应自动生成稳定 id');
  // 老格式回退：source=标题 仍能关联
  const dLegacy = await put('/api/draft', {title: 'e2e 老格式草稿', body: 'x', fm: {source: 'e2e 稳定ID选题改'}});
  assert.equal(dLegacy.status, 201);
  const dLegacyData = await json('/api/data?fresh');
  const dLegacyNote = dLegacyData.body.seedDrafts.find(d => d.title === 'e2e 老格式草稿');
  assert.equal(String(dLegacyNote.source), String(ideaRenamed.id), '老格式 source=标题 应回退关联成功');
  ok('稳定 ID：选题 id + sourceIdeaId 优先 / 自动生成 / 标题回退');

  // 发布：建一篇草稿 → 移入 02-作品库 + 指标（createNote 的 draft 落在 03-创作台/ 根目录）
  const pubDraft = await put('/api/draft', {title: 'e2e 发布稿', body: '发布链路验证'});
  assert.equal(pubDraft.status, 201);
  const pubRes = await json('/api/publish', {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({path: pubDraft.body.path, metrics: {views: 100, likes: 10}})});
  assert.equal(pubRes.status, 201, '发布应 201：' + JSON.stringify(pubRes.body));
  assert.match(pubRes.body.path, /^02-作品库\//);
  assert.ok(!existsSync(join(vault, pubDraft.body.path)), '原草稿应已移走');
  const pubMd = readFileSync(join(vault, pubRes.body.path), 'utf8');
  assert.match(pubMd, /views: 100/, '指标应写入 frontmatter');
  assert.match(pubMd, /date: \d{4}-\d{2}-\d{2}/, '发布日期应写入');
  // 非 03-创作台 的文件不能发布
  const pubBad = await json('/api/publish', {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({path: newNote.body.path})});
  assert.equal(pubBad.status, 400);
  // 发布后 /api/data 的 posts 应含它（同名 → 与选题回连靠标题，不在此断言）
  const d3 = await json('/api/data?fresh');
  assert.ok(d3.body.posts.some(p => p.title === 'e2e 发布稿'), '/api/data posts 应包含新作品');
  ok('草稿发布为作品（/api/publish：移动 + 指标 + 白名单）');

  // 附件：png 上传 → 读取 → 非法扩展拒绝
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
  const upImg = await fetch(base + '/api/attachment', {method: 'POST',
    headers: {'x-filename': encodeURIComponent('截图.png'), 'content-type': 'application/octet-stream'}, body: png});
  assert.equal(upImg.status, 201);
  const imgPath = (await upImg.json()).path;
  assert.match(imgPath, /^99-附件\//);
  const getImg = await fetch(base + '/api/attachment?path=' + encodeURIComponent(imgPath));
  assert.equal(getImg.status, 200);
  assert.equal(getImg.headers.get('content-type'), 'image/png');
  const upSvg = await fetch(base + '/api/attachment', {method: 'POST',
    headers: {'x-filename': encodeURIComponent('evil.exe'), 'content-type': 'application/octet-stream'}, body: png});
  assert.equal(upSvg.status, 400);
  const upTraversal = await json('/api/attachment?path=' + encodeURIComponent('05-方法库 methods/流程/观察记录方法.md'));
  assert.equal(upTraversal.status, 400);
  ok('附件上传与读取（/api/attachment：白名单 + 目录钉死）');

  // 7. 登录：未登录 401 → /api/login 换 Cookie → 带 Cookie 可读 → auth-check 204
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
