// 视频34「看板片段」录制脚本 —— 确定性逐帧录制（1920×1080@60），数据=我们自己的库（v34_public_vault 导入）
//
// 原理（沿用视频33 record-demo 的时钟控制口径）：
//   ① addInitScript 接管 performance.now / Date.now / rAF，页面时间只按手动推进走；
//   ② 每帧：推进虚拟时间 → rAF 同步执行（canvas 当帧画完）→ CSS/SMIL 拉到同一虚拟时间轴 → screenshot 出 1 张 JPEG；
//   ③ ffmpeg 把各片段帧序列分别合成 60fps mp4。
//
// 用法：
//   node docs/proposals/_src/record-demo.mjs            # 全部片段
//   node docs/proposals/_src/record-demo.mjs 2 3        # 只录第 2/3 段
//   node docs/proposals/_src/record-demo.mjs --url=http://127.0.0.1:5173/
//   node docs/proposals/_src/record-demo.mjs --keep-frames
// 前提：dev server 在跑；ffmpeg 在 PATH；playwright 用 npx 缓存（不装依赖）。

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));

// ============================ 配置区 ============================
const CFG = {
  URL: 'http://127.0.0.1:5173/',
  OUT_DIR: resolve(HERE, '../../../../../Desktop/自媒体视频素材/视频34_Obsidian记忆库/素材/看板片段'),
  FPS: 60,
  VIRTUAL_FRAME_MS: 16,
  WIDTH: 1920, HEIGHT: 1080,
  FRAME_FORMAT: 'jpeg', QUALITY: 92,
  WARMUP_FRAMES: 170,
  SETTLE_MS: 3000,
  SKIP_INTRO: true,      // 主界面开录时已成型（跳过首次开场动画）
  KEEP_FRAMES: false,
  CRF: 16, PRESET: 'slow',
};

const SEL = {
  askInput: '.dock .ask input',
  closeAsk: 'button[aria-label="关闭分析"]',
  clusterWorks: 'button.cluster-label:has-text("作品库")',
  clusterMethods: 'button.cluster-label:has-text("方法库")',
  clusterConcepts: 'button.cluster-label:has-text("概念网络")',
  fanItem: '.fan-item',
};

// —— 片段表 ——（连续会话：片段按顺序作用在同一页面状态上）
const SEGMENTS = [
  {
    id: '01_主视图', name: '主视图 · 星穹星座 + 提问「最核心的内容」',
    frames: 600, // 10s
    actions: [
      {at: 24, kind: 'focus', sel: SEL.askInput},
      {at: 40, kind: 'type', text: '最核心的内容', perChar: 12},
      {at: 280, kind: 'key', key: 'Enter'},
    ],
  },
  {
    id: '02_作品库分支', name: '作品库星团展开 + 单篇分析栏',
    frames: 600, // 10s
    actions: [
      {at: 0, kind: 'key', key: 'Escape'},            // 收起片段1的问题卡片
      {at: 60, kind: 'click', sel: SEL.clusterWorks}, // 星团展开
      {at: 330, kind: 'click', sel: SEL.fanItem},     // 点第一篇 → 右侧分析栏
    ],
  },
  {
    id: '03_方法库分支', name: '方法库星团展开',
    frames: 480, // 8s
    actions: [
      {at: 0, kind: 'key', key: 'Escape'},            // 关分析栏
      {at: 24, kind: 'key', key: 'Escape'},           // 回主视图
      {at: 90, kind: 'click', sel: SEL.clusterMethods},
    ],
  },
];
// ========================== 配置区结束 ==========================

const argv = process.argv.slice(2);
const flag = n => argv.some(a => a === '--' + n);
for (const a of argv) {
  const u = a.match(/^--url=(.+)$/); if (u) CFG.URL = u[1];
  const o = a.match(/^--out=(.+)$/); if (o) CFG.OUT_DIR = resolve(o[1]);
}
const ONLY = argv.filter(a => /^\d+$/.test(a)).map(Number);
const SEGS_RUN = ONLY.length ? SEGMENTS.filter((s, i) => ONLY.includes(i + 1)) : SEGMENTS;
if (flag('keep-frames')) CFG.KEEP_FRAMES = true;
const log = (...a) => console.log(...a);

// ---------- playwright 定位（不装依赖：用 npx 缓存） ----------
function pwRevisions(modPath) {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(modPath), 'browsers.json'), 'utf8'));
    return Object.fromEntries(pkg.browsers.filter(b => b.name.startsWith('chromium')).map(b => [b.name, b.revision]));
  } catch { return null; }
}
async function resolvePlaywright() {
  const cands = [];
  if (process.env.PLAYWRIGHT_MODULE) cands.push(process.env.PLAYWRIGHT_MODULE);
  for (const name of ['playwright', 'playwright-core']) {
    try { cands.push(createRequire(join(HERE, 'x.js')).resolve(name)); } catch {}
  }
  const npxRoot = join(homedir(), '.npm', '_npx');
  if (existsSync(npxRoot)) {
    for (const d of readdirSync(npxRoot)) {
      for (const name of ['playwright', 'playwright-core']) {
        const p = join(npxRoot, d, 'node_modules', name, 'index.mjs');
        if (existsSync(p)) cands.push(p);
      }
    }
  }
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  const installed = existsSync(cache) ? readdirSync(cache) : [];
  for (const c of cands) {
    const rev = pwRevisions(c);
    if (!rev) continue;
    const full = installed.includes('chromium-' + rev.chromium);
    const shell = installed.includes('chromium_headless_shell-' + rev['chromium-headless-shell']);
    if (full || shell) return { path: c, rev, full, shell };
  }
  if (cands.length) return { path: cands[0], rev: pwRevisions(cands[0]), full: false, shell: false };
  throw new Error('找不到 playwright / playwright-core：请设 PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs');
}

// ---------- 虚拟时钟 shim ----------
const SHIM = (frameMs) => {
  const D = window.__DEMO = { frameMs, vNow: 0, rafCount: 0, animErr: 0, smilSeen: 0, errors: [] };
  let vNow = 0, rafId = 1;
  const rafQ = new Map();
  const animMark = new WeakMap();
  try { Object.defineProperty(performance, 'now', {value: () => vNow, configurable: true}); } catch {}
  try { Date.now = () => 1760000000000 + vNow; } catch {}
  window.requestAnimationFrame = cb => { const id = rafId++; rafQ.set(id, cb); return id; };
  window.cancelAnimationFrame = id => { rafQ.delete(id); };
  function syncAnims() {
    let list;
    try { list = document.getAnimations(); } catch { return; }
    for (const a of list) {
      try {
        const st = a.playState;
        if (st === 'finished' || st === 'idle') continue;
        let m = animMark.get(a);
        if (!m) { m = {v: vNow - (typeof a.currentTime === 'number' ? a.currentTime : 0)}; animMark.set(a, m); }
        if (st !== 'paused') a.pause();
        a.currentTime = Math.max(0, vNow - m.v);
      } catch { D.animErr++; }
    }
  }
  function syncSmil() {
    for (const s of document.querySelectorAll('svg')) {
      try {
        if (typeof s.pauseAnimations !== 'function') continue;
        if (!s.__vOff) { s.pauseAnimations(); s.__vOff = vNow + 1; D.smilSeen++; }
        s.setCurrentTime((vNow - s.__vOff) / 1000);
      } catch {}
    }
  }
  window.__step = ms => {
    vNow += (ms || D.frameMs); D.vNow = vNow;
    const q = [...rafQ]; rafQ.clear(); D.rafCount = q.length;
    for (const [, cb] of q) { try { cb(vNow); } catch (e) { D.errors.push(String(e && e.message || e)); } }
    syncAnims(); syncSmil();
    return q.length;
  };
  window.__ready = () => ({
    stage: document.querySelector('.home-stage')?.className || null,
    canvases: document.querySelectorAll('canvas').length,
    askResults: !!document.querySelector('.ask-results'),
    fanItems: document.querySelectorAll('.fan-item').length,
    analysis: !!document.querySelector('.analysis-wrap'),
    input: document.querySelector('.dock .ask input')?.value ?? null,
  });
};

// ---------- 浏览器 ----------
async function launch(chromium) {
  const base = ['--force-device-scale-factor=1', '--hide-scrollbars', '--disable-lcd-text'];
  const tries = [
    ['bundled chromium（新无头）', {headless: true, channel: 'chromium', args: base}],
    ['bundled chromium headless shell', {headless: true, args: base}],
    ['系统 Google Chrome（新无头）', {headless: true, channel: 'chrome', args: base}],
  ];
  const errs = [];
  for (const [name, opt] of tries) {
    try { const b = await chromium.launch(opt); log(`  · 浏览器：${name}`); return {browser: b, label: name}; }
    catch (e) { errs.push(`${name}: ${String(e).split('\n')[0].slice(0, 120)}`); }
  }
  throw new Error('浏览器都起不来：\n  ' + errs.join('\n  '));
}

function jpegSize(buf) {
  for (let i = 2; i < buf.length - 9;) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const mk = buf[i + 1], len = buf.readUInt16BE(i + 2);
    if (mk >= 0xC0 && mk <= 0xCF && mk !== 0xC4 && mk !== 0xC8 && mk !== 0xCC) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
    i += 2 + len;
  }
  return null;
}

// ---------- 主流程 ----------
const t0 = Date.now();
const {path: pwPath, rev, full, shell} = await resolvePlaywright();
log(`playwright: ${pwPath}`);
log(`  chromium revision 期望 ${JSON.stringify(rev)} · 缓存里 chromium-${rev?.chromium}: ${full ? '有' : '无'} / headless-shell: ${shell ? '有' : '无'}`);
const pw = await import(pathToFileURL(pwPath).href);
const chromium = pw.chromium ?? pw.default?.chromium;
if (!chromium) throw new Error('playwright 模块里没有 chromium');

mkdirSync(CFG.OUT_DIR, {recursive: true});
const {browser, label} = await launch(chromium);
const ctx = await browser.newContext({viewport: {width: CFG.WIDTH, height: CFG.HEIGHT}, deviceScaleFactor: 1, colorScheme: 'dark'});
if (CFG.SKIP_INTRO) await ctx.addInitScript(() => { try { sessionStorage.setItem('neural-intro-seen', '1'); } catch {} });
await ctx.addInitScript(SHIM, CFG.VIRTUAL_FRAME_MS);
const page = await ctx.newPage();
page.setDefaultTimeout(8000);
const problems = [];
page.on('pageerror', e => problems.push('pageerror: ' + String(e.message).slice(0, 160)));
page.on('console', m => { if (m.type() === 'error') problems.push('console: ' + m.text().slice(0, 160)); });

await page.goto(CFG.URL, {waitUntil: 'domcontentloaded', timeout: 60000});
await page.waitForSelector('.home-stage', {timeout: 30000});
await page.waitForTimeout(CFG.SETTLE_MS);
await page.addStyleTag({content: 'input, textarea { caret-animation: manual !important; }'});
const cap = await page.evaluate(() => window.__ready());
log(`  页面就绪：canvas ${cap.canvases} 个 · stage=${cap.stage}`);

const step = () => page.evaluate(ms => window.__step(ms), CFG.VIRTUAL_FRAME_MS);
const flush = () => page.evaluate(() => new Promise(r => setTimeout(r, 0)));

async function runAction(a) {
  if (a.kind === 'click' || a.kind === 'focus') {
    try {
      await page.locator(a.sel).first().evaluate((el, isFocus) => { if (isFocus) el.focus(); else el.click(); }, a.kind === 'focus');
    } catch (e) {
      problems.push(`选择器没命中（${a.kind}）：${a.sel} · ${String(e).split('\n')[0].slice(0, 90)}`);
    }
  } else if (a.kind === 'type') {
    try { await page.locator(SEL.askInput).first().evaluate(el => el.focus()); }
    catch { problems.push('打字前找不到搜索框：' + SEL.askInput); }
    await page.keyboard.type(a.text);
  } else if (a.kind === 'key') {
    await page.keyboard.press(a.key);
  }
  await flush();
}
function actsOf(seg) {
  const out = [];
  for (const a of seg.actions) {
    if (a.kind === 'type') {
      [...a.text].forEach((ch, k) => out.push({at: a.at + k * (a.perChar ?? 12), kind: 'type', text: ch}));
    } else out.push({...a});
  }
  return out.sort((x, y) => x.at - y.at);
}

log(`\n预热 ${CFG.WARMUP_FRAMES} 帧（不录）…`);
for (let i = 0; i < CFG.WARMUP_FRAMES; i++) await step();
log(`  预热完成 @${((Date.now() - t0) / 1000).toFixed(1)}s`);

const manifest = {url: CFG.URL, browser: label, fps: CFG.FPS, width: CFG.WIDTH, height: CFG.HEIGHT, segments: []};
const DONE = [];
for (const [i, seg] of SEGMENTS.entries()) {
  const rec = SEGS_RUN.includes(seg);
  const tS = Date.now();
  const framesDir = join(CFG.OUT_DIR, `frames_${seg.id}`);
  const acts = actsOf(seg);
  const mp4 = join(CFG.OUT_DIR, `看板片段_${seg.id}.mp4`);
  if (!rec) { for (let f = 0; f < seg.frames; f++) { for (const a of acts) if (a.at === f) await runAction(a); await step(); } continue; }
  rmSync(framesDir, {recursive: true, force: true}); mkdirSync(framesDir, {recursive: true});
  log(`\n[片段 ${i + 1}] ${seg.name} · ${seg.frames} 帧 / ${(seg.frames / CFG.FPS).toFixed(1)}s`);
  for (let f = 0; f < seg.frames; f++) {
    for (const a of acts) if (a.at === f) await runAction(a);
    await step();
    const buf = await page.screenshot({type: CFG.FRAME_FORMAT, quality: CFG.QUALITY, caret: 'initial'});
    if (f === 0) {
      const dim = jpegSize(buf);
      if (dim && (dim[0] !== CFG.WIDTH || dim[1] !== CFG.HEIGHT)) throw new Error(`首帧尺寸 ${dim.join('x')} ≠ ${CFG.WIDTH}x${CFG.HEIGHT}`);
    }
    writeFileSync(join(framesDir, `f${String(f).padStart(5, '0')}.jpg`), buf);
  }
  log(`  拍完 · ${((Date.now() - tS) / 1000).toFixed(1)}s`);
  // 编码
  const args = ['-y', '-loglevel', 'error', '-framerate', String(CFG.FPS), '-i', join(framesDir, 'f%05d.jpg'),
    '-frames:v', String(seg.frames), '-c:v', 'libx264', '-preset', CFG.PRESET, '-crf', String(CFG.CRF),
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4];
  const r = spawnSync('ffmpeg', args, {stdio: ['ignore', 'inherit', 'inherit']});
  if (r.status !== 0) throw new Error('ffmpeg 编码失败：' + mp4);
  const pr = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,nb_frames:format=duration,size', '-of', 'json', mp4], {encoding: 'utf8'});
  const info = JSON.parse(pr.stdout || '{}');
  const st = info.streams?.[0] || {}, fm = info.format || {};
  log(`  编码 → ${mp4}\n    核验：${st.width}x${st.height} @${st.r_frame_rate} · ${st.nb_frames} 帧 · ${Number(fm.duration).toFixed(2)}s · ${(Number(fm.size) / 1048576).toFixed(1)}MB`);
  manifest.segments.push({id: seg.id, name: seg.name, frames: seg.frames, seconds: +(seg.frames / CFG.FPS).toFixed(2), mp4, durationSec: Number(fm.duration), sizeMB: +(Number(fm.size) / 1048576).toFixed(1)});
  DONE.push(mp4);
  if (!CFG.KEEP_FRAMES) rmSync(framesDir, {recursive: true, force: true});
}
await browser.close();
writeFileSync(join(CFG.OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
if (problems.length) log(`\n⚠ 页面问题 ${problems.length} 条：\n  ` + [...new Set(problems)].slice(0, 12).join('\n  '));
log(`\n总耗时 ${((Date.now() - t0) / 1000 / 60).toFixed(1)} 分钟 · 产出 ${DONE.length} 段`);
