#!/usr/bin/env node
// 校验：skill 格式、导入脚本、当前数据结构、页面素材。
// 用法：npm run verify              日常检查
//       npm run verify -- --release  发布前检查（另外要求仓库地址占位符已替换）
import {readFileSync, existsSync, mkdtempSync, rmSync} from 'node:fs';
import {execSync} from 'node:child_process';
import {join, resolve, dirname, basename} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = process.argv.includes('--release');
const errors = [], warnings = [];
const ok = msg => console.log('  ✓ ' + msg);
const fail = msg => errors.push(msg);

// 1. Skill
console.log('Skill');
const skillDir = join(ROOT, 'skills/neural-creator-dashboard');
const skillFile = join(skillDir, 'SKILL.md');
if (!existsSync(skillFile)) fail('缺少 skills/neural-creator-dashboard/SKILL.md');
else {
  const text = readFileSync(skillFile, 'utf8');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) fail('SKILL.md 缺少 YAML frontmatter');
  else {
    const field = k => (m[1].match(new RegExp(`^${k}:\\s*(.*)$`, 'm')) || [])[1]?.trim();
    const name = field('name'), desc = field('description');
    if (!name) fail('SKILL.md 缺少 name');
    else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) fail(`name「${name}」只能用小写字母、数字和单个连字符，且不超过 64 个字符`);
    else if (name !== basename(skillDir)) fail(`name「${name}」必须与文件夹名「${basename(skillDir)}」一致`);
    else ok(`name：${name}`);
    if (!desc) fail('SKILL.md 缺少 description');
    else if (desc.length > 1024) fail(`description 超过 1024 个字符（${desc.length}）`);
    else ok(`description：${desc.length} 个字符`);
    if (!m[2].trim()) fail('SKILL.md 正文为空');
    else ok('正文存在');
  }
}
for (const f of ['skills/neural-creator-dashboard/SKILL.md', 'README.md', 'AGENTS.md', 'package.json']) {
  if (existsSync(join(ROOT, f)) && readFileSync(join(ROOT, f), 'utf8').includes('YOUR_GITHUB_USER')) {
    (release ? errors : warnings).push(`${f} 里还有仓库地址占位符 YOUR_GITHUB_USER${release ? '' : '（发布前替换）'}`);
  }
}

// 2. 数据结构
// allowEmptyPosts：纯笔记库（还没有作品）是允许的，只有示例数据为空才算错。
function check(m, label, {allowEmptyPosts = false} = {}) {
  const errs = [];
  for (const k of ['snapshot', 'posts', 'postContent', 'notes', 'seedIdeas', 'seedDrafts', 'concepts']) if (!(k in m)) errs.push(`缺少导出 ${k}`);
  if (errs.length) return errs;
  if (!m.posts.length) (allowEmptyPosts ? warnings : errs).push(`${label}：posts 为空${allowEmptyPosts ? '（纯笔记库，作品库会是空的）' : ''}`);
  for (const p of m.posts) {
    if (typeof p.id !== 'string' || !p.id) errs.push(`作品缺少 id：${p.title}`);
    if (!/^\d{4}-\d{2}-\d{2}/.test(p.date || '')) errs.push(`作品日期格式不对：${p.title}`);
    if (typeof p.views !== 'number') errs.push(`作品 views 必须是数字：${p.title}`);
    if (!m.postContent.some(c => c.title === p.title)) errs.push(`postContent 里找不到作品：${p.title}`);
  }
  if (new Set(m.posts.map(p => p.id)).size !== m.posts.length) errs.push('作品 id 有重复');
  // 导入脚本写「05-方法库 methods/」；手写数据时也用这个前缀。AI 热点日报与个人知识库走自己的目录。
  for (const n of m.notes) {
    const okPath = n.kind === 'news'
      ? /^00-AI热点\/.+\.md$/.test(n.path || '')
      : n.kind === 'personal'
        ? /^06-个人知识库\/.+/ .test(n.path || '')
        : /^05-方法库 methods\/[^/]+\/.+/.test(n.path || '');
    if (!okPath) errs.push(`笔记 path 格式不对：${n.title}`);
  }
  for (const i of m.seedIdeas) if (typeof i.id !== 'number' || !['待写', '待扩展', '已转草稿'].includes(i.status)) errs.push(`选题 id 须为数字、status 须为 待写/待扩展/已转草稿：${i.title}`);
  for (const d of m.seedDrafts) if (d.source != null && !m.seedIdeas.some(i => i.id === d.source)) errs.push(`草稿的来源选题不存在：${d.title}`);
  for (const c of m.concepts) if (!Array.isArray(c) || typeof c[0] !== 'string' || !Array.isArray(c[1])) errs.push('concepts 格式应为 [概念名, [关键词…]]');
  return errs;
}

console.log('导入脚本');
const tmp = mkdtempSync(join(tmpdir(), 'ncd-verify-'));
try {
  const out = join(tmp, 'data.js');
  execFileSync(process.execPath, [join(ROOT, 'scripts/import-notes.mjs'), '--vault', join(ROOT, 'examples/vault'), '--out', out], {stdio: 'pipe'});
  const m = await import(pathToFileURL(out).href);
  const errs = check(m, 'examples');
  if (errs.length) errs.forEach(e => fail('示例导入：' + e));
  else ok(`examples/vault → 作品 ${m.posts.length}、方法笔记 ${m.notes.length}、选题 ${m.seedIdeas.length}、草稿 ${m.seedDrafts.length}、概念 ${m.concepts.length}`);
} catch (e) {
  fail('导入脚本运行失败：' + (e.stderr?.toString() || e.message));
} finally {
  rmSync(tmp, {recursive: true, force: true});
}

console.log('当前数据');
// src/data/index.js 的结构是「有 my-data.local.js 就用它，否则用 sample.js」，这里复核实际生效的那一份。
const hasLocal = existsSync(join(ROOT, 'src/data/my-data.local.js'));
const source = hasLocal ? 'my-data.local.js' : 'sample.js';
{
  const errs = check(await import(pathToFileURL(join(ROOT, 'src/data', source)).href), source, {allowEmptyPosts: hasLocal});
  if (errs.length) errs.forEach(e => fail(`${source}：${e}`));
  else ok(`src/data/${source} 结构正确${hasLocal ? '（本机导入数据，不入库）' : '（虚构示例，未发现本机数据）'}`);
}

// 3. 核心动效：星核、六簇星团与活着的星穹背景是这个看板的核心，不能被删掉或改成静态
console.log('核心动效（星核与七簇星团）');
const home = readFileSync(join(ROOT, 'src/neural/Home.jsx'), 'utf8');
const graphSrc = readFileSync(join(ROOT, 'src/neural/graph.js'), 'utf8');
const cosmosSrc = readFileSync(join(ROOT, 'src/neural/Cosmos.jsx'), 'utf8');
const cssSrc = readFileSync(join(ROOT, 'src/neural/neural.css'), 'utf8');
const core = [
  ['星核（替代原光球）', /className="core-star"/],
  ['星核的日冕呼吸关键帧', /@keyframes coreBreathe[\s\S]*@keyframes corePulse/],
  ['星核向外飘散的星尘', /cs-dust/],
  ['每个模块一个星团画布', /MODULES\.map\(m => \{[\s\S]{0,700}className=\{`cluster [\s\S]{0,400}<canvas className="cl-canvas"/],
  ['星团星点逐帧绘制', /function drawCluster\([\s\S]*?arc\(x, y/],
  ['金色星座线与流动光粒', /pulseRefs\.current\[m\.id\]/],
  ['星核与星团的逐帧动画', /const step = now => \{[\s\S]*coreRef\.current\.style\.transform[\s\S]*el\.style\.transform/],
  ['动画循环防中断（先排下一帧、出错不停）', /const frame = now => \{ raf = requestAnimationFrame\(frame\); try \{ step\(now\); \}/],
  ['时间差不为负', /const dt = Math\.max\(0,/]
];
for (const [label, re] of core) if (!re.test(home) && !re.test(cssSrc)) fail(`Home.jsx / neural.css 缺少核心动效：${label}`); else ok(label);
// 星穹背景：程序化星云 + 星尘 + 流星，全部代码自绘，不用外部素材
const sky = [
  ['星穹背景画布', /className="cosmos"/],
  ['程序噪声星云', /function buildSky\([\s\S]*?fbm\(px/],
  ['抖动防色带', /抖动：抹掉渐变色带/],
  ['星光错相闪烁', /Math\.sin\(t \* s\.sp \+ s\.ph\)/],
  ['偶发流星', /meteors\.push\(\{/],
  ['星云缓慢漂移（CSS 关键帧，不占每帧预算）', /@keyframes nebDriftA[\s\S]*@keyframes nebDriftB/]
];
for (const [label, re] of sky) if (!new RegExp(re.source).test(cosmosSrc) && !new RegExp(re.source).test(cssSrc)) fail(`星穹背景缺少：${label}`); else ok(label);
// reskin v0 起所有画面都由代码自绘，页面里不应再出现 <video> 素材
if (/<video/.test(home) || /<video/.test(cosmosSrc)) fail('Home.jsx / Cosmos.jsx 不应再引用视频素材（reskin v0 已改为全代码自绘）');
else ok('零视频素材：星核、星团、星云全部代码自绘');
const modules = (graphSrc.match(/export const MODULES = \[([\s\S]*?)\n\];/) || [])[1] || '';
if ((modules.match(/\{id: '/g) || []).length !== 7) fail('graph.js 的 MODULES 应为 7 个模块（7 个星团）');
else ok('7 个模块 → 7 个星团');

// 3b. 七星座（v6.3 起，v7.0 加入第 7 个）：七个模块 = 七个真实星座，图形来自真实星表，逐帧只做贴图 + 主星闪烁
console.log('七星座（v7.0）');
const consSrc = readFileSync(join(ROOT, 'src/neural/constellations.js'), 'utf8');
const figs = [
  ['真实星座骨架表（d3-celestial · J2000 赤经赤纬）', /constellations\.lines\.json/],
  ['七个模块的星座映射（天蝎/双鱼/处女/射手/水瓶/仙女/猎户）', /天蝎座[\s\S]*双鱼座[\s\S]*处女座[\s\S]*射手座[\s\S]*水瓶座[\s\S]*仙女座[\s\S]*猎户座/],
  ['经典连线（逐段照抄，不自创）', /edges: \[\[0, 1\]/],
  ['烘焙：整幅离屏渲染，逐帧只贴图', /export function baked\(/],
  ['命中区按骨架外沿多边形（不是 bbox）', /export function hitOf\(/]
];
for (const [label, re] of figs) { if (!re.test(consSrc)) fail(`constellations.js 缺少：${label}`); else ok(label); }
const bandSrc = readFileSync(join(ROOT, 'src/neural/ConstellationBand.jsx'), 'utf8');
if (!/paintConstellation/.test(bandSrc)) fail('内页星座轨（ConstellationBand）没有复用星座画法');
else ok('内页星座轨复用同一套星座画法');
for (const f of ['src/neural/pages.jsx']) {
  const src = readFileSync(join(ROOT, f), 'utf8');
  if ((src.match(/<ConstellationBand/g) || []).length !== 5) fail(`${f} 的五个内页都应带星座轨`);
  else ok('作品库 / 创作台 / 选题池 / 知识库 / 方法库 五个内页都带星座轨');
}
if (!/from '\.\/constellations'/.test(home) || !/figData/.test(home) || !/drawCluster\(canvasRefs/.test(home)) fail('Home.jsx 没有用星座层渲染星团');
else ok('主视图星团层 = 七星座（烘焙 + 主星闪烁）');
for (const f of ['media/orb.mp4', 'media/jellyfish.mp4']) if (existsSync(join(ROOT, 'public', f))) warnings.push(`public/${f} 已不再被引用，可以删除（保留不影响）`);

// 3c. 登录页与会话鉴权
console.log('登录');
const loginSrc = existsSync(join(ROOT, 'public/login.html')) ? readFileSync(join(ROOT, 'public/login.html'), 'utf8') : '';
if (!loginSrc) fail('缺少 public/login.html');
else {
  if (!/<form/i.test(loginSrc) || !/\/api\/login/.test(loginSrc)) fail('login.html 必须包含登录表单并调用 /api/login');
  else ok('登录页表单与 /api/login');
  if (/<video/i.test(loginSrc) || /<img[^>]+src="https?:/i.test(loginSrc)) fail('login.html 不应引用视频或外部图片素材');
  else ok('登录页零视频 / 外部图片素材');
}
const serverSrc = readFileSync(join(ROOT, 'server/index.mjs'), 'utf8');
for (const [label, re] of [
  ['会话接口 /api/session', /p === '\/api\/session'/],
  ['登录接口 /api/login', /p === '\/api\/login'/],
  ['nginx 校验接口 /api/auth-check', /p === '\/api\/auth-check'/],
  ['HttpOnly 会话 Cookie', /HttpOnly; SameSite=Lax/],
  ['登录失败限流', /LOGIN_MAX/]
]) { if (!re.test(serverSrc)) fail(`note-api 缺少：${label}`); else ok(label); }
if (!/function bootstrapAuth/.test(serverSrc) || !/bootstrapAuth\(\)/.test(serverSrc)) fail('note-api 缺少 auth 自举（随机密码生成）');
else ok('note-api auth 自举（无 DASHBOARD_PASSWORD 时生成随机密码）');
const bootSrc = readFileSync(join(ROOT, 'src/neural/boot.js'), 'utf8');
if (!/\/api\/session/.test(bootSrc)) fail('boot.js 没有在取数前检查 /api/session');
else ok('boot.js 取数前检查登录状态');

// 3d. 一键部署：compose 用 GHCR 镜像（GitHub Actions 构建），镜像名与 workflow 一致
console.log('一键部署');
const composeSrc = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
const imageMatch = composeSrc.match(/image:\s*ghcr\.io\/([^\s:]+)/);
if (!imageMatch) {
  fail('compose 未使用 ghcr.io 镜像（部署模式为 GitHub Actions 构建后拉取）');
} else {
  // GHCR 镜像名小写；期望值 = 仓库 owner/名（从 git remote 推导，再小写比较）。
  // 非 git 目录（Release ZIP 下载）没有 remote：降级为 warning，不让 verify 崩溃。
  let repo = null;
  try {
    const remote = execSync('git remote get-url origin', {cwd: ROOT, encoding: 'utf8'}).trim();
    repo = (remote.match(/[/:]([^/]+\/[^/]+?)(?:\.git)?$/) || [])[1]?.toLowerCase();
  } catch { /* no .git — skip repo consistency check */ }
  if (repo == null) {
    warnings.push('非 git 目录（无 origin remote）：跳过 compose 镜像名一致性检查');
  } else if (imageMatch[1].toLowerCase() !== repo) {
    fail(`compose 镜像名 ${imageMatch[1]} 与仓库 ${repo} 不一致`);
  } else {
    ok(`compose 镜像 ghcr.io/${imageMatch[1]} 与仓库一致`);
  }
  const wf = readFileSync(join(ROOT, '.github/workflows/docker-image.yml'), 'utf8');
  if (!/IMAGE_NAME:\s*\$\{\{ github\.repository \}\}/.test(wf)) fail('workflow 未使用 github.repository 作为 IMAGE_NAME，镜像名易漂移');
  else ok('workflow 镜像名取自 github.repository');
}
const dockerfileSrc = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
if (!/FROM .* AS web/.test(dockerfileSrc) || !/npm run build/.test(dockerfileSrc) || !/COPY --from=web/.test(dockerfileSrc)) {
  fail('根 Dockerfile 不是多阶段构建（缺 web 阶段 / npm run build / COPY --from=web）');
} else ok('Dockerfile 多阶段：镜像内构建前端');
if (!/STATIC_DIR=\/app\/dist/.test(dockerfileSrc)) fail('Dockerfile 未设置 STATIC_DIR=（note-api 自托管前端）');
else ok('note-api STATIC_DIR 自托管前端');
if (/neural-auth|nginx\.conf/.test(composeSrc)) fail('compose 仍引用已移除的 auth 容器或 nginx.conf');
else ok('compose 无 auth 容器 / nginx 残留引用');
for (const f of ['deploy/.env.example', 'deploy/docker-compose.dev.yml']) {
  if (!existsSync(join(ROOT, f))) fail(`缺少 ${f}`);
}
const envSrc = readFileSync(join(ROOT, 'deploy/.env.example'), 'utf8');
if (/logs auth/.test(envSrc)) fail('.env.example 仍在引导查看已删除的 auth 容器日志');
else ok('.env.example 与单容器 compose 一致');

// 4. 页面与素材
console.log('页面与素材');
const theme = readFileSync(join(ROOT, 'src/neural/theme.js'), 'utf8');
const media = [...theme.matchAll(/asset\('(media\/[^']+)'\)/g)].map(x => x[1]);
const avatar = (readFileSync(join(ROOT, 'src/config.js'), 'utf8').match(/avatar:\s*'([^']+)'/) || [])[1];
const missing = [...new Set([...media, avatar])].filter(f => f && !existsSync(join(ROOT, 'public', f)));
for (const f of ['index.html']) if (!existsSync(join(ROOT, f))) missing.push(f);
if (missing.length) missing.forEach(f => fail('缺少文件：' + f));
else ok(`入口页面、${new Set(media).size} 个图片素材与头像都在（reskin v0 后已无视频素材）`);

// 5. 写回契约：前端节点 id 前缀、frontmatter 剥离、附件名必须与服务端一致。
// 这几条 bug 只存在于前端，test-api 只能打服务端接口，测不到，所以在源码层面钉住。
console.log('写回契约');
const wGraph = readFileSync(join(ROOT, 'src/neural/graph.js'), 'utf8');
const wMain = readFileSync(join(ROOT, 'src/neural/main.jsx'), 'utf8');
const wAnalysis = readFileSync(join(ROOT, 'src/neural/Analysis.jsx'), 'utf8');
const wServer = readFileSync(join(ROOT, 'server/index.mjs'), 'utf8');
// 服务端 noteNodeId() 给笔记/日报/知识库一律发 note: 前缀，前端自己拼 news: 会对不上 files 映射与 /api/note
const badNews = /'news:/.test(wGraph) || /'news:/.test(wMain);
if (badNews) fail('前端还在用 news: 前缀拼节点 id（服务端统一是 note:）');
else ok('节点 id 前缀与服务端 noteNodeId() 一致（日报也是 note:）');
// node.id 本身已带 note: 前缀，再拼一次会变成 note:note:n1，AI 面板永远匹配不到结果
if (/'note:'\s*\+\s*node\.id/.test(wAnalysis)) fail("Analysis.jsx 里仍在用 'note:' + node.id 拼 id（node.id 已带前缀）");
else ok('AI 面板按 node.id 直接匹配结果，没有重复拼前缀');
// /api/note 的 GET 返回整篇原文，PUT 的 body 只收正文：不剥离就会把 frontmatter 复制成两份
const noStrip = !/stripFrontmatter\(/.test(wMain) || !existsSync(join(ROOT, 'src/neural/mdfront.js'))
  || !/from '\.\/mdfront\.js'/.test(readFileSync(join(ROOT, 'src/neural/persist.js'), 'utf8'));
if (noStrip) fail('写回前必须用 src/neural/mdfront.js 的 stripFrontmatter 剥离 frontmatter（否则每保存一次多一份）');
else ok('写回前剥离 frontmatter（src/neural/mdfront.js，测试引同一份实现）');
// —— 界面契约：这几处都被真实 bug 踩过，改坏了要立刻红 ——
const noteModalSrc = readFileSync(join(ROOT, 'src/neural/NoteModal.jsx'), 'utf8');
if (/setBody\(\(b =>/.test(noteModalSrc) || !/setBody\(b => \(b \? b \+ '\\n' : ''\) \+ v\)/.test(noteModalSrc)) {
  fail('新建笔记插图时把箭头函数拼进了字符串（正文会被替换成函数源码）');
} else ok('新建笔记插图按函数回调追加正文');

const starSrc = readFileSync(join(ROOT, 'src/neural/StarCore.jsx'), 'utf8');
if (/avg > 1 \/ 62/.test(starSrc)) {
  fail('星核降档阈值 1/62 高于 60Hz 帧间隔（16.7ms），普通显示器会必然降两档');
} else ok('星核自适应降档阈值低于 60Hz 帧间隔');

const cbSrc = readFileSync(join(ROOT, 'src/neural/ConstellationBand.jsx'), 'utf8');
if (/<button[^>]*role="listitem"/.test(cbSrc)) {
  fail('星座轨按钮上的 role="listitem" 会覆盖按钮语义');
} else ok('星座轨按钮保留了按钮语义');

// 所有直连写接口（不经过 persist.flushKey）都要登记「本页写的」，否则自动刷新会误报外部改动。
// 按文件检查：出现写方法的文件必须出现 markSelfWrite()，新增写接口时忘了登记会让这里变红。
const WRITE_FILES = ['main.jsx', 'NoteModal.jsx', 'pages.jsx', 'Assistant.jsx', 'Analysis.jsx', 'SettingsPanel.jsx', 'persist.js'];
const unmarked = WRITE_FILES.filter(f => {
  const src = readFileSync(join(ROOT, 'src/neural', f), 'utf8');
  const writes = (src.match(/method: '(?:PUT|POST|DELETE)'/g) || []).length;
  return writes > 0 && !/markSelfWrite\(\)/.test(src);
});
if (!/export function markSelfWrite\(/.test(readFileSync(join(ROOT, 'src/neural/persist.js'), 'utf8'))) {
  fail('persist.js 缺少 markSelfWrite()');
} else if (unmarked.length) fail('这些文件有直连写接口但没登记本页写入：' + unmarked.join('、'));
else ok('直连写盘都登记了本页写入，自动刷新不会误报外部改动');

// 登记自写盘之后轮询不会再因这次写盘刷新数据，所以这几条路径必须自己拉一次。
if (!/persist\.refreshData\(\)/.test(wMain)) {
  fail('阅读弹窗保存后没有调用 persist.refreshData()（登记自写盘后不会再被轮询刷新，会看到旧正文）');
} else ok('阅读弹窗保存后自己刷新了数据');
if (!/name: posix\.basename\(rel\)/.test(wServer)) fail('附件上传返回的 name 必须等于落盘文件名（posix.basename(rel)）');
else ok('附件上传返回的 name 就是落盘文件名');

// —— 健壮性契约（第四轮审查）——
// 弹窗统一走 useModal：Esc 关闭、Tab 不跑出弹窗、关闭后焦点还原。手写 veil 就会丢掉这些。
const modalSrc = readFileSync(join(ROOT, 'src/neural/useModal.jsx'), 'utf8');
if (!/key === 'Escape'/.test(modalSrc) || !/addEventListener\('keydown', key, true\)/.test(modalSrc)) {
  fail('src/neural/useModal.jsx 必须在捕获阶段处理 Esc 与 Tab 焦点陷阱');
}
const rawVeils = ['NoteModal.jsx', 'DiffModal.jsx', 'pages.jsx']
  .filter(f => /className="veil"/.test(readFileSync(join(ROOT, 'src/neural', f), 'utf8')));
if (rawVeils.length) fail('这些文件手写了 veil 弹窗（缺 Esc/焦点陷阱），应改用 useModal 的 <Modal>：' + rawVeils.join('、'));
else ok('弹窗统一走 useModal（Esc 关闭 + 焦点陷阱 + 焦点还原）');

// 星图画布每帧画上百个光点，径向渐变必须烘成精灵图复用，不能逐帧 createRadialGradient。
const ncSrc = readFileSync(join(ROOT, 'src/neural/NetworkCanvas.jsx'), 'utf8');
if (!/const sprites = new Map\(\)/.test(ncSrc) || !/drawImage\(glowOf\(color\)/.test(ncSrc) || !/drawImage\(bodyOf\(color\)/.test(ncSrc)) {
  fail('NetworkCanvas 的节点光晕/球体光粒没有走精灵缓存（每帧 createRadialGradient 会拖慢帧率）');
} else if (!/dustSprite\(p\.c\)/.test(readFileSync(join(ROOT, 'src/neural/Home.jsx'), 'utf8'))) {
  fail('Home.jsx 的尘埃光点没有走 dustSprite 缓存（每帧 130 次 createRadialGradient）');
} else ok('星图光晕与尘埃光点走精灵缓存，不再逐帧建渐变');

// 月目标算的是「这个月」，不能永远停在数据里最后一个有作品的月份。
const worksSrc = readFileSync(join(ROOT, 'src/neural/works.js'), 'utf8');
if (!/getFullYear\(\)/.test(worksSrc)) fail('monthPostsOf 必须按当前自然月统计（否则月目标永远显示旧月份）');
else ok('月目标按当前自然月统计（旧快照才退回最新月份）');

// 后台任务轮询必须判状态码，否则 401/500 会空转到超时，还把错误报成「任务超时」。
const analysisSrc = readFileSync(join(ROOT, 'src/neural/Analysis.jsx'), 'utf8');
if (!/if \(!r\.ok\) throw new Error/.test(analysisSrc)) fail('pollJob 必须判 r.ok，否则 401/500 会一直重试到超时');
else ok('AI 任务轮询会判状态码');

// 新建但还没落盘的选题不能被自动刷新抹掉（草稿分支已有 kept，选题分支也不能漏）。
// kept 还必须判 isPending，否则外部删掉的条目会一直复活（见下面的 r7 检查）。
if (!/本地还有未落盘改动/.test(wMain) || !/const kept = list\.filter/.test(wMain)) {
  fail('自动刷新时未落盘的新建选题会被抹掉（选题分支缺少 kept 合并）');
} else ok('自动刷新不会抹掉未落盘的新建选题/草稿');

// 服务端：坏 auth.json 必须拒绝启动（authed() 把 null 当免登录）、fm/body 必须是对象、并发 AI 任务 409。
if (!/auth\.json 不是合法 JSON/.test(wServer) || !/process\.exit\(1\)/.test(wServer)) {
  fail('auth.json 损坏时必须拒绝启动，不能降级成「未开启登录」');
} else if (!/请求体必须是 JSON 对象/.test(wServer) || !/fm 必须是对象/.test(wServer)) {
  fail('服务端必须拒绝非对象的请求体 / fm（否则 500 或写出 0: a 这种脏键）');
} else if (!/if \(runningJob\) fail\(409/.test(wServer)) {
  fail('同一时刻只允许一个 AI 后台任务（并发 relate 会互相覆盖语义边）');
} else ok('服务端拒绝坏登录配置、非对象 fm/body，并限制并发 AI 任务');

// —— 第五轮审查：部署模式下的断裂点 ——
// 公众号凭据的键名：设置面板/cleanPlatforms 写「公众号」，早期配置写 wechat，平台模块两种都要认。
const r5Platforms = readFileSync(join(ROOT, 'server/platforms.mjs'), 'utf8');
if (!/platforms\['公众号'\]/.test(r5Platforms)) {
  fail("server/platforms.mjs 只认 platforms.wechat，设置面板存下的「公众号」凭据永远不生效");
} else ok('公众号凭据两种键名都认（公众号 / wechat）');
// compose 必须把部署变量文件里的公众号凭据转发进容器，否则文档里的配置方式静默失效。
const r5Compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
if (!/WECHAT_APPID:/.test(r5Compose) || !/WECHAT_SECRET:/.test(r5Compose)) {
  fail('docker-compose.yml 没有转发 WECHAT_APPID / WECHAT_SECRET（部署变量里填了也不会生效）');
} else ok('compose 转发了公众号凭据');

// 空作品库时 askGraph 的「作品表现」分支不能直接取 ps[0]（纯静态模式/新 vault 会崩，助手永久卡在检索中）。
const r5Graph = readFileSync(join(ROOT, 'src/neural/graph.js'), 'utf8');
if (!/cards\.push\(ps\.length/.test(r5Graph)) {
  fail('askGraph 的「作品表现」分支没有判空（空库时 ps[0].short 会抛错，助手卡在检索中）');
} else ok('本地检索在空作品库时不会抛错');
// 个人知识库必须复用 FOLDERS 的 f:personal，不能再造一个 f:个人知识库 的重复目录节点。
if (!/isPersonal \? 'f:personal' : 'f:' \+ sub/.test(r5Graph)) {
  fail("个人知识库的目录节点 id 没有复用 f:personal（会多出重复目录节点并锚到方法库方向）");
} else ok('个人知识库复用 f:personal 目录节点');

// 设置面板保存月目标后要回写 App 的 goal（否则首页进度环与重开的面板都是旧值）。
const r5Settings = readFileSync(join(ROOT, 'src/neural/SettingsPanel.jsx'), 'utf8');
if (!/onGoal\?\.\(n\)/.test(r5Settings)) fail('设置面板保存月目标后没有回写 App 的 goal 状态');
else ok('设置面板保存月目标后回写 goal 状态');

// 上传全部失败不能说「已写入」；AI 问答异常不能跳过 setBusy(false)。
const r5Assistant = readFileSync(join(ROOT, 'src/neural/Assistant.jsx'), 'utf8');
if (!/if \(!okCount\) showToast/.test(r5Assistant)) fail('上传全部失败时仍提示「上传完成」（明细与 Toast 矛盾）');
else if (!/finally \{\s*setBusy\(false\)/.test(r5Assistant)) fail('Assistant 的 ask 没有用 finally 复位 busy（异常会让发送按钮永久禁用）');
else ok('上传失败如实提示，AI 问答异常不会卡住 busy');

// —— 第六轮审查：解析边界与保存状态机 ——
const r6FmSrc = readFileSync(join(ROOT, 'server/frontmatter.mjs'), 'utf8');
if (!/uFEFF/.test(r6FmSrc)) fail('server/frontmatter.mjs 没有跳过 BOM：带 BOM 的笔记保存正文会把整块属性抹掉');
else if (!/uFEFF/.test(readFileSync(join(ROOT, 'src/neural/mdfront.js'), 'utf8'))) {
  fail('src/neural/mdfront.js 的 stripFrontmatter 没跳过 BOM：阅读弹窗会把属性当正文显示并回写两份');
} else ok('frontmatter 解析跳过 BOM、空属性块仍算有属性');
const r6PersistSrc = readFileSync(join(ROOT, 'src/neural/persist.js'), 'utf8');
if (!/visibilityState === 'hidden'[\s\S]{0,200}outbox\.size \|\| timers\.size/.test(r6PersistSrc)) {
  fail("persist.js 的 visibilitychange 没在切后台时落盘（防抖窗口里的编辑会丢）");
} else ok('页面切到后台时立即落盘');
const r6StoreSrc = readFileSync(join(ROOT, 'src/data/store.js'), 'utf8');
if (!/beginLoad/.test(r6StoreSrc) || !/seq !== loadSeq/.test(r6StoreSrc)) {
  fail('setApiData 没有装载序号：并发 refresh 乱序返回时界面会停在旧快照');
} else ok('数据装载有请求序号，乱序响应不会覆盖新数据');
const r6IdxSrc = readFileSync(join(ROOT, 'server/index.mjs'), 'utf8');
if (!/String\(v\.appid \?\? ''\)\.trim\(\) && cur\[k\]\?\.secret/.test(r6IdxSrc)) {
  fail('清空公众号凭据会被「沿用旧 secret」逻辑拦成 400（用户无法关掉同步）');
} else ok('清空公众号凭据可以关掉同步');

// 外部删除的选题/草稿不能被本地的 kept 分支复活（只有未落盘改动才保留）
const r7MainSrc = readFileSync(join(ROOT, 'src/neural/main.jsx'), 'utf8');
const r7Kept = r7MainSrc.match(/const kept = list\.filter\([^\n]*\)/g) || [];
if (r7Kept.length < 2 || !r7Kept.every(l => /persist\.isPending\(/.test(l))) {
  fail('自动刷新的 kept 分支没有判 isPending：外部删掉的选题/草稿会一直复活');
} else ok('外部删除的选题/草稿不会被本地合并复活');

// —— 第八轮审查：内页与设置面板的功能缺口 ——
const r8VaultSrc = readFileSync(join(ROOT, 'server/vault.mjs'), 'utf8');
const r8PagesSrc = readFileSync(join(ROOT, 'src/neural/pages.jsx'), 'utf8');
if (!/truncated: draftBody\.length < draftFull\.length/.test(r8VaultSrc)) {
  fail('server/vault.mjs 没有给被截断的草稿标 truncated（前端会把 6000 字缓存当全文写回）');
} else if (!/const locked = readOnly \|\| truncated/.test(r8PagesSrc)) {
  fail('创作台的编辑器没有锁住被截断的正文（编辑第一个字就会写回截断内容）');
} else ok('超长草稿先拉全文再允许编辑');
const r8SetSrc = readFileSync(join(ROOT, 'src/neural/SettingsPanel.jsx'), 'utf8');
if (!/!appid\.trim\(\) && !secret\.trim\(\) && !configured/.test(r8SetSrc)) {
  fail('清空公众号凭据的保存按钮被禁用：前端没有关掉同步的入口');
} else if (!/saveSettings\(\{aiApiKey: ''\}\)/.test(r8SetSrc)) {
  fail('设置面板没有清除已存 AI key 的入口');
} else ok('清空公众号凭据与 AI key 都有入口');
if (!/setFormTitle\(''\); setFormBody\(''\)/.test(r8PagesSrc)) {
  fail('知识库新建表单保存后没复位：下次新建会带着旧内容重复入库');
} else if (!/const j = await res\.json\(\)\.catch\(\(\) => \(\{\}\)\);\s*\n\s*if \(!res\.ok\) throw new Error\(j\.error/.test(r8PagesSrc)) {
  fail('知识库删除失败时没有带上服务端原因（登录过期/路径越界都显示成 HTTP 4xx）');
} else ok('知识库表单复位、删除失败带出服务端原因');

// —— 第九轮审查：AI 动作链路的契约 ——
const r9AiSrc = readFileSync(join(ROOT, 'server/ai.mjs'), 'utf8');
const r9AnalysisSrc = readFileSync(join(ROOT, 'src/neural/Analysis.jsx'), 'utf8');
const r9DbSrc = readFileSync(join(ROOT, 'server/db.mjs'), 'utf8');
if (!/\? \{enabled: true, model: EMBED_MODEL/.test(r9AiSrc)) {
  fail('aiInfo().embed 启用时没带 enabled:true：前端永远认为 embedding 没开，语义关联按钮不出现');
} else if (!/if \(!job\?\.job\?\.id\) return \{msg:/.test(r9AnalysisSrc)) {
  fail('/api/ai/analyze 返回 200 无 job 时前端会 TypeError');
} else if (!/DELETE FROM embeddings WHERE note_id NOT IN \(SELECT id FROM notes\)/.test(r9DbSrc)) {
  fail('删除笔记后 embeddings 没清理：悬空向量挤占 400 条语义边预算');
} else if (!/body: JSON\.stringify\(\{question: q, model: model \|\| pickedModel\(\)\}\)/.test(r9AnalysisSrc)) {
  fail('追问没把选中的模型发给服务端：下拉框选了也不生效');
} else if (!/if \(!r\.ok\) throw new Error\(j\.error \|\| 'HTTP ' \+ r\.status\)/.test(r9AnalysisSrc)) {
  fail('追问不判 r.ok：401/500 会显示成「（空）」');
} else if (!/const r = await pollJob\(job\.job\.id, Math\.max\(120,/.test(r9AnalysisSrc)) {
  fail('语义关联的轮询上限没按任务总量放大（上百条内容必然前端超时 + 409 卡死）');
} else ok('AI 动作链路的契约（embed 标记 / analyze 空任务 / 向量清理 / 追问模型与错误 / relate 超时）');

// —— 第十轮审查：写盘原子性与多端冲突 ——
const r10SrvSrc = readFileSync(join(ROOT, 'server/index.mjs'), 'utf8');
const r10PersistSrc = readFileSync(join(ROOT, 'src/neural/persist.js'), 'utf8');
const r10MainSrc = readFileSync(join(ROOT, 'src/neural/main.jsx'), 'utf8');
if (!/writeFileSync\(tmp, after, 'utf8'\);\s*\n\s*renameSync\(tmp, abs\);/.test(r10SrvSrc)) {
  fail('笔记写盘还是原地覆盖：进程被杀会留下半截 .md（应临时文件 + rename）');
} else if (/index\.putAi\('note:' \+ n\.id/.test(r10SrvSrc)) {
  fail('AI 分析缓存用 note: 前缀：个人知识库（personal:）缓存永远对不上又会被清理删掉');
} else if (!/if \(setApiData\(payload, seq\) === false\) return;/.test(r10PersistSrc)
  || !/for \(const \[key, r\] of refs\)/.test(r10PersistSrc)) {
  fail('采纳远端快照后没有重播 refs 乐观锁基线：外部改动后本地必然撞一次假 409');
} else if (!/onHydrateRetry/.test(r10MainSrc)) {
  fail('拉全文失败被静默吞掉：编辑器会一直锁在「正在载入全文」');
} else ok('写盘原子性与多端冲突（临时文件 + rename / 缓存 id / 基线重播 / 全文重试）');

// —— 第十一轮审查：平台同步链路 ——
const r11PlatSrc = readFileSync(join(ROOT, 'server/platforms.mjs'), 'utf8');
const r11SetSrc = readFileSync(join(ROOT, 'src/neural/SettingsPanel.jsx'), 'utf8');
const r11SrvSrc = readFileSync(join(ROOT, 'server/index.mjs'), 'utf8');
const r11ComposeSrc = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
if (!/onSaved=\{onRefresh\}/.test(r11SetSrc)) {
  fail('平台设置保存后没有重拉设置：configured 不更新，同一会话里关不掉公众号同步');
} else if (!/if \(lastRunYmd === today\) return;/.test(r11PlatSrc)) {
  fail('平台定时器没有当日去重：每 30 分钟全量重拉一次，逐篇产生 git commit');
} else if (!/公众号数据接口错误：/.test(r11PlatSrc)) {
  fail('公众号接口的 errcode/HTTP 错误被当成「最近 3 天没有数据」');
} else if (!/SYNC_TZ_OFFSET/.test(r11ComposeSrc) || !/const TZ_OFFSET = /.test(r11PlatSrc)) {
  fail('同步时间按容器 UTC 判定（容器默认 UTC，「21 点后」实际是次日 05:00）');
} else if (!/cleanPlatforms\(raw\?\.platforms, \{strict: false\}\)/.test(r11SrvSrc)) {
  fail('设置读取路径不宽容历史键：有英文键 wechat 时整份设置回落默认值');
} else ok('平台同步链路（设置重拉 / 当日去重 / errcode / 时区 / 宽容读取）');

// —— 第十二轮审查：日报链路 ——
const r12NewsSrc = readFileSync(join(ROOT, 'server/news.mjs'), 'utf8');
const r12SrvSrc = readFileSync(join(ROOT, 'server/index.mjs'), 'utf8');
if (!/const TZ_OFFSET = Number\.isFinite\(TZ_OFFSET_RAW\) \? TZ_OFFSET_RAW : 8;/.test(r12NewsSrc)
  || !/if \(now\.getUTCHours\(\) < NEWS_HOUR\) return;/.test(r12NewsSrc)) {
  fail('日报定时按容器 UTC 判定：NEWS_HOUR=8 实际在北京时间 16:00 触发');
} else if (!/function writeMdAtomic\(path, text\)/.test(r12NewsSrc)
  || /writeFileSync\(mdPath, /.test(r12NewsSrc)) {
  fail('日报 .md 仍是原地覆盖写：写坏会留下半截文件且被当成已生成');
} else if (!/if \(auto && news\.ideasAt\) return \{candidates: \[\], written: \[\], skipped/.test(r12NewsSrc)) {
  fail('选题落盘的幂等闸在 AI 调用之后：cron 与手动并发会重复落盘 + 双倍计费');
} else if (!/runningJob = 'news-refresh';/.test(r12SrvSrc) || !/runningJob = 'news-ideas';/.test(r12SrvSrc)) {
  fail('/api/news/* 绕开「同时只跑一个 AI 任务」的闸');
} else if (!/const limit = Number\.isFinite\(raw\) \? Math\.min\(Math\.max\(Math\.trunc\(raw\), 1\), 90\) : 14;/.test(r12SrvSrc)) {
  fail('/api/news 的 limit 没校验：NaN 会导致 500');
} else ok('日报链路（时区 / 原子写 / 幂等闸 / 互斥 / limit 校验）');

// —— 第十三轮审查：登录与回退链路 ——
const r13BootSrc = readFileSync(join(ROOT, 'src/neural/boot.js'), 'utf8');
const r13MainSrc = readFileSync(join(ROOT, 'src/neural/main.jsx'), 'utf8');
if (!/if \(e\.status\) serverSeen = true;/.test(r13BootSrc)
  || !/if \(EXPECT_API \|\| serverSeen\) \{/.test(r13BootSrc)
  || !/function selfHeal\(\)/.test(r13BootSrc)) {
  fail('部署模式连通失败只靠构建期 VITE_API_BASE 判断：生产镜像不传 build-arg，提示与自愈都不会出现');
} else if (!/for \(let attempt = 0; attempt < 4 && !json; attempt\+\+\)/.test(r13BootSrc)) {
  fail('/api/data 没有重试：容器刚起来时一次超时就永久落到示例数据');
} else if (!/if \(!activeTruncated\) \{ setHydrateErr\(null\); return; \}/.test(r13MainSrc)) {
  fail('hydrate effect 没按 truncated 收口：新建草稿的 refs 尚未登记，会立刻误报「读取全文失败」');
} else ok('登录与回退链路（连不上时的自愈 / 取数重试 / hydrate 收口）');

// —— 第十四轮审查：数据一致性的交叉面 ——
const r14VaultSrc = readFileSync(join(ROOT, 'server/vault.mjs'), 'utf8');
const r14DbSrc = readFileSync(join(ROOT, 'server/db.mjs'), 'utf8');
const r14PersistSrc = readFileSync(join(ROOT, 'src/neural/persist.js'), 'utf8');
if (!/const uniqIdea = uniqueId\(\);/.test(r14VaultSrc)
  || !/id: uniqIdea\(stableId \|\| i \+ 1\)/.test(r14VaultSrc)
  || !/id: uniqDraft\(stableId \|\| 'draft-' \+ \(i \+ 1\)\)/.test(r14VaultSrc)) {
  fail('重复 fm id 没去重：files 被覆盖 + 索引撞主键，/api/data 会整个 500');
} else if (!/const moved = \[\];/.test(r14DbSrc)
  || !/DELETE FROM semantic_edges WHERE a = \? OR b = \?/.test(r14DbSrc)) {
  fail('位置 id 位移后旧语义边不会作废：图谱会连到别的节点');
} else if (!/if \(files\[key\] !== r\.path\) \{ if \(!isPending\(key\)\) refs\.delete\(key\); continue; \}/.test(r14PersistSrc)) {
  fail('refreshData 重播基线不校验 path：id 位移后会把正文写进另一个文件');
} else ok('数据一致性（重复 id 去重 / 位移作废语义边 / 基线按 path 校验）');

for (const w of warnings) console.log('  ! ' + w);
if (errors.length) { console.error('\n未通过：'); errors.forEach(e => console.error('  ✗ ' + e)); process.exit(1); }
console.log('\n全部通过。');
