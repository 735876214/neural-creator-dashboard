// note-api 的最小端到端测试：在临时 vault 上起一个真实服务，覆盖最容易回归的路径。
//
// 运行：npm run test:api
// 不联网、不依赖测试框架；用 examples/vault 的临时副本，测试完自动清理。
import {strict as assert} from 'node:assert';
import {spawn} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {createServer as createNetServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
// 和前端用同一份实现，避免测试里内联一份正则、测不到真正跑在页面里的那段逻辑
import {stripFrontmatter} from '../src/neural/mdfront.js';
// 直接测索引层：遗留任务收口这类「进程启动时」的逻辑没有 HTTP 入口，只能对 DB 断言
import {openIndex} from '../server/db.mjs';

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
let aiChild;
let gemChild;
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
      // 不关掉平台定时同步的话，SYNC_HOUR 默认 21 点一过，启动 20s 后 cron 会联网全量拉取并写盘，
      // 给后面所有 409 / mtime 断言制造 flake（badChild 早就设了，主服务漏了）。
      PLATFORM_SYNC_CRON: '0',
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
  // 必须先把 frontmatter 剥掉：原来直接把「含 frontmatter 的全文」当 body 回写，
  // 落盘变成两份 frontmatter（实测 4 个 ---）而断言只 match 尾标记，照样全绿 ——
  // 「写回破坏 frontmatter」这类破坏性 bug 一律假绿，且后面 300 行断言都跑在这份坏文件上。
  const appended = stripFrontmatter(before.body.text) + '\n\nE2E 测试追加';
  const wrote = await put('/api/note', {path: rel, body: appended, mtime: before.body.mtime});
  assert.equal(wrote.status, 200);
  const after = await json('/api/note?path=' + encodeURIComponent(rel));
  assert.equal(stripFrontmatter(after.body.text).trim(), appended.trim(), '正文应原样改写成新内容');
  assert.equal((readFileSync(join(vault, rel), 'utf8').match(/^---$/gm) || []).length, 2,
    '写回后文件必须仍然只有一对 frontmatter 分隔线');
  ok('PUT /api/note 正常写入');

  // 3. 旧 mtime 必须 409，且文件不被覆盖
  const conflict = await put('/api/note', {path: rel, body: '不应写入', mtime: before.body.mtime});
  assert.equal(conflict.status, 409);
  const unchanged = await json('/api/note?path=' + encodeURIComponent(rel));
  assert.equal(unchanged.body.text, after.body.text);
  ok('mtime 不一致返回 409 且不覆盖');

  // 3b. 乐观锁的失效路径（都出过真实事故）：mtime:"abc" 曾让比较恒为 false 而静默覆盖；
  // 完全不传 mtime 的正文写回曾跳过整把锁 —— 现在必须是 400 / 409，不能有任何一条能写进去。
  const badMtime = await put('/api/note', {path: rel, body: '不应写入', mtime: 'abc'});
  assert.equal(badMtime.status, 400, 'mtime 非数字必须 400：' + JSON.stringify(badMtime.body));
  const noMtime = await put('/api/note', {path: rel, body: '不应写入'});
  assert.equal(noMtime.status, 409, '正文写回不带 mtime 必须 409，不能无锁覆盖');
  assert.equal((await json('/api/note?path=' + encodeURIComponent(rel))).body.text, after.body.text,
    '被拒绝的写入不能改动文件');
  ok('mtime 非法 / 缺失都被拒绝（乐观锁失效路径）');

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
  // 先放一篇带 platform + url 的作品进库：库里没有这种作品时 results 结构性必然为空，
  // 「未配凭据 pullable:false」就成了永远成立的空断言（接口把 pullable 丢掉也照样绿）。
  const pullRel = '02-作品库/回归-抖音作品.md';
  writeFileSync(join(vault, pullRel), '---\nplatform: 抖音\nurl: https://www.douyin.com/video/1\n---\n# 回归-抖音作品\n\n正文\n');
  const pull = await json('/api/platforms/pull', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'});
  assert.equal(pull.status, 200, 'pull 应 200：' + JSON.stringify(pull.body));
  assert.ok(Array.isArray(pull.body.results) && pull.body.results.length, '应至少返回一条可同步作品');
  assert.equal(pull.body.results[0].pullable, false, '抖音个人号必须 pullable:false');
  ok('发布来源字段与 /api/platforms/pull（未配凭据 pullable:false）');

  // 6b. 个人知识库：本地 HTTP 服务当网页源 → 剪藏 → 快照 → /api/data → 删除备份
  const clipPage = await new Promise(ok2 => {
    const s = createServer((req, res) => {
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
      res.end('<!doctype html><html><head><title>E2E 剪藏测试页</title></head><body><nav>导航噪音</nav><article><h1>正文标题</h1><p>这是一段足够长的测试正文，用来验证 HTML 转文本与网页剪藏落盘链路。' + '内容填充。'.repeat(30) + '</p></article></body></html>');
    });
    s.listen(0, '127.0.0.1', () => { const {port} = s.address(); ok2({port, close: () => s.close()}); });
  });
  // 本地剪藏源服务必须无条件关掉：原来 close() 在成功路径末尾，169~202 之间任一断言抛出，
  // 监听 handle 就把事件循环拖住 —— 报完错 npm run test:api 仍然挂着不退出。
  try {
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
    // 快照目录同样跑一遍穿越矩阵：快照是 HTML，能读到别的 .html 就是同源脚本执行
    for (const bad of ['06-个人知识库/.snapshots/../../02-作品库/x.html', '.snapshots/x.html',
      '06-个人知识库/.snapshots/../../../etc/passwd', 'C:\\Windows\\win.ini', '../snap.html']) {
      const r = await json('/api/knowledge/snapshot?path=' + encodeURIComponent(bad));
      assert.ok(r.status === 400 || r.status === 404, `快照读取必须挡掉「${bad}」，实际 ${r.status}`);
    }
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
  } finally {
    clipPage.close();
  }
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

  // 6c1. 设置面板 AI 运行时配置：aiBaseUrl 走 settings.json；aiApiKey 走 DATA_DIR 秘密文件（不回显）
  const st1 = await put('/api/settings', {aiBaseUrl: 'https://gw.example.com/v1'});
  assert.equal(st1.status, 200);
  assert.equal(st1.body.aiBaseUrl, 'https://gw.example.com/v1');
  assert.equal(st1.body.aiKeyConfigured, false);
  const st2 = await put('/api/settings', {aiApiKey: 'sk-e2e-secret'});
  assert.equal(st2.status, 200);
  assert.equal(st2.body.aiKeyConfigured, true, '保存 key 后应报已配置');
  assert.ok(!('aiApiKey' in st2.body), 'key 绝不回显');
  const stGet = await json('/api/settings');
  assert.equal(stGet.body.aiKeyConfigured, true);
  assert.ok(!('aiApiKey' in stGet.body), 'GET 也不回显 key');
  assert.ok(existsSync(join(tmp, 'data', 'ai-secrets.json')), 'key 应存在 DATA_DIR 秘密文件');
  const settingsJson = readFileSync(join(vault, '.dashboard', 'settings.json'), 'utf8');
  assert.ok(!settingsJson.includes('sk-e2e-secret'), 'key 绝不能进 vault settings.json（会被 git 提交）');
  assert.match(settingsJson, /gw\.example\.com/, 'baseUrl 应在 settings.json');
  // 清空 key（空字符串 = 清除）
  const st3 = await put('/api/settings', {aiApiKey: ''});
  assert.equal(st3.body.aiKeyConfigured, false, '空字符串应清除 key');
  // 非法 base url
  const stBad = await put('/api/settings', {aiBaseUrl: 'ftp://x'});
  assert.equal(stBad.status, 400);
  ok('设置面板 AI 运行时配置（baseUrl / key 分离存储 / 不回显 / 清除）');

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
  // 一个指标都不填（默认路径）也必须写 date：否则发布时间退化成文件 mtime，之后任何编辑都会改掉它
  const pubDraft2 = await put('/api/draft', {title: 'e2e 无指标发布稿', body: '只有正文'});
  assert.equal(pubDraft2.status, 201);
  const pubRes2 = await json('/api/publish', {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({path: pubDraft2.body.path})});
  assert.equal(pubRes2.status, 201, '无指标发布应 201：' + JSON.stringify(pubRes2.body));
  assert.match(readFileSync(join(vault, pubRes2.body.path), 'utf8'), /date: \d{4}-\d{2}-\d{2}/,
    '没填指标时也要写入发布日期（否则会退化成文件 mtime）');
  assert.equal(pubRes2.body.metricsWritten, false, '没填指标时 metricsWritten 应为 false');
  // 非 03-创作台 的文件不能发布
  const pubBad = await json('/api/publish', {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({path: newNote.body.path})});
  assert.equal(pubBad.status, 400);
  // 发布后 /api/data 的 posts 应含它（同名 → 与选题回连靠标题，不在此断言）
  const d3 = await json('/api/data?fresh');
  assert.ok(d3.body.posts.some(p => p.title === 'e2e 发布稿'), '/api/data posts 应包含新作品');
  ok('草稿发布为作品（/api/publish：移动 + 指标 + 白名单）');

  // 6d3. 发布后「选题 → 草稿 → 作品」不能断：草稿文件被移走，来源选题 / 来源草稿的稳定 id
  // 必须随作品 frontmatter 落盘，并透传到 /api/data 的 posts（前端图谱靠它接最后一跳）。
  const srcIdea = await put('/api/idea', {title: 'e2e 来源选题', body: 'x', fm: {id: 'idea-src-e2e'}});
  assert.equal(srcIdea.status, 201);
  // 外部编辑器写进草稿的写法：fm id + sourceIdeaId（/api/draft 的白名单不开放 id，只能直接落盘）
  mkdirSync(join(vault, '03-创作台'), {recursive: true});
  writeFileSync(join(vault, '03-创作台', 'e2e 来源草稿.md'),
    '---\nid: draft-src-e2e\nsourceIdeaId: idea-src-e2e\n---\n\n正文\n', 'utf8');
  const pubLinked = await json('/api/publish', {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({path: '03-创作台/e2e 来源草稿.md'})});
  assert.equal(pubLinked.status, 201, '带来源的草稿发布应 201：' + JSON.stringify(pubLinked.body));
  const linkedMd = readFileSync(join(vault, pubLinked.body.path), 'utf8');
  assert.match(linkedMd, /sourceIdeaId: idea-src-e2e/, '作品应写入来源选题 id');
  assert.match(linkedMd, /sourceDraftId: draft-src-e2e/, '作品应写入来源草稿 id');
  assert.equal(pubLinked.body.metricsWritten, false, '只写来源字段时 metricsWritten 仍应为 false');
  assert.equal(pubLinked.body.sourceIdeaId, 'idea-src-e2e', '响应里应回带来源选题 id');
  const dLinked = await json('/api/data?fresh');
  const linkedPost = dLinked.body.posts.find(p => p.title === 'e2e 来源草稿');
  assert.ok(linkedPost, '/api/data posts 应包含带来源的作品');
  assert.equal(linkedPost.sourceIdeaId, 'idea-src-e2e', 'posts 应透传 sourceIdeaId');
  assert.equal(linkedPost.sourceDraftId, 'draft-src-e2e', 'posts 应透传 sourceDraftId');
  // 老格式：草稿只写 source=选题标题，发布时也要解析成稳定 id
  writeFileSync(join(vault, '03-创作台', 'e2e 标题来源草稿.md'),
    '---\nsource: e2e 来源选题\n---\n\n正文\n', 'utf8');
  const pubTitle = await json('/api/publish', {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({path: '03-创作台/e2e 标题来源草稿.md'})});
  assert.equal(pubTitle.status, 201);
  assert.match(readFileSync(join(vault, pubTitle.body.path), 'utf8'), /sourceIdeaId: idea-src-e2e/,
    'source=标题 的草稿发布时也应解析成选题 id');
  ok('发布保留来源（/api/publish：sourceIdeaId / sourceDraftId 落盘并透传）');

  // 6d4. UI 路径同样要成立：看板里新建草稿时就得有稳定 id（不能只有外部手写 frontmatter 的草稿才有），
  // 否则「草稿 → 作品」这一跳在实际使用中永远拿不到 sourceDraftId。
  const uiDraft = await put('/api/draft', {title: 'e2e UI 来源草稿', body: '正文', fm: {sourceIdeaId: 'idea-src-e2e'}});
  assert.equal(uiDraft.status, 201, '新建草稿应 201：' + JSON.stringify(uiDraft.body));
  assert.match(String(uiDraft.body.id || ''), /^[0-9a-f]{8}$/, '草稿创建应返回稳定 id：' + JSON.stringify(uiDraft.body));
  const pubUi = await json('/api/publish', {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({path: uiDraft.body.path})});
  assert.equal(pubUi.status, 201);
  const uiMd = readFileSync(join(vault, pubUi.body.path), 'utf8');
  // 按「键: 值」读，而不是正则拼 id：纯数字 id 会被 YAML 加上引号，正则比字符串值脆。
  const fmField = (text, key) => {
    const m = text.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?$`, 'm'));
    return m ? m[1].trim() : '';
  };
  assert.equal(fmField(uiMd, 'sourceDraftId'), uiDraft.body.id,
    'UI 新建的草稿发布后也要带 sourceDraftId，实际文件：\n' + uiMd);
  assert.equal(fmField(uiMd, 'sourceIdeaId'), 'idea-src-e2e', 'UI 新建的草稿也要带 sourceIdeaId');
  ok('草稿稳定 id（/api/draft 生成 id → 发布写 sourceDraftId）');

  // 6d5. 启动时收口遗留任务：只收「已经死掉的实例」留下的行，不能误杀同一 DATA_DIR 上
  // 另一个活着的实例正在跑的任务（两个 note-api 共用一个卷时会把对方的进度标成失败）。
  {
    const idx = openIndex(':memory:');
    idx.createJob('job-foreign', 'analyze', 1);
    idx.db.prepare("UPDATE jobs SET host='another-host' WHERE id='job-foreign'").run();
    idx.createJob('job-dead', 'analyze', 1);
    idx.db.prepare('UPDATE jobs SET pid=? WHERE id=?').run(2 ** 22 + 12345, 'job-dead'); // 必然不存在的 pid
    assert.equal(idx.failRunningJobs(), 1, '只应收口 pid 已退出的那一条');
    assert.equal(idx.job('job-foreign').status, 'running', '别的机器 / 容器上的任务不能被收口');
    assert.equal(idx.job('job-dead').status, 'error', '死掉的实例留下的任务应收口');
    assert.match(idx.job('job-dead').error, /服务重启中断/);
    idx.close();
    ok('遗留任务收口（/api/ai/jobs：只收死掉的实例，不误杀并发实例）');
  }

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
  // 路径穿越不能只测「把 .md 塞进附件目录」这一种最弱形状：真正会伤人的是跳出库、
  // 跳出附件目录、绝对路径、二次编码、Windows 反斜杠、以及内部目录（.trash / .snapshots）。
  const badPaths = [
    '99-附件/../05-方法库/流程/观察记录方法.md',
    '99-附件/../../outside.md',
    '../outside.png',
    '..\\..\\outside.png',
    '99-附件\\..\\..\\outside.png',
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    '.trash/99-附件/x.png',
    '.TRASH/99-附件/x.png',
    '.trash./99-附件/x.png',
    '99-附件/%2e%2e/%2e%2e/outside.png',
    '99-附件/%252e%252e%252foutside.png'
  ];
  for (const bad of badPaths) {
    const r = await json('/api/attachment?path=' + encodeURIComponent(bad));
    assert.ok(r.status === 400 || r.status === 404, `附件读取必须挡掉「${bad}」，实际 ${r.status}`);
  }
  // 上传文件名同样不能被用来跳目录（x-filename 是客户端完全可控的）：
  // 要么 400，要么清洗后仍落在 99-附件/ 下 —— 绝不能出现 .. 或被写到别的目录。
  for (const badName of ['../evil.png', '..\\evil.png', 'a/b.png', '.trash/x.png']) {
    const r = await fetch(base + '/api/attachment', {method: 'POST',
      headers: {'x-filename': encodeURIComponent(badName), 'content-type': 'application/octet-stream'}, body: png});
    if (r.status !== 400) {
      const body = await r.json();
      assert.equal(r.status, 201, `上传文件名「${badName}」只允许 400 或 201，实际 ${r.status}`);
      assert.ok(String(body.path).startsWith('99-附件/'), `上传文件名「${badName}」被写到 ${body.path}`);
      assert.ok(!String(body.path).includes('..'), `上传文件名「${badName}」落盘路径带 ..：${body.path}`);
      assert.equal(body.path.split('/').length, 2, `上传文件名「${badName}」不该产生子目录：${body.path}`);
    }
  }
  const upOk = await fetch(base + '/api/attachment', {method: 'POST',
    headers: {'x-filename': encodeURIComponent('穿越回归.png'), 'content-type': 'application/octet-stream'}, body: png});
  assert.equal(upOk.status, 201, '正常上传不能被上面的用例带坏');
  ok('附件上传与读取（/api/attachment：白名单 + 目录钉死 + 穿越矩阵）');

  // 6e. 回归：附件返回的 name 必须就是真正落盘的文件名（前端拿它拼 ![[名称]]）
  const upNamed = await fetch(base + '/api/attachment', {method: 'POST',
    headers: {'x-filename': encodeURIComponent('回归截图.png'), 'content-type': 'application/octet-stream'}, body: png});
  const upNamedBody = await upNamed.json();
  assert.equal(upNamedBody.name, upNamedBody.path.split('/').pop(), '附件 name 必须与落盘文件名一致');
  ok('附件 name 与落盘文件名一致（回归）');

  // 6f. 回归：日报节点的 files key / GET 都必须是 note: 前缀（前端 graph 用的就是这个 id）
  mkdirSync(join(vault, '00-AI热点'), {recursive: true});
  writeFileSync(join(vault, '00-AI热点/2026-01-01-回归日报.md'),
    '---\ntags: [日报]\n---\n# 回归日报\n\n- [条目](https://example.com/a)\n', 'utf8');
  const newsData = await json('/api/data?fresh');
  const newsNote = newsData.body.notes.find(n => n.kind === 'news');
  assert.ok(newsNote, '00-AI热点/ 下的笔记应解析为 kind=news');
  assert.ok(newsData.body.files['note:' + newsNote.id], '日报的 files key 必须是 note: 前缀');
  const newsGet = await json('/api/note?id=' + encodeURIComponent('note:' + newsNote.id));
  assert.equal(newsGet.status, 200, '日报必须能按 note: id 读到原文');
  ok('日报节点统一用 note: 前缀（回归）');

  // 6g. 回归：同名笔记保存时不能在「X 2.md / X 3.md」之间反复改名
  const dupA = await put('/api/idea', {title: 'e2e 同名选题', body: 'a'});
  const dupB = await put('/api/idea', {title: 'e2e 同名选题', body: 'b'});
  assert.equal(dupA.status, 201);
  assert.equal(dupB.status, 201);
  assert.notEqual(dupA.body.path, dupB.body.path, '同名笔记应写入不同文件');
  const dupSave1 = await put('/api/idea', {path: dupB.body.path, title: 'e2e 同名选题', body: 'b2'});
  const dupSave2 = await put('/api/idea', {path: dupSave1.body.path, title: 'e2e 同名选题', body: 'b3'});
  assert.equal(dupSave1.body.path, dupB.body.path, '标题未变时不应改名');
  assert.equal(dupSave2.body.path, dupB.body.path, '连续保存也不应改名');
  // 真改标题时仍要跟着改文件名
  const dupRenamed = await put('/api/idea', {path: dupB.body.path, title: 'e2e 改名后的选题', body: 'b4'});
  assert.equal(dupRenamed.body.path, '04-选题池/e2e 改名后的选题.md');
  assert.ok(!existsSync(join(vault, dupB.body.path)), '旧文件名应已移走');
  ok('同名笔记保存不改名漂移，改标题仍跟随（回归）');

  // 6g2. 回归：标题本身以数字结尾时（「报告 2026」→「报告」）不能被当成重名序号而漏改名
  const numA = await put('/api/idea', {title: 'e2e 报告 2026', body: 'n'});
  assert.equal(numA.status, 201);
  assert.match(numA.body.path, /e2e 报告 2026\.md$/, '标题里的数字应留在文件名里');
  const numRen = await put('/api/idea', {path: numA.body.path, title: 'e2e 报告', body: 'n2'});
  assert.equal(numRen.body.path, '04-选题池/e2e 报告.md', '标题「报告 2026」改成「报告」必须改名');
  ok('标题带数字时改名不被误判（回归）');

  // 6h. 回归：按 GET 返回的全文回写时必须先剥离 frontmatter，否则每保存一次就多一份 --- 块
  const fmRel = '05-方法库/01-流程/回归-frontmatter.md';
  writeFileSync(join(vault, fmRel), '---\ntags: [回归]\ntitle: 回归用笔记\n---\n正文第一行\n', 'utf8');
  const fmGet = await json('/api/note?path=' + encodeURIComponent(fmRel));
  assert.equal(fmGet.status, 200);
  const fmBody = stripFrontmatter(fmGet.body.text);
  assert.ok(!/^---/.test(fmBody), 'stripFrontmatter 应去掉开头的 frontmatter 块');
  const fmPut = await put('/api/note', {path: fmRel, body: fmBody + '\n\n回归：正文改写', mtime: fmGet.body.mtime});
  assert.equal(fmPut.status, 200);
  const fmAfter = readFileSync(join(vault, fmRel), 'utf8');
  const fmCount = (fmAfter.match(/^---$/gm) || []).length;
  assert.equal(fmCount, 2, 'frontmatter 只能保留一份（首尾两行 ---）：' + JSON.stringify(fmAfter.slice(0, 120)));
  assert.match(fmAfter, /tags: \[回归\]/, 'frontmatter 内容不能丢');
  assert.match(fmAfter, /回归：正文改写/);
  ok('回写正文剥离 frontmatter 后不复制（回归）');

  // 6h2. 回归：带 BOM / 空属性块的笔记，改正文时不能把整块属性（含标题、指标）抹掉
  const bomRel = '05-方法库/01-流程/回归-bom.md';
  writeFileSync(join(vault, bomRel), '\uFEFF---\ntitle: BOM 笔记\nviews: 12\n---\n原正文\n', 'utf8');
  const bomGet = await json('/api/note?path=' + encodeURIComponent(bomRel));
  assert.equal(bomGet.status, 200);
  const bomPut = await put('/api/note', {
    path: bomRel, body: stripFrontmatter(bomGet.body.text) + '\nBOM 改写', mtime: bomGet.body.mtime,
  });
  assert.equal(bomPut.status, 200, 'BOM 笔记回写应 200：' + JSON.stringify(bomPut.body));
  const bomAfter = readFileSync(join(vault, bomRel), 'utf8');
  assert.match(bomAfter, /title: BOM 笔记/, '带 BOM 的笔记回写正文后 frontmatter 不能被整块丢弃：' + JSON.stringify(bomAfter));
  assert.match(bomAfter, /views: 12/);
  assert.match(bomAfter, /BOM 改写/);
  // BOM 保留在文件最前面，第 1 行的 `---` 前面带 BOM，判断份数时先剥掉
  assert.equal(((bomAfter.replace(/^\uFEFF/, '').match(/^---$/gm) || []).length), 2, 'frontmatter 只能有一份');

  const emptyRel = '05-方法库/01-流程/回归-空属性.md';
  writeFileSync(join(vault, emptyRel), '---\n---\n空属性正文\n', 'utf8');
  const emptyGet = await json('/api/note?path=' + encodeURIComponent(emptyRel));
  assert.equal(emptyGet.status, 200);
  const emptyPut = await put('/api/note', {
    path: emptyRel, fm: {tags: ['e2e']}, body: '空属性正文改写', mtime: emptyGet.body.mtime,
  });
  assert.equal(emptyPut.status, 200, '空属性笔记回写应 200：' + JSON.stringify(emptyPut.body));
  const emptyAfter = readFileSync(join(vault, emptyRel), 'utf8');
  assert.match(emptyAfter, /tags:\s*\[e2e\]/, '空属性块也能写入新键：' + JSON.stringify(emptyAfter));
  assert.equal(((emptyAfter.match(/^---$/gm) || []).length), 2);
  ok('带 BOM / 空属性块的笔记回写不丢属性（回归）');

  // 6h3. 回归：改写多行标量（| / >）时旧内容必须被一起替换，不能残留在新值后面
  const mlRel = '05-方法库/01-流程/回归-多行.md';
  writeFileSync(join(vault, mlRel), '---\ntitle: 多行\nsummary: |\n  第一行\n  第二行\n---\n正文\n', 'utf8');
  const mlGet = await json('/api/note?path=' + encodeURIComponent(mlRel));
  const mlPut = await put('/api/note', {path: mlRel, fm: {summary: '新摘要'}});
  assert.equal(mlPut.status, 200, '多行笔记改写应 200：' + JSON.stringify(mlPut.body));
  const mlAfter = readFileSync(join(vault, mlRel), 'utf8');
  assert.ok(!/第一行|第二行/.test(mlAfter), '旧的多行值应被整体替换：' + JSON.stringify(mlAfter));
  assert.match(mlAfter, /summary: 新摘要/);
  assert.match(mlAfter, /title: 多行/);
  ok('改写多行标量不留残行（回归）');

  // 6i. 回归：正文里有畸形图片链接（裸 %）时 GET /api/note 不能 500
  const badRel = '05-方法库/01-流程/回归-图片.md';
  writeFileSync(join(vault, badRel), '---\ntags: [回归]\n---\n![图](100%.png)\n正文\n', 'utf8');
  const badGet = await json('/api/note?path=' + encodeURIComponent(badRel));
  assert.equal(badGet.status, 200, '畸形图片链接不应让整篇笔记打不开：' + JSON.stringify(badGet.body).slice(0, 120));
  const badData = await json('/api/data');
  assert.equal(badData.status, 200);
  ok('畸形图片链接不会让 /api/note 500（回归）');

  // 6j. /api/health 不暴露笔记库绝对路径
  const health = await json('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.ok(!('vault' in health.body), '健康检查不应返回 vault 绝对路径');
  ok('/api/health 只返回 ok');

  // 6k. fm 非对象必须 400（否则 'abc' 会被 Object.entries 拆成 0/1/2 三行写进 frontmatter）
  const FM_REL = '05-方法库/01-流程/回归-frontmatter.md';
  const fmRead = async () => (await json('/api/note?path=' + encodeURIComponent(FM_REL))).body;
  const fmInit = await fmRead();
  const fmBad = await put('/api/note', {path: FM_REL, fm: 'abc', mtime: fmInit.mtime});
  assert.equal(fmBad.status, 400, 'fm 是非对象时应 400，实际 ' + JSON.stringify(fmBad.body).slice(0, 120));
  const fmText = (await fmRead()).text;
  assert.ok(!/^0: a/m.test(fmText), '脏键 0: a 不应写进 frontmatter');
  assert.equal(fmText, fmInit.text, 'fm 非法时文件不应被改动');
  ok('PUT /api/note 拒绝非对象 fm（回归）');

  // 6l. frontmatter 值含换行：必须转义成单行，不能写出非法 YAML
  const nlDoc = await fmRead();
  const nlPut = await put('/api/note', {path: FM_REL, fm: {summary: '第一行\n第二行'}, mtime: nlDoc.mtime});
  assert.equal(nlPut.status, 200, JSON.stringify(nlPut.body).slice(0, 120));
  const nlText = (await fmRead()).text;
  assert.match(nlText, /summary: "第一行\\n第二行"/, '多行摘要应转义成一行：' + nlText.slice(0, 200));
  assert.ok(!/^第二行$/m.test(nlText), '不能留下裸的续行');
  ok('frontmatter 值含换行时转义成单行（回归）');

  // 6m. 请求体顶层不是对象 → 400，不是 500（且不回传内部报错文本）
  const badBody = await json('/api/settings', {method: 'PUT', headers: {'content-type': 'application/json'}, body: '"abc"'});
  assert.equal(badBody.status, 400, '非对象请求体应 400，实际 ' + badBody.status);
  assert.ok(!/Cannot use 'in' operator/.test(JSON.stringify(badBody.body || '')), '不应回传 JS 内部报错');
  ok('非对象请求体返回 400 而不是 500（回归）');

  // 6n. 平台凭据只改 AppID：应沿用已存 secret，不能 400
  const wx1 = await put('/api/settings', {platforms: {公众号: {appid: 'wx-one', secret: 'secret-one'}}});
  assert.equal(wx1.status, 200, JSON.stringify(wx1.body).slice(0, 120));
  const wx2 = await put('/api/settings', {platforms: {公众号: {appid: 'wx-two', secret: ''}}});
  assert.equal(wx2.status, 200, '只改 AppID 不应 400：' + JSON.stringify(wx2.body).slice(0, 160));
  const savedSettings = JSON.parse(readFileSync(join(vault, '.dashboard/settings.json'), 'utf8'));
  assert.equal(savedSettings.platforms['公众号'].appid, 'wx-two');
  // secret 不进 vault（settings.json 会被 gitCommit 进 git 历史并随 Syncthing 分发），改存 DATA_DIR
  assert.equal(savedSettings.platforms['公众号'].secret, undefined, 'settings.json 里不能出现平台 secret');
  assert.ok(!readFileSync(join(vault, '.dashboard/settings.json'), 'utf8').includes('secret-one'), 'vault 文件里不得残留明文凭据');
  const platSecretFile = JSON.parse(readFileSync(join(tmp, 'data', 'platform-secrets.json'), 'utf8'));
  assert.equal(platSecretFile['公众号'], 'secret-one', 'secret 应沿用旧值并存在 DATA_DIR');
  // POSIX 权限位只在类 Unix 上有意义：Windows 的 chmod 只能切只读位，statSync().mode 永远是
  // 0o666/0o444。以前这条在 Windows 上必然失败并中断整个测试文件（后半段的用例一条都不跑）。
  // 这里按平台判断，Windows 上改为验证「服务端确实尝试收紧了权限」，其余平台仍然严格比对 0600。
  const psMode = statSync(join(tmp, 'data', 'platform-secrets.json')).mode & 0o777;
  if (process.platform === 'win32') {
    assert.ok([0o600, 0o666, 0o444].includes(psMode), `Windows 上凭据文件权限位异常：${psMode.toString(8)}`);
  } else {
    assert.equal(psMode, 0o600, '凭据文件必须是 0600');
  }
  ok('只改公众号 AppID 时沿用已存 secret（回归）');

  // 6n-2. 设置面板存下的凭据必须被平台模块认出来（键名 platforms.公众号 vs platforms.wechat）
  const pInfo = await json('/api/settings');
  assert.equal(pInfo.status, 200);
  assert.equal(pInfo.body.platforms?.['公众号']?.configured, true, '设置面板应回显「已配置」');
  const pData = await json('/api/data?fresh');
  assert.equal(pData.body.platforms?.configured?.['公众号'], true,
    '设置面板存了凭据，平台模块却认为未配置（platforms.公众号 与 platforms.wechat 键名对不上）');
  assert.equal(pData.body.platforms?.pull?.['公众号']?.pullable, true);
  ok('设置面板保存的公众号凭据对平台模块可见（回归）');

  // 6n-3. 回归：两个输入框都清空 = 关掉公众号同步，不能 400（否则用户没有关掉同步的入口）
  const clearCreds = await put('/api/settings', {platforms: {'公众号': {appid: '', secret: ''}}});
  assert.equal(clearCreds.status, 200, '清空凭据应成功：' + JSON.stringify(clearCreds.body));
  const afterClear = await json('/api/settings');
  assert.ok(!afterClear.body.platforms?.['公众号'], '清空后不应再回显公众号凭据');
  ok('清空公众号凭据可以关掉同步（回归）');

  // 6n-4. 回归：超过 6000 字的草稿在 /api/data 里必须标 truncated，
  // 前端据此先拉全文再允许编辑（否则第一个按键就把截断正文写回，尾部内容永久丢失）。
  const longBody = '长'.repeat(6500);
  const longDraft = await put('/api/draft', {title: 'e2e 超长草稿', body: longBody});
  assert.equal(longDraft.status, 201, '超长草稿创建应 201：' + JSON.stringify(longDraft.body));
  const longData = await json('/api/data?fresh');
  const longEntry = (longData.body.seedDrafts || []).find(d => d.title === 'e2e 超长草稿');
  assert.ok(longEntry, '超长草稿应出现在 /api/data');
  assert.equal(longEntry.body.length, 6000, '/api/data 的正文被截到 6000 字');
  assert.equal(longEntry.truncated, true, '被截断的草稿必须标 truncated，否则前端会把截断正文写回');
  // 原来 find 的标题（'e2e 草稿'）全文件从未创建过，断言恒真：
  // 服务端把所有草稿都标 truncated:true 也是绿的。
  const shortEntry = (longData.body.seedDrafts || []).find(d => d.title === 'e2e 稳定ID草稿');
  assert.ok(shortEntry, '短草稿应出现在 /api/data');
  assert.ok(!shortEntry.truncated, '没被截断的草稿不应带 truncated');
  ok('超长草稿在 /api/data 里标出 truncated（回归）');

  // 6n-5. 回归：写盘走「同目录临时文件 + rename」，写完目录里不能留下 .tmp 残骸
  // （原地覆盖写在进程被杀时会把 .md 截成半截，残骸还会被当成笔记索引）。
  const putAgain = await put('/api/note', {path: FM_REL, fm: {summary: '原子写回归'}});
  assert.equal(putAgain.status, 200, '原子写回归的写入应 200：' + JSON.stringify(putAgain.body));
  const leftovers = readdirSync(join(vault, '05-方法库/01-流程')).filter(f => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], '写完不应留下临时文件');
  ok('写盘走临时文件 + rename 且不留残骸（回归）');

  // 6n-6. 回归：settings.json 里存在早期英文键 wechat / 半填凭据时，
  // 读取路径不能让整个 readSettings 抛错回落到默认值（否则月目标、全局模型被静默重置），
  // 而且要能把能归一化的凭据认成「公众号」。
  const settingsPath = join(vault, '.dashboard/settings.json');
  mkdirSync(dirname(settingsPath), {recursive: true});
  writeFileSync(settingsPath, JSON.stringify({
    version: 1, goal: 12, aiModel: 'legacy-model', syncHour: 7,
    platforms: {wechat: {appid: 'wx-legacy', secret: 's3cret'}, 小红书: {appid: 'x'}}
  }), 'utf8');
  const tolerant = await json('/api/settings');
  assert.equal(tolerant.status, 200, '带历史键的设置应能读取：' + JSON.stringify(tolerant.body));
  assert.equal(tolerant.body.goal, 12, '月目标不能被静默重置');
  assert.equal(tolerant.body.aiModel, 'legacy-model', '全局模型不能被静默重置');
  assert.equal(tolerant.body.platforms?.['公众号']?.appid, 'wx-legacy', '英文键 wechat 的凭据要归一化成公众号');
  assert.equal(tolerant.body.platforms?.['公众号']?.configured, true);
  ok('历史英文键 settings 读取不丢配置（回归）');

  // 6n-7. 回归：limit 传垃圾值不能让只读接口 500（NaN 绑进 LIMIT ? 会 datatype mismatch）
  const newsBadLimit = await json('/api/news?limit=abc');
  assert.equal(newsBadLimit.status, 200, '/api/news?limit=abc 应回落到默认值：' + JSON.stringify(newsBadLimit.body));
  assert.ok(Array.isArray(newsBadLimit.body.days), '/api/news 应返回 days 数组');
  const searchBadLimit = await json('/api/search?q=' + encodeURIComponent('笔记') + '&limit=abc');
  assert.equal(searchBadLimit.status, 200, '/api/search?limit=abc 应回落到默认值：' + JSON.stringify(searchBadLimit.body));
  ok('limit 传垃圾值不会 500（回归）');

  // 6n-8. 传输层：/api/data 必须支持 gzip（部署模式没有 nginx，压缩只能在服务里做）
  const gzRes = await fetch(base + '/api/data', {headers: {'accept-encoding': 'gzip'}});
  assert.equal(gzRes.status, 200);
  assert.equal(gzRes.headers.get('content-encoding'), 'gzip', '/api/data 应按 accept-encoding 压缩');
  const gzBody = await gzRes.json();
  assert.ok(Array.isArray(gzBody.posts) && gzBody.posts.length, '压缩后的响应仍应是完整 JSON');
  const plainRes = await fetch(base + '/api/data', {headers: {'accept-encoding': 'identity'}});
  assert.equal(plainRes.headers.get('content-encoding'), null, '不声明 gzip 时不能压缩');
  ok('大响应按 accept-encoding 压缩（回归）');

  // 6n-9. /api/version 是轻量指纹：只 walk + stat，不读全库正文
  const verA = await json('/api/version');
  assert.equal(verA.status, 200);
  assert.equal(typeof verA.body.v, 'number', '/api/version 的 v 应为数字');
  assert.ok(verA.body.files > 0, '/api/version 应报文件数');

  // 6n-10. /api/data 的形状是前端的唯一入口：字段少一个就是白屏或写回失效，
  // 而 verify 只用正则读源码，改坏形状没人拦。
  const shape = await json('/api/data?fresh');
  assert.equal(shape.status, 200);
  for (const k of ['snapshot', 'posts', 'postContent', 'notes', 'seedIdeas', 'seedDrafts', 'concepts', 'files', 'figures', 'mtimes', 'settings', 'meta']) {
    assert.ok(k in shape.body, `/api/data 缺少字段 ${k}：${Object.keys(shape.body)}`);
  }
  assert.equal(typeof shape.body.meta?.counts, 'object', 'meta.counts 必须是各模块篇数（首页进度条靠它）');
  assert.ok(!('vault' in (shape.body.meta || {})), '/api/data 的 meta 不能带出 vault 绝对路径');
  assert.ok(Array.isArray(shape.body.posts) && Array.isArray(shape.body.notes));
  assert.equal(typeof shape.body.mtimes, 'object', 'mtimes 必须是 id → mtime 的对象（写回乐观锁靠它）');
  for (const [id, rel] of Object.entries(shape.body.files)) {
    assert.match(id, /^(post|note|personal|idea|draft):/, `files 的 key 必须是带类型前缀的 id：${id}`);
    assert.equal(typeof rel, 'string', `files['${id}'] 必须是相对路径字符串`);
    assert.ok(!rel.includes('\\'), `files 里必须是 posix 相对路径：${rel}`);
    assert.ok(rel.length > 0 && !rel.startsWith('/') && !/^[A-Za-z]:/.test(rel), `files 里必须是库内相对路径：${rel}`);
  }
  assert.ok(!JSON.stringify(shape.body).includes(ROOT), '/api/data 不能带出服务器绝对路径');
  ok('/api/data 字段契约（形状 / 前缀 / 相对路径）');

  // 6o. 失败路径的契约：非 2xx 必须带中文 {error}，前端才有话可说（sync.js 现在会读它）
  const noAi = await json('/api/ai/ask', {method: 'POST', body: {question: '测试'}});
  assert.ok(noAi.status >= 400, '未配置 AI 时 /api/ai/ask 不应返回成功：' + JSON.stringify(noAi.body));
  assert.equal(typeof noAi.body.error, 'string');
  assert.ok(noAi.body.error.length >= 4, '失败响应必须带可读原因：' + JSON.stringify(noAi.body));
  ok('失败响应带可读原因（回归）');

  // 6n-8. 回归：fm id 重复（Obsidian「制作副本」/ Syncthing 冲突副本会保留 id:）
  // 原来 readVault 不去重 → files['idea:'+id] 被覆盖、INSERT 撞主键、/api/data 直接 500
  writeFileSync(join(vault, '04-选题池/重复 id A.md'), '---\nid: dup-1\ntitle: 重复 id A\n---\nA\n', 'utf8');
  writeFileSync(join(vault, '04-选题池/重复 id B.md'), '---\nid: dup-1\ntitle: 重复 id B\n---\nB\n', 'utf8');
  const dupId = await json('/api/data?fresh');
  assert.equal(dupId.status, 200, '重复 fm id 不能让 /api/data 500：' + JSON.stringify(dupId.body));
  const dupIdeas = (dupId.body.seedIdeas || []).filter(i => String(i.title).startsWith('重复 id '));
  assert.equal(dupIdeas.length, 2, '两份同 id 的选题都要保留：' + JSON.stringify(dupIdeas));
  assert.notEqual(dupIdeas[0].id, dupIdeas[1].id, '重复 id 必须去重成两个不同的 id');
  for (const i of dupIdeas) assert.ok(dupId.body.files['idea:' + i.id], '去重后两份都要能写回：' + i.id);
  rmSync(join(vault, '04-选题池/重复 id A.md'), {force: true});
  rmSync(join(vault, '04-选题池/重复 id B.md'), {force: true});
  ok('fm id 重复不会 500 且两份都可读写（回归）');

  // 6n-9. 回归：快照缓存窗口里文件被外部删/改名，GET /api/data 不能因 statSync ENOENT 变 500
  const cacheRel = '05-方法库/01-流程/缓存窗口回归.md';
  writeFileSync(join(vault, cacheRel), '---\ntags: [回归]\n---\n缓存窗口\n', 'utf8');
  const cacheFresh = await json('/api/data?fresh');
  assert.equal(cacheFresh.status, 200);
  rmSync(join(vault, cacheRel));
  const cacheAfter = await json('/api/data');
  assert.equal(cacheAfter.status, 200, '缓存窗口内文件消失不能让 /api/data 500：' + JSON.stringify(cacheAfter.body));
  ok('快照缓存窗口内文件被删不会 500（回归）');

  // 6n-10. 回归：新建请求重试（响应丢了）不能写出第二份「标题 2.md」
  const rid = 'e2e-rid-' + Date.now();
  const idem1 = await put('/api/draft', {title: 'e2e 幂等草稿', body: 'x', requestId: rid});
  const idem2 = await put('/api/draft', {title: 'e2e 幂等草稿', body: 'x', requestId: rid});
  assert.equal(idem1.status, 201);
  assert.equal(idem2.status, 200, '同一 requestId 的重试应回 200 复用：' + JSON.stringify(idem2.body));
  assert.equal(idem2.body.path, idem1.body.path, '同一 requestId 必须复用第一次的文件');
  assert.ok(!existsSync(join(vault, '03-创作台/e2e 幂等草稿 2.md')), '重试不能多写一份孤儿文件');
  ok('新建请求带 requestId 时幂等（回归）');

  // 6o. auth.json 损坏必须拒绝启动，绝不能降级成「未开启登录」
  const badAuthDir = join(tmp, 'auth-bad');
  mkdirSync(badAuthDir, {recursive: true});
  const badAuthFile = join(badAuthDir, 'auth.json');
  writeFileSync(badAuthFile, '{oops truncated');
  const badPort = await freePort();
  const badChild = spawn(process.execPath, [join(ROOT, 'server/index.mjs')], {
    env: {
      ...process.env, VAULT_DIR: vault, DATA_DIR: join(tmp, 'data-bad'), PORT: String(badPort),
      HOST: '127.0.0.1', VAULT_GIT: '0', NEWS_CRON: '0', PLATFORM_SYNC_CRON: '0',
      DASHBOARD_PASSWORD: '', AUTH_FILE: badAuthFile, API_TOKEN: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let badLog = '';
  badChild.stdout.on('data', d => { badLog += d; });
  badChild.stderr.on('data', d => { badLog += d; });
  const badCode = await new Promise(res => {
    badChild.once('exit', c => res(c));
    setTimeout(() => { badChild.kill(); res('timeout'); }, 8000);
  });
  assert.notEqual(badCode, 0, 'auth.json 损坏时应拒绝启动，实际退出码 ' + badCode);
  assert.match(badLog, /auth\.json/, '日志应说明 auth.json 有问题');
  ok('auth.json 损坏时拒绝启动，不降级成无鉴权（回归）');

  // 6p. 请求体上限 / 类型 / 静态托管：三条都出过真实事故，却一条回归用例都没有。
  // MAX_BODY 的两处 413 注释各记录过一次「客户端只拿到连接重置」；
  // 静态托管里的 login.html 必须公开、未登录要 302 回登录页、serveStatic 的穿越修复（实测可利用）也没人守。
  const edgePort = await freePort();
  const edgeBase = `http://127.0.0.1:${edgePort}`;
  const staticDir = join(tmp, 'static');
  mkdirSync(staticDir, {recursive: true});
  writeFileSync(join(staticDir, 'login.html'), '<!doctype html><title>login</title>');
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>app</title>');
  const edgeChild = spawn(process.execPath, [join(ROOT, 'server/index.mjs')], {
    env: {
      ...process.env, VAULT_DIR: vault, DATA_DIR: join(tmp, 'data-edge'), PORT: String(edgePort),
      HOST: '127.0.0.1', VAULT_GIT: '0', NEWS_CRON: '0', PLATFORM_SYNC_CRON: '0',
      MAX_BODY: '1024', STATIC_DIR: staticDir,
      // 这里要同时覆盖「有鉴权时的静态托管」和「过了鉴权之后的 413/415」：密码开登录，token 走脚本通道
      DASHBOARD_PASSWORD: 'e2e-edge-pass', AUTH_FILE: '', API_TOKEN: 'edge-token'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let edgeLog = '';
  edgeChild.stdout.on('data', d => { edgeLog += d; });
  edgeChild.stderr.on('data', d => { edgeLog += d; });
  try {
    await waitReady(edgeBase);
    const authH = {authorization: 'Bearer edge-token'};
    // 413：超限必须回一个 413（不是连接重置），且连接被 drain 干净
    const huge = await fetch(edgeBase + '/api/settings', {method: 'PUT',
      headers: {...authH, 'content-type': 'application/json'}, body: JSON.stringify({goal: 1, pad: 'x'.repeat(4000)})});
    assert.equal(huge.status, 413, '超过 MAX_BODY 应回 413，实际 ' + huge.status);
    // 415：JSON 接口收到别的 content-type
    const wrongType = await fetch(edgeBase + '/api/settings', {method: 'PUT',
      headers: {...authH, 'content-type': 'text/plain'}, body: 'goal=1'});
    assert.equal(wrongType.status, 415, '非 JSON content-type 应 415，实际 ' + wrongType.status);
    // 静态托管：login.html / avatar 之外的资源都要登录
    const loginPage = await fetch(edgeBase + '/login.html');
    assert.equal(loginPage.status, 200, 'login.html 必须公开，实际 ' + loginPage.status);
    // 直接打开页面（Accept 含 text/html）→ 302 到 login.html 并带上 next=原路径；静态资源仍 401
    const rootPage = await fetch(edgeBase + '/', {headers: {accept: 'text/html'}, redirect: 'manual'});
    assert.equal(rootPage.status, 302, '未登录访问首页应 302 到登录页，实际 ' + rootPage.status);
    assert.match(rootPage.headers.get('location') || '', /^\/login\.html\?next=/, '302 目标应是 login.html?next=');
    const assetPage = await fetch(edgeBase + '/assets/x.js', {headers: {accept: 'text/html'}, redirect: 'manual'});
    assert.equal(assetPage.status, 401, '静态资源未登录应 401，不能回 HTML，实际 ' + assetPage.status);
    // 穿越：`..\dist2\x.js` 曾被当成相对路径解析到 STATIC_DIR 外面
    for (const bad of ['/..%5Cdist2/x.js', '/assets/../../secret.js']) {
      const r = await fetch(edgeBase + bad, {headers: authH});
      assert.ok(r.status === 404 || r.status === 302, `静态穿越必须挡掉「${bad}」，实际 ${r.status}`);
    }
    // %2e%2e 会被 WHATWG URL 解析器先折叠掉（落到 /etc/passwd，没有扩展名 → SPA 回退给 index.html），
    // 关键是绝不能真的读到 STATIC_DIR 之外的内容。
    const dotdot = await fetch(edgeBase + '/%2e%2e/%2e%2e/etc/passwd', {headers: authH});
    assert.ok(!/^root:/m.test(await dotdot.text()), '不能读到站点目录外的文件内容');
    ok('请求体过大 413 / content-type 415 / 静态托管公开与穿越（回归）');
  } finally {
    edgeChild.kill();
  }

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
      // 与登录会话并存：curl / 脚本用它，浏览器用 Cookie（compose 里由 API_TOKEN 转发）
      API_TOKEN: 't0k'
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

  // API_TOKEN：非浏览器客户端（curl / 脚本）用 Bearer 直连。compose 曾经漏转发这个变量，
  // 用户在 .env 里设了也永远 401——没有用例的话这条路径会再次静默坏掉。
  assert.equal((await ajson('/api/data', {headers: {authorization: 'Bearer t0k'}})).status, 200, 'API_TOKEN 应放行 /api/data');
  assert.equal((await ajson('/api/data', {headers: {authorization: 'Bearer nope'}})).status, 401, '错误 token 必须 401');
  assert.equal((await ajson('/api/data')).status, 401, '既没有 token 也没有 Cookie 时仍要 401');
  ok('API_TOKEN 放行 Bearer 请求，且不削弱 Cookie 鉴权');


  // ───────────────────────── AI 链路（本地假网关，不联网） ─────────────────────────
  // 线上踩过的问题都不是「模型答得不好」，而是形状/异常处理：回复是散文 → 全局 500；
  // 键名被翻成中文 → 接口 200 但结果为空；embedding 不存在 → 用户看不懂报错；
  // 日报综述写成空段落。这些只有用假网关把「坏回复」固定住才能回归。
  const mockPort = await freePort();
  const seen = {ideasFirst: 0, models: 0, gemini: null};
  const mockReply = body => {
    const msgs = body.messages || [];
    const last = String(msgs[msgs.length - 1]?.content || '');
    const all = msgs.map(m => String(m.content || '')).join('\n');
    // 1) 综述（纯文本请求）：故意带 Markdown 标题行，检验 cleanDigest
    if (last.includes('写成一段综述')) return '## 本期 AI 动态综述\n\n**MOCK 综述**：智能体产品密集发布。';
    // 2) 主题分组（Markdown 请求）
    if (last.includes('## 主题名')) return '## 智能体产品\n- 假条目一\n## 模型发布\n- 假条目二';
    // 3) 选题：第一次故意回散文（触发 JSON 修复），修复时回英文键 JSON
    if (all.includes('挖 3 个值得写的选题') || all.includes('从热点里挑 3 个')) {
      const repairing = msgs.some(m => m.role === 'assistant');
      if (!repairing) return '好的，我给你三个选题：一、卡片系统；二、复盘；三、标签。';
      return JSON.stringify({ideas: [
        {title: 'MOCK 选题一', platform: '小红书', priority: '高', note: '理由一', sourceTitles: ['假条目一']},
        {title: 'MOCK 选题二', platform: 'B站', priority: '中', note: '理由二', sourceTitles: []},
        {title: 'MOCK 选题三', platform: '公众号', priority: '低', note: '理由三', sourceTitles: []}
      ]});
    }
    // 4) 笔记打标签：故意用中文键名，检验 pickKey 兜底
    if (all.includes('话题标签')) return JSON.stringify({标签: ['MOCK标签', '#假话题'], 摘要: 'MOCK 摘要一句话。'});
    // 5) 网页分析
    if (all.includes('分析这个网页')) return JSON.stringify({summary: 'MOCK 网页摘要', keyPoints: ['要点一'], tags: ['MOCK网页'], title: 'MOCK 标题'});
    // 6) 问答
    return 'MOCK 回答：先清空收件箱，再写复盘。';
  };
  const mock = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (req.url === '/feed.xml') {
      res.writeHead(200, {'content-type': 'application/rss+xml'});
      return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>mock</title>`
        + `<item><title>假条目一</title><link>https://example.com/a</link><guid>a</guid><description>d1</description></item>`
        + `<item><title>假条目二</title><link>https://example.com/b</link><guid>b</guid><description>d2</description></item>`
        + `</channel></rss>`);
    }
    if (req.url === '/v1/models') {
      seen.models++;
      res.writeHead(200, {'content-type': 'application/json'});
      return res.end(JSON.stringify({data: [{id: 'mock-chat'}, {id: 'mock-slow'}, {id: 'cn:其它模型'}]}));
    }
    // Gemini 的 embedding 接口（batchEmbedContents）：形状与 OpenAI 完全不同，
    // 这里把收到的请求记下来，用例才能断言「客户端真的按 Gemini 格式发的」。
    if (String(req.url).includes(':batchEmbedContents')) {
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      const first = body.requests?.[0] || {};
      seen.gemini = {
        key: req.headers['x-goog-api-key'] || '',
        n: (body.requests || []).length,
        model: first.model || '',
        taskType: first.taskType || '',
        parts: first.content?.parts?.[0]?.text || ''
      };
      const vec = new Array(8).fill(0.3536); // 8 维单位向量：任意两条都相似，保证 relate 有边
      res.writeHead(200, {'content-type': 'application/json'});
      return res.end(JSON.stringify({embeddings: (body.requests || []).map(() => ({values: vec}))}));
    }
    if (req.url === '/v1/embeddings') {  // 这个网关没有 embedding，和现场一致
      res.writeHead(404, {'content-type': 'text/plain'});
      return res.end('404 page not found');
    }
    if (req.url === '/v1/chat/completions') {
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      // 慢模型：取消用例要证明「abort 掉的是正在等的这次调用」，所以必须真有一个卡 3 秒的回复
      if (body.model === 'mock-slow') await new Promise(r => setTimeout(r, 3000));
      if (res.writableEnded || res.destroyed) return; // 客户端已经 abort
      res.writeHead(200, {'content-type': 'application/json'});
      return res.end(JSON.stringify({choices: [{message: {content: mockReply(body)}}]}));
    }
    res.writeHead(404, {'content-type': 'text/plain'});
    res.end('404 page not found');
  });
  await new Promise(r => mock.listen(mockPort, '127.0.0.1', r));
  const aiBase = `http://127.0.0.1:${await freePort()}`;
  // 服务启动即建索引，vault 必须在 spawn 之前就存在（假网关用自己的副本，不污染上面的用例）
  const aiVault = join(tmp, 'ai-vault');
  cpSync(vault, aiVault, {recursive: true, force: true});
  aiChild = spawn(process.execPath, [join(ROOT, 'server/index.mjs')], {
    env: {
      ...process.env,
      VAULT_DIR: join(tmp, 'ai-vault'),
      DATA_DIR: join(tmp, 'ai-data'),
      PORT: String(new URL(aiBase).port),
      HOST: '127.0.0.1',
      VAULT_GIT: '0',
      NEWS_CRON: '0',
      PLATFORM_SYNC_CRON: '0',
      DASHBOARD_PASSWORD: '',
      AUTH_FILE: '',
      API_TOKEN: '',
      AI_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
      AI_API_KEY: 'mock-key',
      AI_MODEL: 'mock-chat',
      EMBED_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
      EMBED_MODEL: 'mock-embed',
      NEWS_SOURCE: `http://127.0.0.1:${mockPort}/feed.xml`,
      NEWS_HOUR: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  aiChild.stdout.on('data', d => { logs += d; });
  aiChild.stderr.on('data', d => { logs += d; });
  await waitReady(aiBase);
  // Gemini 协议的第四个实例：同一套 chat 假网关，embedding 换成 Gemini 格式（默认端口另开）。
  const gemBase = `http://127.0.0.1:${await freePort()}`;
  const gemVault = join(tmp, 'gem-vault');
  cpSync(vault, gemVault, {recursive: true, force: true});
  gemChild = spawn(process.execPath, [join(ROOT, 'server/index.mjs')], {
    env: {
      ...process.env,
      VAULT_DIR: gemVault,
      DATA_DIR: join(tmp, 'gem-data'),
      PORT: String(new URL(gemBase).port),
      HOST: '127.0.0.1',
      VAULT_GIT: '0',
      NEWS_CRON: '0',
      PLATFORM_SYNC_CRON: '0',
      DASHBOARD_PASSWORD: '',
      AUTH_FILE: '',
      API_TOKEN: '',
      AI_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
      AI_API_KEY: 'mock-key',
      AI_MODEL: 'mock-chat',
      // 只给 Gemini 的凭据：embedEnabled 必须认 EMBED_API_KEY，不能悄悄借 chat 的 key
      EMBED_PROTOCOL: 'gemini',
      EMBED_BASE_URL: `http://127.0.0.1:${mockPort}/v1beta`,
      EMBED_API_KEY: 'mock-gem-key',
      EMBED_MODEL: 'gemini-embedding-001'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  gemChild.stdout.on('data', d => { logs += d; });
  gemChild.stderr.on('data', d => { logs += d; });
  await waitReady(gemBase);
  const gjson = async (path, init) => {
    const res = await fetch(gemBase + path, init);
    return {status: res.status, body: await res.json().catch(() => null)};
  };
  const gpost = (path, data) => gjson(path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(data || {})});
  const gwaitJob = async id => {
    for (let i = 0; i < 100; i++) {
      const r = await gjson('/api/ai/jobs/' + id);
      if (r.body?.status && r.body.status !== 'running') return r.body;
      await new Promise(r2 => setTimeout(r2, 100));
    }
    return {status: 'timeout'};
  };

  const ajson2 = async (path, init) => {
    const res = await fetch(aiBase + path, init);
    const body = await res.json().catch(() => null);
    return {status: res.status, body};
  };
  const apost = (path, data) => ajson2(path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(data || {})});
  const waitJob = async id => {
    for (let i = 0; i < 100; i++) {
      const r = await ajson2('/api/ai/jobs/' + id);
      if (r.body?.status && r.body.status !== 'running') return r.body;
      await new Promise(r2 => setTimeout(r2, 100));
    }
    return {status: 'timeout'};
  };

  const aiInfo = await ajson2('/api/ai/info');
  assert.equal(aiInfo.status, 200);
  assert.equal(aiInfo.body.enabled, true, '配置了 AI_API_KEY 就应视为可用');
  const aiModels = await ajson2('/api/ai/models');
  assert.equal(aiModels.status, 200);
  assert.ok(aiModels.body.models.some(m => m.id === 'mock-chat'), '模型列表应来自网关 /models');
  ok('GET /api/ai/info|models 反映网关配置');

  const aiNote = '05-方法库/01-流程/每周整理流程.md';
  const aiRange = await apost('/api/ai/analyze', {paths: [aiNote]});
  assert.equal(aiRange.status, 202);
  const aiJob = await waitJob(aiRange.body.job.id);
  assert.equal(aiJob.status, 'done', '分析任务应完成：' + JSON.stringify(aiJob.error || ''));
  assert.equal(aiJob.result[0].written, true, '应写回笔记：' + JSON.stringify(aiJob.result[0].error || ''));
  const aiFile = readFileSync(join(aiVault, aiNote), 'utf8');
  assert.match(aiFile, /MOCK标签/, '中文键名的 tags 也要落到 frontmatter');
  assert.match(aiFile, /MOCK 摘要一句话/, '中文键名的 summary 也要写回');
  ok('POST /api/ai/analyze：散文不致命、中文键名也能落盘（pickKey 兜底）');

  const aiIdeas = await apost('/api/ai/ideas', {paths: [aiNote]});
  assert.equal(aiIdeas.status, 200);
  assert.equal(aiIdeas.body.candidates.length, 3, '散文回复后应经 JSON 修复拿到 3 条候选');
  assert.equal(aiIdeas.body.candidates[0].title, 'MOCK 选题一');
  ok('POST /api/ai/ideas：散文 → JSON 修复链路可用，不再 500');

  const aiAsk = await apost('/api/ai/ask', {question: '每周整理流程做了什么？'});
  assert.equal(aiAsk.status, 200);
  assert.match(aiAsk.body.answer, /MOCK 回答/);
  ok('POST /api/ai/ask 返回回答');

  // 取消：慢网关上一个任务能耗几分钟，而且期间所有 AI / 日报 / 平台同步都是 409。
  // 没有取消入口时用户只能等超时或重启容器，所以这条路径必须有回归。
  const slowT0 = Date.now();
  const slowJob = await apost('/api/ai/analyze', {paths: ['05-方法库/02-模板/卡片模板.md'], model: 'mock-slow'});
  assert.equal(slowJob.status, 202, '用 mock-slow 开任务：' + JSON.stringify(slowJob.body || {}));
  await new Promise(r => setTimeout(r, 300)); // 让第一张卡片真的发出去
  const cancelRes = await apost('/api/ai/jobs/' + slowJob.body.job.id + '/cancel');
  assert.equal(cancelRes.status, 200, '取消接口应可用：' + JSON.stringify(cancelRes.body || {}));
  assert.equal(cancelRes.body.ok, true);
  const cancelled = await waitJob(slowJob.body.job.id);
  assert.equal(cancelled.status, 'error', '取消后任务应收成 error：' + JSON.stringify(cancelled));
  assert.match(String(cancelled.error), /任务已取消/);
  assert.ok(Date.now() - slowT0 < 2500, '取消应立刻中断模型请求，不该等满假网关的 3s');
  assert.equal((await apost('/api/ai/jobs/' + slowJob.body.job.id + '/cancel')).body.ok, false, '已结束的任务取消应返回 ok:false');
  assert.equal((await apost('/api/ai/jobs/nope/cancel')).status, 404, '未知任务应 404');
  ok('POST /api/ai/jobs/:id/cancel 能打断正在等的模型调用');

  // threshold 只认真数字：Number(null) / Number('') / Number(false) 都是 0，
  // 阈值 0 时每一对节点都满足 sim >= 0，400 条垃圾边会覆盖掉正确的边。
  for (const bad of [null, '', false, 0]) {
    const r = await apost('/api/ai/relate', {threshold: bad});
    assert.equal(r.status, 400, `threshold=${JSON.stringify(bad)} 应拒绝`);
  }
  ok('relate 的 threshold 拒收 null / 空串 / false / 0（Number 强转陷阱）');

  const aiRelate = await apost('/api/ai/relate', {});
  assert.equal(aiRelate.status, 202, 'relate 是后台任务');
  const relateJob = await waitJob(aiRelate.body.job.id);
  assert.equal(relateJob.status, 'error');
  assert.match(relateJob.error, /\/embeddings/, '缺少 embedding 时要给出可操作的报错');
  ok('embedding 不存在时 relate 的报错指向 /embeddings');

  const aiNews = await apost('/api/news/refresh', {force: true});
  assert.equal(aiNews.status, 200, '日报应生成：' + JSON.stringify(aiNews.body));
  assert.ok(String(aiNews.body.digest).length > 5, '综述不能是空的');
  assert.ok(aiNews.body.topics >= 1, 'Markdown 主题分组应被解析出来');
  const newsFile = readFileSync(join(aiVault, '00-AI热点', aiNews.body.date + '.md'), 'utf8');
  assert.match(newsFile, /MOCK 综述/);
  assert.doesNotMatch(newsFile, /^#{1,6}\s*本期/m, '综述里的 Markdown 标题应被清掉');
  ok('POST /api/news/refresh：综述非空、主题分组落到日报，Markdown 包装被清理');

  // ── Gemini embedding 协议 ──
  // 客户端的形状错不会报错，只会「静默拿到 0 条向量」，所以这里断请求本身。
  const gemInfo = await gjson('/api/ai/info');
  assert.equal(gemInfo.body.embed.enabled, true, 'Gemini 有 EMBED_API_KEY + EMBED_MODEL 就该可用');
  assert.equal(gemInfo.body.embed.protocol, 'gemini');
  const gemRelate = await gpost('/api/ai/relate', {threshold: 0.9});
  assert.equal(gemRelate.status, 202, 'Gemini 协议下 relate 应能开任务：' + JSON.stringify(gemRelate.body || {}));
  const gemJob = await gwaitJob(gemRelate.body.job.id);
  assert.equal(gemJob.status, 'done', 'Gemini relate 应完成：' + JSON.stringify(gemJob.error || ''));
  assert.ok((gemJob.result?.edges?.length || 0) > 0, '固定向量应产出语义边（cosine 必须认 Float32Array）：' + JSON.stringify(gemJob.result || {}).slice(0, 200));
  assert.equal(seen.gemini.key, 'mock-gem-key', 'Gemini 的 key 走 x-goog-api-key 头');
  assert.equal(seen.gemini.model, 'models/gemini-embedding-001', 'model 要用 models/ 前缀的全名');
  assert.equal(seen.gemini.taskType, 'RETRIEVAL_DOCUMENT', '文档入库用 RETRIEVAL_DOCUMENT');
  assert.ok(seen.gemini.n > 0 && String(seen.gemini.parts).length > 0, '每条请求要带 content.parts[0].text');
  // 问答的查询向量必须换 taskType：Gemini 的文档/查询是两个向量空间，混用会明显掉召回
  const gemAsk = await gpost('/api/ai/ask', {question: '每周整理流程做了什么？'});
  assert.equal(gemAsk.status, 200, 'Gemini 配置下问答应可用：' + JSON.stringify(gemAsk.body || {}));
  assert.equal(seen.gemini.taskType, 'RETRIEVAL_QUERY', '检索查询用 RETRIEVAL_QUERY');
  ok('Gemini embedding：batchEmbedContents 形状、taskType 与 key 头都对，relate/ask 打通');

  mock.close();

  console.log(`\n全部通过（${passed} 项）。`);
} catch (e) {
  console.error('\n未通过：', e.message);
  if (logs) console.error('\n--- note-api 输出 ---\n' + logs);
  process.exitCode = 1;
} finally {
  child?.kill();
  authChild?.kill();
  aiChild?.kill();
  gemChild?.kill();
  try { mock?.close(); } catch { /* 已关闭 */ }
  // Windows 上 index.sqlite 可能还被服务进程占着：等它退出再清理。
  await Promise.all([child, authChild, aiChild, gemChild].filter(Boolean).map(c => new Promise(res => {
    if (c.exitCode != null) return res();
    c.once('exit', res);
    setTimeout(res, 3000);
  })));
  rmSync(tmp, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
}
