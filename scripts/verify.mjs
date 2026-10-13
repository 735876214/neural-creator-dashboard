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
function check(m, label) {
  const errs = [];
  for (const k of ['snapshot', 'posts', 'postContent', 'notes', 'seedIdeas', 'seedDrafts', 'concepts']) if (!(k in m)) errs.push(`缺少导出 ${k}`);
  if (errs.length) return errs;
  if (!m.posts.length) errs.push('posts 为空');
  for (const p of m.posts) {
    if (typeof p.id !== 'string' || !p.id) errs.push(`作品缺少 id：${p.title}`);
    if (!/^\d{4}-\d{2}-\d{2}/.test(p.date || '')) errs.push(`作品日期格式不对：${p.title}`);
    if (typeof p.views !== 'number') errs.push(`作品 views 必须是数字：${p.title}`);
    if (!m.postContent.some(c => c.title === p.title)) errs.push(`postContent 里找不到作品：${p.title}`);
  }
  if (new Set(m.posts.map(p => p.id)).size !== m.posts.length) errs.push('作品 id 有重复');
  // 导入脚本写「05-方法库 methods/」；手写数据时也用这个前缀。
  for (const n of m.notes) if (!/^05-方法库 methods\/[^/]+\/.+/.test(n.path || '')) errs.push(`笔记 path 格式不对：${n.title}`);
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
const index = readFileSync(join(ROOT, 'src/data/index.js'), 'utf8');
const source = (index.match(/from '\.\/([^']+)'/) || [])[1];
if (!source || !existsSync(join(ROOT, 'src/data', source))) fail(`src/data/index.js 指向的文件不存在：${source}`);
else {
  const errs = check(await import(pathToFileURL(join(ROOT, 'src/data', source)).href), source);
  if (errs.length) errs.forEach(e => fail(`${source}：${e}`));
  else ok(`src/data/${source} 结构正确`);
}

// 3. 核心动效：星核、五簇星团与活着的星穹背景是这个看板的核心，不能被删掉或改成静态
console.log('核心动效（星核与五簇星团）');
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
if ((modules.match(/\{id: '/g) || []).length !== 5) fail('graph.js 的 MODULES 应为 5 个模块（5 个星团）');
else ok('5 个模块 → 5 个星团');

// 3b. 五星座（v6.3）：五个模块 = 五个真实星座，图形来自真实星表，逐帧只做贴图 + 主星闪烁
console.log('五星座（v6.3）');
const consSrc = readFileSync(join(ROOT, 'src/neural/constellations.js'), 'utf8');
const figs = [
  ['真实星座骨架表（d3-celestial · J2000 赤经赤纬）', /constellations\.lines\.json/],
  ['五个模块的星座映射（天蝎/双鱼/处女/射手/水瓶）', /天蝎座[\s\S]*双鱼座[\s\S]*处女座[\s\S]*射手座[\s\S]*水瓶座/],
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
  if ((src.match(/<ConstellationBand/g) || []).length !== 3) fail(`${f} 的三个内页都应带星座轨`);
  else ok('作品库 / 创作台 / 选题池 三个内页都带星座轨');
}
if (!/from '\.\/constellations'/.test(home) || !/figData/.test(home) || !/drawCluster\(canvasRefs/.test(home)) fail('Home.jsx 没有用星座层渲染星团');
else ok('主视图星团层 = 五星座（烘焙 + 主星闪烁）');
for (const f of ['media/orb.mp4', 'media/jellyfish.mp4']) if (existsSync(join(ROOT, 'public', f))) warnings.push(`public/${f} 已不再被引用，可以删除（保留不影响）`);

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
