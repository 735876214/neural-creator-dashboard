import React, {useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback} from 'react';
import {MODULES, KINDS, stats, askGraph, moduleOf} from './graph';
import {Icon} from './icons';
import {NetworkCanvas} from './NetworkCanvas';
import {StarCore} from './StarCore';
import {Analysis} from './Analysis';
import {T} from './theme';
import {baked, skeleton, hitOf, extentOf, countsOf, nameOf, BASE} from './constellations';
import {CONFIG} from '../config';

export const MOD_STYLE = Object.fromEntries(Object.entries(T.modules).map(([id, m]) => [id, m]));

export const split = n => ({out: n.out - n.mutual, back: n.in - n.mutual, both: n.mutual});
const fmt = v => v == null ? '—' : Number(v).toLocaleString('zh-CN');

export function moduleItems(graph, modId) {
  const m = MODULES.find(x => x.id === modId);
  if (!m) return [];
  const list = graph.nodes.filter(n => n.kind === m.kind);
  if (m.kind === 'post') list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (m.kind === 'concept') list.sort((a, b) => b.in - a.in);
  return list;
}

function moduleSummary(graph, m) {
  const items = moduleItems(graph, m.id);
  const sub = {
    works: () => [fmt(items.reduce((s, n) => s + n.post.views, 0)), '观看', 'views'],
    concepts: () => [fmt(items.reduce((s, n) => s + n.in, 0)), '提及', 'mentions'],
    methods: () => [graph.links.filter(l => l.kind === 'wiki').length, '双链', 'wikilinks'],
    ideas: () => [items.filter(n => n.idea.status !== '已转草稿').length, '待写', 'to write'],
    drafts: () => [fmt(items.reduce((s, n) => s + (n.body || '').length, 0)), '字', 'chars'],
    news: () => [items.length, '份日报', 'digests'],
    personal: () => [items.filter(n => n.personal?.url).length, '条剪藏', 'clips']
  }[m.id]?.() || [items.length, '条', 'items'];
  return {count: items.length, sub};
}

function itemMeta(n) {
  const d = split(n);
  switch (n.kind) {
    case 'post': return [['观看', 'Views', fmt(n.post.views)], ['收藏', 'Saves', fmt(n.post.saves)], ['↔', '', d.both]];
    case 'note': return [['出链', 'Out', d.out], ['反链', 'In', d.back], ['↔', '', d.both]];
    case 'idea': return [[n.idea.priority, 'Priority', ''], [n.idea.status, '', ''], ['↔', '', d.both]];
    case 'draft': return [['字', 'Chars', fmt((n.body || '').length)], ['↔', '', d.both]];
    case 'concept': return [['提及', 'Mentions', n.in], ['↔', '', d.both]];
    case 'personal': return [[n.personal?.category || '笔记', '', ''], [n.personal?.domain || (n.personal?.url ? '链接' : '本地'), '', ''], ['↔', '', d.both]];
    default: return [];
  }
}

// —— 布局目标 ——
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// 列队可用高度：留出顶部面包屑与底部提示条，最后一行不会压到提示
const fanSpan = h => Math.max(120, Math.round(h * .94 - 150));
// 行距不小于 26px 才读得清，据此定一屏能放多少行（含「还有 N 条」那一行）
const rowsThatFit = h => Math.max(2, Math.floor(fanSpan(h) / 26) + 1);
function targets(L, t) {
  const {w: W, h: H} = L.size, st = L.stage, narrow = W < 760;
  const swim = L.reduced ? 0 : 1;
  const res = {core: {}, cluster: {}, fan: null};
  if (st === 'hub') {
    const s = narrow ? clamp(W * .56, 180, 280) : clamp(Math.min(W, H) * .5, 250, 440);
    const cy = narrow ? H * .47 : H * .53;
    res.core = {x: W / 2, y: cy, s};
    // 六簇之间留出呼吸：椭圆半径放大、每簇尺寸收紧，团与团之间不再互相挤
    const rx = narrow ? W * .38 : Math.min(W * .345, 566), ry = narrow ? H * .23 : Math.min(H * .365, 300);
    MODULES.forEach((m, i) => {
      const a = (m.angle + swim * 7 * Math.sin(t * .17 + i * 1.7)) * Math.PI / 180;
      const r = 1 + swim * .04 * Math.sin(t * .23 + i);
      res.cluster[m.id] = {x: W / 2 + Math.cos(a) * rx * r, y: cy + Math.sin(a) * ry * r + swim * 9 * Math.sin(t * .9 + i * 2.1), s: narrow ? 184 : clamp(W * .205, 206, 288), o: 1};
    });
  } else if (narrow) {
    res.core = {x: 40, y: 156, s: 86};
    const slotN = MODULES.length - 1, clS = MODULES.length > 6 ? 110 : 120;
    MODULES.forEach((m, i) => {
      const sel = m.id === L.mod, k = slotOf(L.mod, m.id);
      res.cluster[m.id] = {x: 104 + k * (W - 136) / slotN, y: 152 + swim * 4 * Math.sin(t * .9 + i * 2), s: sel ? 150 : clS, o: sel ? 1 : .55};
    });
    const n = L.fanRows || L.items.length, gap = clamp((H - 330) / Math.max(n - 1, 1), 22, 54);
    res.fan = {x: 34, y0: 286, gap};
  } else {
    const ox = Math.max(124, W * .09), cy = H * .53;
    res.core = {x: ox, y: cy, s: 178};
    // v6.4：五卡片用足整列高度（旧式 122 行距下卡片只差几像素就贴住，选中卡甚至压住下一张）——
    // 上避面包屑（下沿 ~130）、下避底部提示条（上沿 ~H-70），单卡高约 119，上下各留 ≥16 净空；
    // v7.0 起模块数到 7：行距下限与簇尺寸各收一档，否则整列溢出。
    const seven = MODULES.length > 6;
    const colX = ox + 158, cardH = 119, topY = 150, botY = H - 73;
    const gap = clamp((Math.min(cy - topY, botY - cy) - cardH / 2) / 2, seven ? 74 : 122, 200);
    const mid = (MODULES.length - 1) / 2;
    MODULES.forEach((m, i) => {
      const sel = m.id === L.mod, k = slotOf(L.mod, m.id);
      res.cluster[m.id] = {x: colX + (sel ? 16 : 0), y: cy + (k - mid) * gap + swim * 5 * Math.sin(t * .9 + i * 2), s: sel ? (seven ? 252 : 300) : (seven ? 184 : 220), o: sel ? 1 : .6};
    });
    // 条目以右侧星系仪为基准排在它左边约 90px 处（条目最宽约 270px），星座线拉长、画面左右均衡；
    // 模块层和打开笔记后位置相同，右侧栏滑入时队列不跳动
    const panelLeft = W - clamp(W * .33, 380, 470) - 44;
    const n = L.fanRows || L.items.length;      // 含「还有 N 条」那一行，几何才算得准
    const span = Math.min(fanSpan(H), Math.max(0, n - 1) * 54);
    const originX = colX + 16 + 300 * .5 + 10 + 168;
    res.fan = {x: Math.min(Math.max(panelLeft - 270 - 90, originX + 60), panelLeft - 280), y0: cy - span / 2, gap: n > 1 ? span / (n - 1) : 0};
  }
  return res;
}

// 选中的模块排在列的正中间，其余模块按原顺序分列上下，星座线从中间向上下对称展开。
// 模块数量可变（5 或 6）：选中位 = (N-1)/2。
function slotOf(selId, id) {
  const others = MODULES.filter(m => m.id !== selId).map(m => m.id);
  const mid = Math.floor(others.length / 2);
  const order = [...others.slice(0, mid), selId, ...others.slice(mid)];
  const k = order.indexOf(id);
  return k < 0 ? MODULES.findIndex(m => m.id === id) : k;
}

function spring(st, target, dt, k = 62) {
  const c = 2 * Math.sqrt(k);
  st.v += (-k * (st.x - target) - c * st.v) * dt;
  st.x += st.v * dt;
  return st.x;
}
const sp = x => ({x, v: 0});

// 星核向外飘散的星尘（星核本地坐标，画布 1012×1012，中心 506）
// 尘埃光点的径向渐变不逐帧新建（130 个/帧会一直制造 GC 压力）：按颜色烘一张精灵图，
// 每帧只改 globalAlpha 再 drawImage，观感不变但少了每帧 130 次 createRadialGradient。
const dustSprites = new Map();
function dustSprite(color) {
  let sp = dustSprites.get(color);
  if (!sp) {
    const SZ = 64;
    sp = document.createElement('canvas');
    sp.width = sp.height = SZ;
    const g2 = sp.getContext('2d');
    const g = g2.createRadialGradient(SZ / 2, SZ / 2, 0, SZ / 2, SZ / 2, SZ / 2);
    g.addColorStop(0, `rgba(${color},1)`);
    g.addColorStop(1, `rgba(${color},0)`);
    g2.fillStyle = g;
    g2.fillRect(0, 0, SZ, SZ);
    dustSprites.set(color, sp);
  }
  return sp;
}

const DUST = Array.from({length: 130}, (_, i) => ({a: i * 2.39996, v: .035 + (i * 37 % 100) / 100 * .06, o: (i * .618034) % 1, w: (i % 2 ? 1 : -1) * (.15 + (i % 7) * .05), s: .7 + (i % 5) * .32, b: .45 + (i % 3) * .25, c: T.dust[i % T.dust.length]}));

// —— 星团 = 七个真实星座（v7.0 落地第 7 个）——
// 知识笔记→天蝎 · 概念→双鱼 · 作品→处女 · 选题→射手 · 草稿→水瓶 · AI 热点→仙女 · 个人知识库→猎户（星座表与坐标口径见 constellations.js）。
// 骨架星位、经典连线、星等全部来自真实星表，图形是**静态**的，所以整幅烘焙成一张离屏画布（每簇一张，2×），
// 逐帧只做一次 drawImage + 主星闪烁 —— 这是 v6.2 定的落地口径（星座层比原来的光球层省 2.8–5.5×）。
// 缩放比不是常量：把窗口拖到另一块缩放不同的屏时它会变，位图必须按新密度重烘焙，否则画面发虚
let DPR = Math.min(window.devicePixelRatio || 1, 2);
const HUB_K = 1, SUB_K = .82;                           // 图形缩放：首屏 1:1，展开层/内页收一档，别压住环系
// 验收实测用：?profile=1 时把「星座层」的逐帧耗时记进 window.__ncProfile（不影响正常路径）
const PROFILE = typeof location !== 'undefined' && /[?&]profile=1/.test(location.search);
const figData = Object.fromEntries(MODULES.map(m => {
  const bake = baked(m.id, DPR);
  return [m.id, {bake, sk: skeleton(m.id), hit: hitOf(m.id), ext: extentOf(m.id), n: countsOf(m.id)}];
}));
// 缩放比变了就按新密度重烘一次七张星团图（一次性成本），旧烘焙画布被整体替换
function rebakeAll() { for (const m of MODULES) figData[m.id] = {...figData[m.id], bake: baked(m.id, DPR)}; }
function syncDPR() {
  const d = Math.min(window.devicePixelRatio || 1, 2);
  if (Math.abs(d - DPR) < .01) return false;
  DPR = d; rebakeAll(); return true;
}

// 每帧绘制一簇：先把烘焙好的星座整幅贴回（骨架星 + 经典连线 + 成员星场），再给骨架主星叠一层闪烁。
// 星位是真的、静止的；只有主星在呼吸 —— 悬停/选中时整幅提亮一档，不改形状。
function drawCluster(canvas, data, t, on, reduced, hot) {
  if (!canvas || !data) return;
  const B = data.bake.box, ctx = canvas.getContext('2d');
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, B, B);
  ctx.drawImage(data.bake.canvas, 0, 0, B, B);
  if (on) {                                               // 悬停 / 选中：整幅加一层叠加亮，像被星光照到
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = .26;
    ctx.drawImage(data.bake.canvas, 0, 0, B, B);
    ctx.restore();
  }
  ctx.save();
  ctx.translate(B / 2, B / 2);
  ctx.globalCompositeOperation = 'lighter';
  for (const s of data.sk) {
    const x = s.x, y = s.y;
    const tw = reduced ? 1 : .60 + .40 * Math.sin(t * (.42 + s.idx * .11) + s.idx * 1.7) * Math.sin(t * (.19 + s.idx * .043) + s.idx * 2.3);
    ctx.globalAlpha = Math.max(.22, tw) * (.30 + s.m * .70) * (on ? 1 : .88);
    ctx.fillStyle = 'rgb(255,252,244)';
    ctx.beginPath(); ctx.arc(x, y, 1.15 + s.m * 1.5, 0, 6.284); ctx.fill();
    if (hot === s.idx) {                                  // 悬停单星：放大一档 + 光晕 + 一圈金环（v6.2 §7.6）
      const r0 = 9 + s.m * 16;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r0);
      g.addColorStop(0, 'rgba(255,250,238,.85)'); g.addColorStop(1, 'rgba(255,250,238,0)');
      ctx.globalAlpha = .85; ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r0, 0, 6.284); ctx.fill();
      ctx.globalAlpha = .9; ctx.strokeStyle = 'rgba(232,200,132,.8)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, 10 + s.m * 4, 0, 6.284); ctx.stroke();
    }
  }
  ctx.restore();
}

const bez = (p0, p1, p2, p3, u) => { const m = 1 - u; return m * m * m * p0 + 3 * m * m * u * p1 + 3 * m * u * u * p2 + u * u * u * p3; };

function Scene({graph, items, more, onModule, onItem, live, sel, dpr}) {
  const dustRef = useRef(null), coreRef = useRef(null);
  const clusterRefs = useRef({}), canvasRefs = useRef({}), labelRefs = useRef({}), threadRefs = useRef({}), pulseRefs = useRef({});
  const itemRefs = useRef([]), fanRefs = useRef([]), fanPulseRefs = useRef([]), moreRef = useRef(null);
  // 命中区被 clip-path 裁掉，outline 会一起被裁：焦点环画在没被裁剪的 .cluster 上（键盘可达性）
  const [kbMod, setKbMod] = useState(null);
  const summaries = useMemo(() => Object.fromEntries(MODULES.map(m => [m.id, moduleSummary(graph, m)])), [graph]);
  // 星座图形（figData）在模块加载时烘焙一次，六簇共用；这里只留每簇的标签数据
  const clusterData = figData;

  useLayoutEffect(() => { live.current.itemState = items.map(() => null); live.current.moreState = null; live.current.fanStart = performance.now(); }, [items, live]);

  // 命中按骨架主星就近（v6.2 §7.6）：指针落在簇的命中区里，就点亮 24 设计像素内最近的那颗主星。
  // 整簇仍然是一个可点区域，悬停/选中/扇面展开的状态机没有变。
  const onStar = useCallback((m, e) => {
    const el = clusterRefs.current[m.id], art = figData[m.id];
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r.width) return;
    const k = r.width / art.bake.box;
    const px = (e.clientX - r.left) / k, py = (e.clientY - r.top) / k;
    let bi = -1, bd = 24 * 24;
    art.sk.forEach((s, i) => {
      const d = (s.x - px) ** 2 + (s.y - py) ** 2;
      if (d < bd) { bd = d; bi = i; }
    });
    live.current.hoverStar = bi < 0 ? null : {id: m.id, idx: bi};
    live.current.kick?.();                 // reduced 下帧循环是停的，交互要把它叫醒
  }, [live]);

  useEffect(() => {
    let raf, last = performance.now();
    const S = live.current.springs;
    const step = now => {
      const L = live.current;
      // rAF 给的是帧开始时间，可能早于上面记录的 last；负的 dt 会让后续计算出现 NaN，所以限制为 ≥ 0
      const dt = Math.max(0, Math.min(1 / 30, (now - last) / 1000)); last = Math.max(last, now);
      if (!L.paused) L.time += dt;
      const t = L.time, since = (now - L.t0) / 1000;
      const Tt = targets(L, t);
      const intro = L.stage === 'hub' && !L.reduced;
      // 星核：脉动、日冕呼吸由 CSS 负责，这里只管位置与缩放
      const coreS = intro && since < .15 ? Tt.core.s * .35 : Tt.core.s;
      const ox = spring(S.core.x, Tt.core.x, dt), oy = spring(S.core.y, Tt.core.y, dt), os = spring(S.core.s, coreS, dt, 40), oo = spring(S.core.o, intro && since < .1 ? 0 : 1, dt, 30);
      L.core = {x: ox, y: oy, s: os};
      if (coreRef.current) { coreRef.current.style.transform = `translate3d(${ox - os / 2}px,${oy - os / 2}px,0) scale(${os / 460})`; coreRef.current.style.opacity = clamp(oo, 0, 1); }
      const dust = dustRef.current;
      if (dust) {
        const di = clamp(spring(S.dust, L.stage === 'hub' ? .3 : 1, dt, 18), 0, 1);
        const ctx = dust.getContext('2d');
        ctx.clearRect(0, 0, 1012, 1012);
        if (!L.reduced && di > .02) {
          const sc = Math.max(os / 460, .2);
          ctx.globalCompositeOperation = 'lighter';
          for (const p of DUST) {
            // 尘埃带从环系外缘之外起步（v4.1 环系占了 172–464 的内圈），只做「逸散出去」的那一段
            const ph = ((t * p.v + p.o) % 1 + 1) % 1, r = 300 + ph * 190, a = p.a + ph * p.w;
            const x = 506 + Math.cos(a) * r, y = 506 + Math.sin(a) * r * .96;
            const al = di * Math.pow(Math.max(0, Math.sin(ph * Math.PI)), 1.3) * p.b * .6, rad = p.s / sc * 2.2;
            ctx.globalAlpha = al;
            ctx.drawImage(dustSprite(p.c), x - rad, y - rad, rad * 2, rad * 2);
          }
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = 'source-over';
        }
      }
      // 星团 = 星座：图形是烘焙好的静态图层，这里只做摆位、贴图、主星闪烁与命中高亮
      const tFig = PROFILE ? performance.now() : 0;
      MODULES.forEach((m, i) => {
        const j = S.cluster[m.id], tg = Tt.cluster[m.id], art = clusterData[m.id];
        const gated = intro && since < 1 + i * .17;
        const x = spring(j.x, gated ? ox : tg.x, dt), y = spring(j.y, gated ? oy : tg.y, dt), s = spring(j.s, gated ? 24 : tg.s, dt), o = spring(j.o, gated ? 0 : tg.o, dt, 40);
        const lo = spring(j.lo, intro && since < 2 + i * .1 ? 0 : tg.o, dt, 40);
        const k = s / BASE * (L.stage === 'hub' ? HUB_K : SUB_K);          // 屏幕尺寸 → 图形缩放
        const B = art.bake.box * k;
        j.cur = {x, y, s, k};
        const el = clusterRefs.current[m.id], lab = labelRefs.current[m.id];
        if (el) { el.style.transform = `translate3d(${x - B / 2}px,${y - B / 2}px,0) scale(${k})`; el.style.opacity = clamp(o, 0, 1); }
        const on = m.id === L.mod || L.hover === m.kind;
        drawCluster(canvasRefs.current[m.id], art, t, on, L.reduced || L.paused, L.hoverStar && L.hoverStar.id === m.id ? L.hoverStar.idx : -1);
        if (lab) {
          const lw = lab.offsetWidth, lh = lab.offsetHeight;
          const hub = L.stage === 'hub', narrow = L.size.w < 760;
          // 标注贴着**自己的星座图形**、朝「背离星核」的一侧：
          // 方向取模块自己的名义角度（不是瞬时位置，否则呼吸摆动会让标签上下跳），
          // 距离 = 骨架外沿在该方向上的支撑距离 + 一点净空 + 标注自身的一半 —— 于是标注永远挨着星座、不压星核区。
          const a0 = m.angle * Math.PI / 180, nX = Math.cos(a0), nY = Math.sin(a0);
          const sup = (Math.abs(nX) * art.ext.hx + Math.abs(nY) * art.ext.hy) * k;
          const gap = sup + 14 + (Math.abs(nX) * lw + Math.abs(nY) * lh) / 2;
          const lx0 = hub ? x + nX * gap - lw / 2 : narrow ? x - lw / 2 : x + art.ext.hx * k + 12;
          const ly0 = hub ? y + nY * gap - lh / 2 : narrow ? y + art.ext.hy * k + 12 : y - lh / 2;
          const lx = clamp(lx0, 10, Math.max(10, L.size.w - lw - 10));
          const ly = clamp(ly0, 72, Math.max(72, L.size.h - lh - 10));
          lab.style.transform = `translate3d(${lx}px,${ly}px,0)`;
          lab.style.opacity = clamp(narrow && !hub && m.id !== L.mod ? 0 : lo, 0, 1);
          j.label = {x: lx, y: ly, w: lw, h: lh};
        }
        // 星核 → 星团：金色星座线与缓慢流动的光粒
        const g = threadRefs.current[m.id];
        if (g) {
          let x1, y1, x2, y2, c1x, c1y, c2x, c2y;
          // 星座线收在**图形外沿**上（不是箱子边上）：从星核这侧最近的一颗骨架星附近收笔
          if (L.stage === 'hub') {
            const dx = x - ox, dy = y - oy, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
            const near = (Math.abs(ux) * art.ext.hx + Math.abs(uy) * art.ext.hy) * k;
            x1 = ox + ux * os * .2; y1 = oy + uy * os * .2; x2 = x - ux * near; y2 = y - uy * near;
            const bend = 26 * Math.sin(t * .5 + i);
            c1x = x1 + dx * .35 - uy * bend; c1y = y1 + dy * .35 + ux * bend; c2x = x1 + dx * .7 + uy * bend; c2y = y1 + dy * .7 - ux * bend;
          } else {
            x1 = ox + os * .3; y1 = oy; x2 = x - art.ext.hx * k; y2 = y;
            const dx = x2 - x1; c1x = x1 + dx * .55; c1y = y1; c2x = x2 - dx * .55; c2y = y2;
          }
          const d = `M${x1},${y1} C${c1x},${c1y} ${c2x},${c2y} ${x2},${y2}`;
          const active = on;
          g.glow.setAttribute('d', d); g.core.setAttribute('d', d);
          const vis = clamp(o, 0, 1) * (L.stage === 'hub' ? 1 : active ? 1 : .45);
          g.glow.style.opacity = vis * (active ? .95 : .5); g.core.style.opacity = vis;
          const pulses = pulseRefs.current[m.id] || [];
          pulses.forEach((c, k) => {
            if (!c) return;
            const inbound = k === 2;
            let u = ((t * (inbound ? .09 : .12) + k * .5 + i * .17) % 1);
            if (inbound) u = 1 - u;
            c.setAttribute('cx', bez(x1, c1x, c2x, x2, u)); c.setAttribute('cy', bez(y1, c1y, c2y, y2, u));
            c.style.opacity = L.reduced || L.paused ? 0 : vis * Math.sin(u * Math.PI);
          });
        }
      });
      if (PROFILE) {                                      // 星座层的逐帧净耗时（摆位 + 贴图 + 闪烁 + 标注）
        const arr = window.__ncProfile || (window.__ncProfile = []);
        arr.push(performance.now() - tFig);
        if (arr.length > 6000) arr.splice(0, 3000);
      }
      // 选中星团 → 团内恒星列队展开（星座线一根根显形）

      const sj = L.mod && S.cluster[L.mod];
      if (Tt.fan && sj?.label) {
        const narrow = L.size.w < 760;
        const ox2 = narrow ? sj.label.x + sj.label.w / 2 : sj.label.x + sj.label.w + 6, oy2 = narrow ? sj.label.y + sj.label.h + 4 : sj.cur.y;
        items.forEach((n, i) => {
          if (!L.itemState[i]) L.itemState[i] = {x: sp(ox2), y: sp(oy2), o: sp(0)};
          const st = L.itemState[i];
          // 星座线一根一根依次点亮（20 条约 1.8 秒），形成依次连线的节奏
          const ready = L.reduced || now - L.fanStart > 160 + i * Math.min(90, 1800 / Math.max(items.length, 1));
          const tx = Tt.fan.x, ty = Tt.fan.y0 + i * Tt.fan.gap + (L.reduced ? 0 : Math.sin(t * .8 + i * .9) * 2);
          const x = spring(st.x, ready ? tx : ox2, dt, 70), y = spring(st.y, ready ? ty : oy2, dt, 70), o = spring(st.o, ready ? 1 : 0, dt, 50);
          const el = itemRefs.current[i];
          if (el) { el.style.transform = `translate3d(${x}px,${y - 15}px,0)`; el.style.opacity = clamp(o, 0, 1); }
          const p = fanRefs.current[i];
          if (p) {
            const dx = x - ox2, sway = L.reduced ? 0 : Math.sin(t * 1.1 + i * .7) * 7;
            const c1x = ox2 + dx * .5, c1y = oy2 + sway, c2x = x - dx * .45, c2y = y - sway * .5;
            p.setAttribute('d', `M${ox2},${oy2} C${c1x},${c1y} ${c2x},${c2y} ${x},${y}`);
            const on = sel === n.id;
            p.style.opacity = clamp(o, 0, 1) * (sel ? (on ? 1 : .35) : .8);
            p.style.strokeWidth = on ? 1.8 : 1;
            (fanPulseRefs.current[i] || []).forEach((c, k) => {
              if (!c) return;
              let u = (t * (k ? .09 : .13) + i * .13 + k * .5) % 1;
              if (k) u = 1 - u;
              c.setAttribute('cx', bez(ox2, c1x, c2x, x, u)); c.setAttribute('cy', bez(oy2, c1y, c2y, y, u));
              c.style.opacity = L.reduced || L.paused ? 0 : clamp(o, 0, 1) * Math.sin(u * Math.PI) * (sel && !on ? .3 : 1);
            });
          }
        });
        // 屏幕放不下的部分只留一行说明（列队超过可读行数时不再堆叠）
        const me = moreRef.current;
        if (me) {
          if (!more) { me.style.opacity = 0; }
          else {
            const ty = Tt.fan.y0 + items.length * Tt.fan.gap;
            if (!L.moreState) L.moreState = {x: sp(ox2), y: sp(oy2), o: sp(0)};
            const st = L.moreState;
            const ready = L.reduced || now - L.fanStart > 160 + items.length * Math.min(90, 1800 / Math.max(items.length, 1));
            const x = spring(st.x, ready ? Tt.fan.x : ox2, dt, 70), y = spring(st.y, ready ? ty : oy2, dt, 70), o = spring(st.o, ready ? 1 : 0, dt, 50);
            me.style.transform = `translate3d(${x}px,${y - 15}px,0)`;
            me.style.opacity = clamp(o, 0, 1) * .85;
          }
        }
      }
      // 「减少动态效果」下据此决定还要不要继续排帧：所有弹簧都贴住目标就停循环
      if (L.reduced) {
        let moving = Math.abs(ox - Tt.core.x) > .5 || Math.abs(oy - Tt.core.y) > .5 || Math.abs(os - Tt.core.s) > .5;
        if (!moving) for (const m of MODULES) {
          const j = S.cluster[m.id], tg = Tt.cluster[m.id];
          if (Math.abs(j.x - tg.x) > .5 || Math.abs(j.y - tg.y) > .5 || Math.abs(j.s - tg.s) > .5 || Math.abs(j.o - tg.o) > .5) { moving = true; break; }
        }
        if (!moving && Tt.fan) for (let i = 0; i < items.length; i++) {
          const st = L.itemState[i];
          if (st && (Math.abs(st.x - Tt.fan.x) > 1 || Math.abs(st.y - (Tt.fan.y0 + i * Tt.fan.gap)) > 1 || Math.abs(st.o - 1) > .04)) { moving = true; break; }
        }
        L.moving = moving;
      } else L.moving = true;
    };
    // 每帧先排好下一帧再执行：某一帧出错也不会让星核与星团停住。
    // 「减少动态效果」下画面本来就是静止的（脉冲恒为 0、摆动为 0），弹簧一旦收敛就不再排帧，
    // 否则 60fps 每帧写几十个 style 纯属空转；交互（悬停/选中/尺寸变化）通过 kick 重新起循环。
    let warned = false;
    const frame = now => { raf = requestAnimationFrame(frame); try { step(now); } catch (err) { if (!warned) { warned = true; console.error(err); } } if (live.current.reduced && !live.current.moving) { cancelAnimationFrame(raf); raf = 0; } };
    raf = requestAnimationFrame(frame);
    live.current.kick = () => { if (!raf) { live.current.moving = true; raf = requestAnimationFrame(frame); } live.current.netKick?.(); };
    return () => {
      cancelAnimationFrame(raf); raf = 0;
      if (live.current) live.current.kick = null;
    };
  }, [items, live, sel, clusterData, dpr, size]);

  const hub = live.current.stage === 'hub';
  // 行距不足 30px 时只留标题一行，两行会叠在一起看不清（与 targets() 用同一套算法）
  const rows = items.length + (more > 0 ? 1 : 0);
  const denseGap = rows > 1 ? Math.min(fanSpan(live.current.size.h), (rows - 1) * 54) / (rows - 1) : 54;
  const dense = denseGap < 30;
  return <div className={`scene stage-${live.current.stage} ${dense ? 'dense' : ''}`}>
    <div className="core-star" ref={coreRef} aria-hidden="true">
      <div className="cs-halo"/>
      <div className="cs-flare"/>
      <div className="cs-corona"/>
      <div className="cs-rays"/>
      <div className="cs-nucleus"/>
      <StarCore live={live} reduced={live.current.reduced} graph={graph}/>
      <canvas className="cs-dust" ref={dustRef} width="1012" height="1012"/>
    </div>
    <svg className="threads" aria-hidden="true">
      <defs>
        <filter id="thread-blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3.2"/></filter>
        <radialGradient id="pulse-out"><stop offset="0" stopColor={T.pulse.out[0]}/><stop offset=".4" stopColor={T.pulse.out[1]}/><stop offset="1" stopColor={T.pulse.out[1]} stopOpacity="0"/></radialGradient>
        <radialGradient id="pulse-in"><stop offset="0" stopColor={T.pulse.in[0]}/><stop offset=".4" stopColor={T.pulse.in[1]}/><stop offset="1" stopColor={T.pulse.in[1]} stopOpacity="0"/></radialGradient>
      </defs>
      {MODULES.map(m => <g key={m.id} style={{color: T.link.near}}>
        <path ref={el => { threadRefs.current[m.id] = {...threadRefs.current[m.id], glow: el}; }} className="thread-glow" filter="url(#thread-blur)"/>
        <path ref={el => { threadRefs.current[m.id] = {...threadRefs.current[m.id], core: el}; }} className="thread-core"/>
        {[0, 1, 2].map(k => <circle key={k} r={k === 2 ? 4.5 : 5.5} fill={`url(#${k === 2 ? 'pulse-in' : 'pulse-out'})`} ref={el => { (pulseRefs.current[m.id] ||= [])[k] = el; }}/>)}
      </g>)}
      {items.map((n, i) => <g key={n.id} style={{color: T.link.far}}>
        <path className="fan-thread" ref={el => { fanRefs.current[i] = el; }}/>
        {[0, 1].map(k => <circle key={k} r={k ? 3.5 : 4.5} fill={`url(#${k ? 'pulse-in' : 'pulse-out'})`} ref={el => { (fanPulseRefs.current[i] ||= [])[k] = el; }}/>)}
      </g>)}
    </svg>
    {MODULES.map(m => {
      const sum = summaries[m.id], active = live.current.mod === m.id, art = figData[m.id];
      const [zh, en] = nameOf(m.id);
      return <React.Fragment key={m.id}>
        <div className={`cluster ${active ? 'active' : ''} ${kbMod === m.id ? 'kbd' : ''}`} ref={el => { clusterRefs.current[m.id] = el; }} style={{width: art.bake.box, height: art.bake.box}}>
          <canvas className="cl-canvas" width={Math.round(art.bake.box * dpr)} height={Math.round(art.bake.box * dpr)} ref={el => { canvasRefs.current[m.id] = el; }}/>
          {/* 命中区 = 骨架外沿多边形（不是整张画布的 bbox）：细长的星座不会用空角挡住旁边的星座与标签 */}
          <button className="cl-hit" onClick={() => onModule(m.id)}
            style={{left: art.bake.box / 2 + art.hit.cx - art.hit.w / 2, top: art.bake.box / 2 + art.hit.cy - art.hit.h / 2, width: art.hit.w, height: art.hit.h, clipPath: `polygon(${art.hit.clip})`}}
            onPointerEnter={() => { live.current.hover = m.kind; live.current.kick?.(); }} onPointerMove={e => onStar(m, e)} onPointerLeave={() => { live.current.hover = null; live.current.hoverStar = null; live.current.kick?.(); }}
            onFocus={e => { if (e.target.matches(':focus-visible')) { setKbMod(m.id); live.current.kick?.(); } }} onBlur={() => setKbMod(k => (k === m.id ? null : k))}
            aria-label={`${zh} ${en} · ${m.title} ${m.en}，${art.n.stars} 主星 ${art.n.edges} 连线 · ${sum.count} 条`}/>
        </div>
        <button className={`cluster-label ${active ? 'active' : ''} ${hub ? 'below' : 'side'}`} ref={el => { labelRefs.current[m.id] = el; }} onClick={() => onModule(m.id)} tabIndex={-1}
          onPointerEnter={() => { live.current.hover = m.kind; live.current.kick?.(); }} onPointerLeave={() => { live.current.hover = null; live.current.kick?.(); }} style={{'--mod': MOD_STYLE[m.id].color}}>
          <span className="jl-icon"><Icon name={m.icon} size={14}/></span>
          <span className="jl-count"><b>{sum.count}</b></span>
          <span className="jl-const"><b>{zh}</b><em>{en.toUpperCase()}</em></span>
          <span className="jl-name">{m.title}<em>{m.en}</em></span>
          <span className="jl-sky">{art.n.stars} 主星 · {art.n.edges} 连线</span>
          <span className="jl-sub">{sum.sub[0]} {sum.sub[1]} <em>{sum.sub[2]}</em></span>
        </button>
      </React.Fragment>;
    })}
    {items.map((n, i) => {
      const meta = itemMeta(n);
      return <button key={n.id} className={`fan-item ${sel === n.id ? 'active' : ''} kind-${n.kind}`} ref={el => { itemRefs.current[i] = el; }} onClick={() => onItem(n.id)} style={{'--kc': KINDS[n.kind].color}} aria-label={`打开 ${n.title} 的分析 Open analysis`}>
        <span className="fi-dot"/>
        <span className="fi-body">
          <span className="fi-title">{n.short || n.title}</span>
          <span className="fi-meta">{meta.map(([k, en, v], j) => <span key={j} className={k === '↔' ? 'mutual' : ''}>{k}{en && <em>{en}</em>} {v !== '' && <b>{v}</b>}</span>)}</span>
        </span>
      </button>;
    })}
    {more > 0 && <p className="fan-more" ref={moreRef} style={{'--kc': T.kinds.ghost}}><span className="fi-dot"/>还有 {more} 条 · <em>{more} more in this cluster</em></p>}
  </div>;
}

function Dock({graph, onGo}) {
  const s = useMemo(() => stats(graph), [graph]);
  const [q, setQ] = useState('');
  const [cards, setCards] = useState(null);
  const typing = useRef(null);
  const after = useRef(null); // 打字结束后延迟出结果的那一次定时器，卸载时也要清
  const ask = text => { if (text.trim()) setCards({q: text, list: askGraph(graph, text)}); };
  const typeAsk = text => {
    clearInterval(typing.current);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setQ(text); ask(text); return; }
    let i = 0; setQ('');
    typing.current = setInterval(() => {
      i++; setQ(text.slice(0, i));
      if (i >= text.length) {
        clearInterval(typing.current);
        typing.current = null;
        after.current = setTimeout(() => { after.current = null; ask(text); }, 220);
      }
    }, 45);
  };
  useEffect(() => () => { clearInterval(typing.current); clearTimeout(after.current); }, []);
  const kpis = [['内容节点', 'Notes', s.content], ['连接', 'Links', s.links], ['双向共振', 'Mutual', s.mutual], ['未创建', 'Unresolved', s.ghosts]];
  return <div className="dock">
    {cards && <section className="ask-results glass" aria-live="polite">
      <header><span><Icon name="spark" size={14}/>图谱分析 <em>Graph analysis</em></span><small>本地规则检索 · Local rules, no AI</small><button className="icon-btn" aria-label="关闭分析 Close analysis" onClick={() => setCards(null)}><Icon name="close" size={14}/></button></header>
      <div className="ask-cards">{cards.list.map((c, i) => <article key={i} className={`ask-card tone-${c.tone}`} style={{animationDelay: i * 90 + 'ms'}}>
        <h4>{c.title} <em>{c.en}</em></h4>
        <p>{c.text}</p>
        {c.items?.length > 0 && <div className="chip-row">{c.items.slice(0, 8).map((id, k) => <button key={id} className="chip" style={{'--kc': KINDS[graph.index.get(id)?.kind]?.color}} onClick={() => onGo(id)}>{c.names[k]}{c.meta?.[k] && <small>{c.meta[k]}</small>}</button>)}</div>}
        {c.pairs && <div className="pair-list">{c.pairs.map(([a, b, why], k) => <button key={k} onClick={() => onGo(a)}><span>{graph.index.get(a)?.short}</span><i>⇄</i><span>{graph.index.get(b)?.short}</span><small>{why}</small></button>)}</div>}
      </article>)}</div>
    </section>}
    <div className="dock-panel glass">
      <div className="dock-kpis">{kpis.map(([k, en, v]) => <div key={k}><span>{k} <em>{en}</em></span><strong className="mono">{v}</strong></div>)}</div>
      <form className="ask" onSubmit={e => { e.preventDefault(); ask(q); }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="问问你的创作图谱… Ask your graph" aria-label="向图谱提问 Ask your graph"/>
        <button className="send" aria-label="提交问题 Send question"><Icon name="send" size={16}/></button>
      </form>
      <div className="dock-chips">
        <span className="me"><Icon name="agent" size={13}/>我的图谱 <em>My graph</em></span>
        {['双向连接有哪些？', '最核心的内容', '下一篇写什么', '未创建的笔记'].map(x => <button key={x} onClick={() => typeAsk(x)}>{x}</button>)}
      </div>
    </div>
  </div>;
}

export function Home({graph, layout, focus, setFocus, onAction, onAbout, reduced, aiEnabled, embedEnabled}) {
  const stageRef = useRef(null);
  const [size, setSize] = useState({w: 1280, h: 760});
  const [paused, setPaused] = useState(false);
  const {mod, sel} = focus;
  const stage = sel ? 'note' : mod ? 'module' : 'hub';
  const items = useMemo(() => moduleItems(graph, mod), [graph, mod]);
  // 图例原来对 8 个 kind 各 filter 一遍 graph.nodes（每次 render 8 × N 次比较）。
  const kindCounts = useMemo(() => {
    const c = {};
    for (const n of graph.nodes) c[n.kind] = (c[n.kind] || 0) + 1;
    return c;
  }, [graph]);
  // 列队行距不足 26px 时会叠在一起看不清：只列出放得下的部分，剩下的用一行说明
  const maxRows = useMemo(() => rowsThatFit(Math.max(size.h, 560)), [size.h]);
  const shown = useMemo(() => (items.length > maxRows ? items.slice(0, maxRows - 1) : items), [items, maxRows]);   // 留一格给「还有 N 条」
  const more = items.length - shown.length;
  // 帧循环的 effect 依赖 items 的身份：这里必须是稳定引用，否则每次重渲染都会重启循环、把列队动画倒回去
  const sceneItems = useMemo(() => (stage === 'hub' ? [] : shown), [stage, shown]);
  // 缩放比（拖到另一块缩放不同的屏会变）：变了要重烘位图并重绘
  const [dpr, setDpr] = useState(DPR);
  useEffect(() => {
    const sync = () => { if (syncDPR()) setDpr(DPR); };
    window.addEventListener('resize', sync);
    let mq = null;
    try { mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`); mq.addEventListener?.('change', sync); } catch {}
    return () => { window.removeEventListener('resize', sync); mq?.removeEventListener?.('change', sync); };
  }, []);
  const live = useRef(null);
  if (!live.current) {
    const now = performance.now();
    live.current = {t0: now, time: 0, stage, mod, items, size, reduced, paused: false, hover: null, itemState: [], fanStart: now, moving: true, core: {x: 640, y: 380, s: 400},
      springs: {dust: sp(.3), core: {x: sp(size.w / 2), y: sp(size.h / 2), s: sp(120), o: sp(0)}, cluster: Object.fromEntries(MODULES.map(m => [m.id, {x: sp(size.w / 2), y: sp(size.h / 2), s: sp(20), o: sp(0), lo: sp(0)}]))}};
    let seen = false;
    try { seen = !!sessionStorage.getItem('neural-intro-seen'); } catch {}
    live.current.introSeen = reduced || seen;
    if (live.current.introSeen) live.current.t0 = now - 6000;
  }
  Object.assign(live.current, {stage, mod, items: shown, fanRows: shown.length + (more > 0 ? 1 : 0), size, reduced, paused});
  useLayoutEffect(() => {
    const el = stageRef.current;
    const measure = () => {
      const w = el.clientWidth, h = el.clientHeight, L = live.current, S = L.springs;
      // 开场刚开始时把星核与星团的起点放到真实中心（默认尺寸的中心在大屏上偏左上，开场会像从旁边飞进来）
      if (L.stage === 'hub' && performance.now() - L.t0 < 300) {
        const o = targets({...L, size: {w, h}}, 0).core;
        Object.assign(S.core, {x: sp(o.x), y: sp(o.y)});
        for (const m of MODULES) Object.assign(S.cluster[m.id], {x: sp(o.x), y: sp(o.y)});
        L.core = {...L.core, x: o.x, y: o.y};
      }
      setSize({w, h});
    };
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { try { sessionStorage.setItem('neural-intro-seen', '1'); } catch {} }, []);
  useEffect(() => {
    const key = e => {
      if (e.key !== 'Escape' || e.isComposing || document.querySelector('.veil')) return;
      if (sel) setFocus({mod, sel: null}); else if (mod) setFocus({mod: null, sel: null});
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [mod, sel, setFocus]);

  const go = useCallback(id => {
    const n = graph.index.get(id), m = moduleOf(n);
    if (m) setFocus({mod: m.id, sel: id});
  }, [graph, setFocus]);
  const replay = () => {
    const L = live.current, now = performance.now();
    L.t0 = now; L.time = 0;
    const S = L.springs;
    S.core.s.x = 120; S.core.o.x = 0;
    for (const m of MODULES) Object.assign(S.cluster[m.id], {x: sp(L.core.x), y: sp(L.core.y), s: sp(20), o: sp(0), lo: sp(0)});
    setFocus({mod: null, sel: null});
  };
  const node = sel ? graph.index.get(sel) : null;
  const m = MODULES.find(x => x.id === mod);
  const s = stats(graph);

  return <section ref={stageRef} className={`home-stage stage-${stage} ${live.current.introSeen ? 'intro-done' : ''}`} aria-label="创作星图 Creator graph">
    <div className="stage-bg"/>
    <NetworkCanvas graph={graph} layout={layout} live={live} reduced={reduced}/>
    <Scene graph={graph} items={sceneItems} more={stage === 'hub' ? 0 : more} sel={sel} live={live} dpr={dpr} onModule={id => setFocus({mod: id === mod && stage !== 'hub' ? mod : id, sel: null})} onItem={id => setFocus({mod, sel: id})}/>

    <div className="hub-copy" aria-hidden={stage !== 'hub'}>
      <p className="eyebrow">{CONFIG.brand.name} · {CONFIG.brand.sub} <span>{CONFIG.brand.tagline}</span></p>
      <h1>让每一条链接，<br/>双向生长。</h1>
      <p className="hub-en">Every link grows both ways.</p>
      <p className="hub-meta">{MODULES.length} 个星团 <em>clusters</em> · {s.content} 颗恒星 <em>stars</em> · {s.links} 条星座线 <em>links</em></p>
      <p className="hub-hint">点击星团，展开星座 · <em>Tap a cluster to expand</em></p>
    </div>

    {stage !== 'hub' && <nav className="crumbs" aria-label="图谱路径 Graph path">
      <button className="crumb-back" onClick={() => setFocus(sel ? {mod, sel: null} : {mod: null, sel: null})} aria-label="返回上一层 Back one level"><Icon name="back" size={16}/></button>
      <button onClick={() => setFocus({mod: null, sel: null})}>创作空间 <em>Core</em></button>
      <span>/</span>
      <button onClick={() => setFocus({mod, sel: null})} style={{color: MOD_STYLE[mod].color}}>{m.title} <em>{m.en}</em></button>
      {node && <><span>/</span><b>{node.short || node.title}</b></>}
    </nav>}

    <div className="stage-tools glass" role="toolbar" aria-label="动画控制 Animation controls">
      <button onClick={replay} data-tip="重播开场 Replay" aria-label="重播开场 Replay intro"><Icon name="replay" size={15}/><span>重播 <em>Replay</em></span></button>
      <button onClick={() => setPaused(!paused)} data-tip={paused ? '继续（环系与呼吸继续走）Resume' : '暂停（定格在当前相位）Pause'} aria-pressed={paused} aria-label={paused ? '继续' : '暂停'}><Icon name={paused ? 'play' : 'pause'} size={15}/><span>{paused ? '继续' : '暂停'} <em>{paused ? 'Resume' : 'Pause'}</em></span></button>
      <button onClick={onAbout} data-tip="数据来源与图谱推导 About" aria-label="数据来源 Data source"><Icon name="info" size={15}/><span>数据来源 <em>Sources</em></span></button>
    </div>

    {stage === 'hub' && <div className="legend glass" aria-label="图例 Legend">
      <h3>图例 <em>Legend</em></h3>
      {['post', 'note', 'personal', 'idea', 'draft', 'concept', 'tag', 'ghost'].map(k => <div key={k}><i style={{'--kc': KINDS[k].color}} className={k === 'ghost' ? 'ghost' : ''}/>{KINDS[k].label} <em>{KINDS[k].en}</em><b className="mono">{kindCounts[k] || 0}</b></div>)}
      <div className="legend-lines"><span><i className="ln mutual"/>双向 <em>Mutual</em></span><span><i className="ln one"/>单向 <em>One-way</em></span></div>
      <p className="legend-foot">环带宽度 = 节点数 · 外圈 = 概念 <em>Ring width = count</em></p>
    </div>}
    {stage === 'hub' && <Dock graph={graph} onGo={go}/>}
    {stage === 'module' && <p className="module-hint">选择一颗恒星查看全部分析 · <em>Select a star to see its full analysis</em></p>}

    {node && <aside className="analysis-wrap" key={sel}>
      <Analysis graph={graph} node={node} module={m} onGo={go} onAction={onAction} onClose={() => setFocus({mod, sel: null})} aiEnabled={aiEnabled} embedEnabled={embedEnabled}/>
    </aside>}
  </section>;
}
