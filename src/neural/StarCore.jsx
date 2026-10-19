import React, {useEffect, useMemo, useRef, useState} from 'react';
import {createCore, bandsOf, outerCountOf, PARAMS} from './v41';

// 星核 v4.1（真看板主视图中心）：Voronoi 米粒镶嵌核 + 木星式环系。
// 与基础版本的差别只在工程侧（见 v41.js 文件头）：
//   · 核体 / 前环暗带走**离屏预渲染**（4 个呼吸相位 + 1 张暗带），逐帧只做合成；
//   · 环系与尘埃逐帧实时画（它们要转），尘埃走预计算三角向量 + 光场查表的快路径；
//   · 纯 Canvas 2D，零 WebGL —— 老机器 / 嵌入式浏览器照样出画面；
//     真拿不到 2D 上下文时退回原来的 CSS 星核（.cs-corona / .cs-nucleus / .cs-rays），不白屏。
export const CORE_BOX = {w: 920, h: 700};   // 画布 CSS 尺寸（含环系的外缘与日珥）

// 现场调参：?grains=16000&cap=.85&tilt=-.30&spin=1.4（只影响本地预览，不改代码）
function urlParams() {
  const out = {};
  try {
    const q = new URLSearchParams(location.search);
    for (const k of ['grains', 'cap', 'tilt', 'spin', 'scale']) {
      const v = Number(q.get(k));
      if (Number.isFinite(v) && v !== 0) out[k] = v;
    }
  } catch {}
  return out;
}
// 抓帧用：?t=<秒> 让星核停在 5 秒周期的某个相位（呼吸 / 环转 / 尘埃都给到同一个 t）。
// 这样截图与 GIF 帧帧可复现，不受无头浏览器抓帧速度影响。
function frozenAt() {
  try {
    const q = new URLSearchParams(location.search);
    if (!q.has('t')) return null;
    const v = Number(q.get('t'));
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

export function StarCore({live, reduced, graph}) {
  const ref = useRef(null);
  const [fallback, setFallback] = useState(false);
  const graphRef = useRef(graph);
  graphRef.current = graph;
  // 只在「各轴节点数」变化时重建星核（环带宽度由它决定）——
  // 改一句草稿就让整组环系重建一次是没必要的，那一帧会白花 0.2 秒
  const sig = useMemo(() => {
    const n = bandsOf(graph).map(b => b.n).join('|');
    return n + '#' + outerCountOf(graph);
  }, [graph]);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    let ctx = null;
    try { ctx = cv.getContext('2d'); } catch { ctx = null; }
    if (!ctx) { setFallback(true); if (cv.parentElement) cv.parentElement.classList.remove('v41-live'); return; }   // 连 2D 都拿不到 → CSS 星核兜底

    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    cv.width = Math.round(CORE_BOX.w * dpr);
    cv.height = Math.round(CORE_BOX.h * dpr);
    const g = graphRef.current;
    const bands = bandsOf(g), outerN = outerCountOf(g);
    const params = {...urlParams()};
    let scene = null;
    try {
      scene = createCore({w: CORE_BOX.w, h: CORE_BOX.h, dpr, params, bands, outerN});
    } catch (err) {
      console.error('[v4.1 星核] 初始化失败，退回 CSS 星核', err);
      if (cv.parentElement) cv.parentElement.classList.remove('v41-live');
      setFallback(true);
      return;
    }

    // 抓帧模式：只画给到的相位，不排帧（截图 / GIF 用）
    const frozen = frozenAt();
    if (frozen != null) {
      scene.render(ctx, frozen);
      if (cv.parentElement) cv.parentElement.classList.add('v41-live');
      window.__v41 = {render: t => scene.render(ctx, t), scene};
      return;
    }

    const L = live.current;
    // 让父级 .core-star 收起旧的 CSS 发光球图层（它们会糊掉核的米粒与暗缝）
    const host = cv.parentElement;
    if (host) host.classList.add('v41-live');
    setFallback(false);
    // 减少动态效果：只出一张静态帧（呼吸、环转、尘埃流全部停下），画面依旧完整
    if (reduced) { try { scene.render(ctx, 0); } catch (err) { console.error(err); } return; }

    let raf = 0, last = performance.now(), acc = 0, count = 0, down = 0;
    const step = now => {
      const dt = Math.max(0, Math.min(1 / 20, (now - last) / 1000));
      last = Math.max(last, now);
      const S = live.current || L;
      if (document.hidden) return;
      if (!S.paused) scene.render(ctx, S.time);
      // 自适应档位：连续 90 帧均值超预算就降一档颗粒密度（最多两档），保证 1080p 稳 60
      if (!S.paused) {
        acc += dt; count++;
        if (count >= 90) {
          const avg = acc / count; acc = 0; count = 0;
          // 阈值必须低于 60Hz 的 16.67ms（1/62≈16.1ms 会让每块 60Hz 屏稳定超预算、必然降两档）：
          // 连续 90 帧均值慢于 ~50fps 才降档，真正的卡顿（低端机/大分辨率）才触发。
          if (avg > 1 / 50 && down < 2) {
            down++;
            const grains = Math.round((params.grains ?? PARAMS.grains) * (down === 1 ? .55 : .34));
            try {
              const next = createCore({w: CORE_BOX.w, h: CORE_BOX.h, dpr, params: {...params, grains}, bands, outerN});
              scene = next;
              if (!S.paused) scene.render(ctx, S.time);
            } catch (err) { console.error('[v4.1 星核] 降档失败，保持当前档位', err); }
          }
        }
      }
    };
    // 先排下一帧、再在 try 里执行本帧：某一帧出错也不会让星核停住
    let warned = false;
    const frame = now => { raf = requestAnimationFrame(frame); try { step(now); } catch (err) { if (!warned) { warned = true; console.error(err); } } };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [sig, live, reduced]);

  return <canvas className={`cs-v41 ${fallback ? 'cs-v41-off' : ''}`} ref={ref} aria-hidden="true"/>;
}
