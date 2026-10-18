#!/usr/bin/env node
// 校验：skill 格式、导入脚本、当前数据结构、页面素材。
// 用法：npm run verify              日常检查
//       npm run verify -- --release  发布前检查（另外要求仓库地址占位符已替换）
import {readFileSync, existsSync, mkdtempSync, rmSync} from 'node:fs';
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

// 3d. 一键部署：compose 引用的文件都在，Dockerfile 是多阶段构建
console.log('一键部署');
const composeSrc = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
const composeNeeds = ['Dockerfile', 'server', 'src', 'public', 'package.json', 'notes-vault'];
for (const f of composeNeeds) {
  const p = join(ROOT, f);
  if (!existsSync(p)) fail(`compose 部署缺文件：${f}`);
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

for (const w of warnings) console.log('  ! ' + w);
if (errors.length) { console.error('\n未通过：'); errors.forEach(e => console.error('  ✗ ' + e)); process.exit(1); }
console.log('\n全部通过。');
