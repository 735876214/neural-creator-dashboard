import React, {useEffect, useMemo, useRef} from 'react';
import {MODULES} from './graph';
import {T} from './theme';
import {paintConstellation, baked, nameOf, countsOf} from './constellations';

// 内页的星座轨（v6.3）：作品库 / 创作台 / 选题池 三个内页各带一条，
// 六个模块 = 六个星座，与工作台同一套语言（真实星位 + 经典连线 + 骨架星/成员星场）；
// 本页自己的那一个亮着，其余压暗 —— 也就是「哪一页高亮哪个星座」。
// v6.4：上下间距尽量拉宽——展示框放大（150×106 → 168×140），星座本身先大一圈；
//   试过弧线排列，因上下不齐已取消。
// v6.5：**拉平对齐、垂直居中**——ARC 全部归零（展示框尺寸保持 168×140 不变）。
const CW = 168, CH = 140;                                // 每个小星座的展示尺寸（CSS px，按 2× 绘制）
const DPR = Math.min(window.devicePixelRatio || 1, 2);
const cache = new Map();
// 垂距（px，向下为正）：v6.5 起全部为 0 = 六个星座同一基线、居中排列
const ARC = [0, 0, 0, 0, 0, 0];

// 小尺寸烘焙：与主视图同一份数据、同一套画法，只是整体缩放到展示框里
function miniOf(id) {
  const key = id + '@' + DPR;
  if (cache.has(key)) return cache.get(key);
  const art = baked(id, DPR);
  const cv = document.createElement('canvas');
  cv.width = Math.round(CW * DPR); cv.height = Math.round(CH * DPR);
  const g = cv.getContext('2d');
  if (g) {
    const k = Math.min(CW / art.box, CH / art.box) * .94;
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.translate(CW / 2, CH / 2);
    g.scale(k, k);
    try { paintConstellation(g, id, {seed: 3}); } catch (err) { console.error('[v6.3 星座轨] 绘制失败', id, err); }
  }
  cache.set(key, cv);
  return cv;
}

export function ConstellationBand({page, onGo}) {
  const refs = useRef({});
  const figs = useMemo(() => Object.fromEntries(MODULES.map(m => [m.id, miniOf(m.id)])), []);
  useEffect(() => {
    for (const m of MODULES) {
      const el = refs.current[m.id], src = figs[m.id];
      if (!el || !src) continue;
      const g = el.getContext('2d');
      if (!g) continue;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, el.width, el.height);
      g.drawImage(src, 0, 0);
    }
  }, [figs]);
  return <section className="const-band glass" aria-label="六个星座 · 六个模块">
    <div className="cb-copy">
      <p className="cb-title">六个星座 <em>Six constellations</em></p>
      <p className="cb-note">真实星位与经典连线 · 与工作台同一套<em>Real sky positions, classic lines</em></p>
    </div>
    <div className="cb-figs" role="list">
      {MODULES.map((m, i) => {
        const [zh, en] = nameOf(m.id), n = countsOf(m.id), on = m.id === page;
        return <button key={m.id} role="listitem" className={`cb-fig ${on ? 'on' : ''}`}
          onClick={() => onGo && onGo(m.id)} style={{'--mod': T.modules[m.id].color, '--dy': `${ARC[i] ?? 0}px`}}
          aria-current={on ? 'true' : undefined}
          title={`${zh} ${en} · ${m.title} · ${n.stars} 主星 ${n.edges} 连线`}>
          <canvas className="cb-canvas" ref={el => { refs.current[m.id] = el; }} width={Math.round(CW * DPR)} height={Math.round(CH * DPR)} style={{width: CW, height: CH}}/>
          <span className="cb-name"><b>{zh}</b><em>{en.toUpperCase()}</em></span>
          <span className="cb-mod">{m.title}<em>{m.en}</em></span>
        </button>;
      })}
    </div>
  </section>;
}
