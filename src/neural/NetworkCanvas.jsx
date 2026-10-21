import React, {useEffect, useRef} from 'react';
import {KINDS, PARTITION_OF} from './graph';
import {T} from './theme';

const P = T.canvas;
const ADD = P.additive ? 'lighter' : 'source-over';

// 节点光晕与球体、连线光粒：每帧 createRadialGradient 在节点多时是主要开销，
// 这里按颜色烘成精灵图（球体的偏光位置一起烘进去），每帧只 drawImage + globalAlpha。
const sprites = new Map();
// circle=true 时按内切圆裁剪：球体外圈色标不是全透明，不裁的话方框四角会被画成实心方块。
function sprite(key, stops, {size = 64, inner = null, circle = false} = {}) {
  let cv = sprites.get(key);
  if (!cv) {
    cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const g2 = cv.getContext('2d');
    const g = inner
      ? g2.createRadialGradient(inner[0] * size, inner[1] * size, 0, size / 2, size / 2, size / 2)
      : g2.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (const [at, col] of stops) g.addColorStop(at, col);
    g2.fillStyle = g;
    if (circle) { g2.beginPath(); g2.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); g2.clip(); }
    g2.fillRect(0, 0, size, size);
    sprites.set(key, cv);
  }
  return cv;
}
const glowOf = color => sprite('glow:' + color, [[0, color + P.glow], [1, color + '00']]);
const bodyOf = color => sprite('body:' + color, [[0, P.light], [.45, color], [1, color + 'aa']], {inner: [.325, .325], circle: true});
const pulseOf = c => sprite('pulse:' + c, [[0, `rgba(${c},1)`], [1, `rgba(${c},0)`]], {size: 32});

// 背景星图：从星核蔓延出的全部恒星、话题与概念；簇内连线偏亮、跨簇连线细而暗，双向共振走暖金。
export function NetworkCanvas({graph, layout, live, reduced}) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current, ctx = canvas.getContext('2d');
    let raf, W = 0, H = 0, dpr = 1;
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      live.current?.netKick?.();          // reduced 下循环可能已停：改尺寸后要补画
    };
    resize();
    const ro = new ResizeObserver(resize); ro.observe(canvas);

    // 按与创作空间的链接层数决定蔓延顺序。
    // 先建邻接表再 BFS：原来是「每个出队节点扫一遍全部连线」＝ O(N×L)，
    // 1500 节点 / 4000 条边时约 600 万次比较，同步跑在 effect 里会紧跟布局再来一次卡顿。
    const adj = new Map();
    for (const l of graph.links) {
      if (!adj.has(l.a)) adj.set(l.a, []);
      if (!adj.has(l.b)) adj.set(l.b, []);
      adj.get(l.a).push(l.b); adj.get(l.b).push(l.a);
    }
    const depth = new Map([['core', 0]]), q = ['core'];
    while (q.length) {
      const id = q.shift();
      for (const o of adj.get(id) || []) if (!depth.has(o)) { depth.set(o, depth.get(id) + 1); q.push(o); }
    }
    const nodes = graph.nodes.filter(n => n.kind !== 'core').map((n, i) => ({
      n, p: layout[n.id], d: depth.get(n.id) ?? 4, seed: (i * 9301 + 49297) % 233280 / 233280,
      // 伪深度：0.35 = 远景（暗、小、往中心收），1 = 近景（亮、大、往外推），拉开前后层次
      z: .35 + ((i * 2654435761 >>> 0) % 1000) / 1000 * .65,
      r: n.kind === 'folder' ? 3.2 : n.kind === 'tag' ? 1.5 : n.kind === 'concept' ? 2.3 : n.kind === 'ghost' ? 1.9 : 2.2 + Math.min(n.deg, 14) * .22
    }));
    const byId = new Map(nodes.map(x => [x.n.id, x]));
    const links = graph.links.filter(l => byId.has(l.a) && byId.has(l.b)).map((l, i) => ({l, A: byId.get(l.a), B: byId.get(l.b), seed: (i * 7919 % 997) / 997}));
    const sparks = Array.from({length: 90}, (_, i) => ({a: i / 90 * Math.PI * 2 + Math.sin(i * 12.9) * .3, v: .35 + (i * 37 % 100) / 100, s: 1 + (i * 13 % 7) / 3}));
    // 一屏只留少数几个概念名（连接最多的），其余靠悬停点亮，避免文字铺满星图
    const named = new Set([...graph.nodes].filter(n => n.kind === 'concept').sort((a, b) => b.deg - a.deg).slice(0, 7).map(n => n.id));
    const drawNodes = [...nodes].sort((a, b) => a.z - b.z);      // 远的先画

    const draw = now => {
      const L = live.current;
      const t = Math.max(0, (now - L.t0) / 1000);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const cx = L.core.x, cy = L.core.y;
      const sc = (L.core.s / 440) * Math.min(W * .37 / 380, H * .36 / 300) * (L.stage === 'hub' ? 1 : .55);
      const hover = L.hover;
      const hl = hover ? new Set(graph.nodes.filter(n => n.kind === hover).map(n => n.id)) : null;
      // 边的 a/b 是字典序归一过的（graph.js 的 link()），所以「亮邻居」必须双向判断：
      // 只顺着 a→b 走的话，前缀排在前面的邻居（concept:/note: 之类）永远点不亮。
      if (hl) { const seed = [...hl]; for (const l of graph.links) { if (l.kind === 'contain') continue; if (seed.has(l.a)) hl.add(l.b); else if (seed.has(l.b)) hl.add(l.a); } }
      const grow = reduced ? 1 : Math.min(1, Math.max(0, (t - .35) / 2.2));
      const prog = x => reduced ? 1 : Math.min(1, Math.max(0, (t - .4 - x.d * .32 - x.seed * .35) / .9));
      const pos = x => {
        const p = prog(x), ex = 1 - Math.pow(1 - p, 3);
        const sway = reduced || L.paused ? 0 : Math.sin(t * .5 + x.seed * 6.28) * 3;
        // 近景的星往外推一点、远景往中心收一点：同一个力导向布局也有纵深
        const g = (.86 + .30 * x.z) * ex;
        return [cx + x.p[0] * sc * g + sway, cy + x.p[1] * sc * g + Math.cos(t * .4 + x.seed * 9) * (reduced || L.paused ? 0 : 2.5), p];
      };
      for (const x of nodes) x.s = pos(x);

      // 光球点亮时的粒子迸发
      if (!reduced && t < 2.2) {
        const k = t / 2.2;
        ctx.globalCompositeOperation = ADD;
        for (const s of sparks) {
          const d = (40 + s.v * 420) * (1 - Math.pow(1 - k, 2.4)) * (L.core.s / 440);
          const a = Math.max(0, 1 - k) * .9;
          const x = cx + Math.cos(s.a) * d, y = cy + Math.sin(s.a) * d;
          const g = ctx.createLinearGradient(cx + Math.cos(s.a) * d * .6, cy + Math.sin(s.a) * d * .6, x, y);
          g.addColorStop(0, `rgba(${P.spark[0]},0)`); g.addColorStop(1, `rgba(${P.spark[1]},${a})`);
          ctx.strokeStyle = g; ctx.lineWidth = s.s;
          ctx.beginPath(); ctx.moveTo(cx + Math.cos(s.a) * d * .6, cy + Math.sin(s.a) * d * .6); ctx.lineTo(x, y); ctx.stroke();
          ctx.fillStyle = `rgba(${P.spark[2]},${a})`; ctx.beginPath(); ctx.arc(x, y, s.s * .9, 0, 7); ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
      }

      // 连线：全部金色系，簇内亮、跨簇暗；远的更淡，线本身就分出前后景
      for (const k of links) {
        const [x1, y1, p1] = k.A.s, [x2, y2, p2] = k.B.s;
        const p = Math.min(p1, p2) * grow;
        if (p <= .02) continue;
        const on = !hl || (hl.has(k.l.a) && hl.has(k.l.b));
        // 同簇（同分区）连线亮一些，跨簇细而暗
        const cross = PARTITION_OF(k.A.n) !== PARTITION_OF(k.B.n) ? .42 : 1;
        const dz = (k.A.z + k.B.z) * .5;
        // 屏幕距离越远的连线越淡：近处的一小簇线读得清，远处不至于织成一张亮网
        const far = 1 / (1 + Math.hypot(x2 - x1, y2 - y1) / (Math.min(W, H) * .17));
        let a = (k.l.both ? .28 : k.l.kind === 'wiki' ? .24 : k.l.kind === 'contain' ? .12 : .085)
          * p * (on ? 1 : .22) * (hl && on ? 2.2 : 1) * cross * far * (.62 + .38 * dz);
        ctx.strokeStyle = k.l.both ? `rgba(${P.mutual},${a})` : k.l.kind === 'wiki' ? `rgba(${P.wiki},${a})` : `rgba(${P.link},${a})`;
        ctx.lineWidth = k.l.both ? .6 + Math.min(k.l.w, 6) * .22 : .7;
        ctx.beginPath(); ctx.moveTo(x1, y1);
        if (k.l.both) { const mx = (x1 + x2) / 2 + (y2 - y1) * .12, my = (y1 + y2) / 2 - (x2 - x1) * .12; ctx.quadraticCurveTo(mx, my, x2, y2); }
        else ctx.lineTo(x2, y2);
        ctx.stroke();
      }

      // 星座线光粒：单向连接只朝出链方向，双向连接往返传递。
      // 规模降级：连线或节点过多时，光粒与光晕是最贵的部分（每帧上千次 drawImage），
      // 低配设备会掉到 10–20fps 并持续发热；这里直接跳过，节点仍用纯色圆点保持可读。
      const heavy = links.length > 320 || drawNodes.length > 900;
      if (!reduced && !L.paused && grow > .6 && !heavy) {
        ctx.globalCompositeOperation = ADD;
        for (const k of links) {
          if (k.l.kind === 'contain' || k.l.kind === 'tag') continue;
          const on = !hl || (hl.has(k.l.a) && hl.has(k.l.b));
          const speed = k.l.both ? .16 : .12;
          const lanes = k.l.both ? [0, 1] : [0];
          for (const lane of lanes) {
            const u = ((t * speed + k.seed + lane * .5) % 1);
            const fwd = lane === 0 ? (k.l.s === k.l.a) : !(k.l.s === k.l.a);
            const [x1, y1] = fwd ? k.A.s : k.B.s, [x2, y2] = fwd ? k.B.s : k.A.s;
            let x = x1 + (x2 - x1) * u, y = y1 + (y2 - y1) * u;
            if (k.l.both) { const mx = (k.A.s[0] + k.B.s[0]) / 2 + (k.B.s[1] - k.A.s[1]) * .12, my = (k.A.s[1] + k.B.s[1]) / 2 - (k.B.s[0] - k.A.s[0]) * .12; const uu = fwd ? u : 1 - u; x = (1 - uu) ** 2 * k.A.s[0] + 2 * (1 - uu) * uu * mx + uu * uu * k.B.s[0]; y = (1 - uu) ** 2 * k.A.s[1] + 2 * (1 - uu) * uu * my + uu * uu * k.B.s[1]; }
            const a = Math.sin(u * Math.PI) * (on ? .95 : .2) * (PARTITION_OF(k.A.n) !== PARTITION_OF(k.B.n) ? .6 : 1);
            const c = k.l.both ? (lane ? P.mutualIn : P.mutual) : P.pulseOne;
            ctx.globalAlpha = a;
            ctx.drawImage(pulseOf(c), x - 6, y - 6, 12, 12);
          }
        }
        ctx.globalAlpha = 1; // 光粒用的是逐粒 alpha，画完必须还原，后面的节点/文字才不会被压暗
        ctx.globalCompositeOperation = 'source-over';
      }

      // 节点：按伪深度分前后景（远的先画、更暗更小），概念/话题节点再压一档，不抢主角
      for (const x of drawNodes) {
        const [px, py, p] = x.s;
        if (p <= 0) continue;
        const on = !hl || hl.has(x.n.id);
        const color = KINDS[x.n.kind].color;
        const soft = x.n.kind === 'tag' || x.n.kind === 'concept' || x.n.kind === 'ghost' ? .6 : 1;
        const a = p * (on ? .50 : .11) * (.5 + .5 * x.z) * soft;
        const r = x.r * (hl && on ? 1.35 : 1) * (.82 + .22 * x.z);
        ctx.globalAlpha = a;
        if (heavy) {
          // 降级：单色圆点代替「光晕 + 球体」两次位图绘制
          ctx.beginPath(); ctx.arc(px, py, Math.max(1, r * .9), 0, 7); ctx.fillStyle = `rgb(${color})`; ctx.fill();
        } else {
          ctx.globalCompositeOperation = ADD;
          // 渐变跨度按原来的 3.6r 铺开（不是 5r），观感才和逐帧画时一致
          ctx.drawImage(glowOf(color), px - r * 3.6, py - r * 3.6, r * 7.2, r * 7.2);
          ctx.globalCompositeOperation = 'source-over';
        }
        if (heavy) { /* 降级模式：上面已画圆点，不再画球体位图 */ }
        else if (x.n.kind === 'ghost') { ctx.setLineDash([2, 2]); ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(px, py, r + 1, 0, 7); ctx.stroke(); ctx.setLineDash([]); }
        else ctx.drawImage(bodyOf(color), px - r, py - r, r * 2, r * 2);
        // 文字只给少数节点：悬停时全亮，平时只有最常被提及的几个概念、且必须离开中央主角区
        const away = Math.hypot(px - cx, py - cy) > Math.min(W, H) * .27;
        const label = hl ? on && x.n.kind !== 'tag' : named.has(x.n.id) && away;
        if (L.stage === 'hub' && p > .9 && label) {
          ctx.globalAlpha = hl ? a * .9 : Math.max(a * .8, .30);
          ctx.fillStyle = P.label; ctx.font = `${hl ? 11 : 10}px "Songti SC", "Source Han Serif SC", "Noto Serif SC", Georgia, serif`;
          ctx.fillText((x.n.short || x.n.title).slice(0, 14), px + r + 5, py + 3.5);
        }
        ctx.globalAlpha = 1;
      }
    };
    // 每帧先排好下一帧再绘制：某一帧出错也不会让背景网络停住
    // reduced 下画面是静止的：等星核/星团的弹簧收敛（live.moving 由 Home 的 step 维护）就停掉循环，
    // 否则每帧重绘整张星图纯属空转；交互与尺寸变化通过 netKick 叫醒。
    let warned = false;
    const frame = now => {
      if (reduced && !live.current.moving) { raf = 0; return; }
      raf = requestAnimationFrame(frame); try { draw(now); } catch (err) { if (!warned) { warned = true; console.error(err); } }
    };
    raf = requestAnimationFrame(frame);
    live.current.netKick = () => { if (!raf) { live.current.moving = true; raf = requestAnimationFrame(frame); } };
    return () => {
      cancelAnimationFrame(raf); raf = 0;
      if (live.current) live.current.netKick = null;
      ro.disconnect();
    };
  }, [graph, layout, live, reduced]);
  return <canvas ref={ref} className="network-canvas" aria-hidden="true"/>;
}
