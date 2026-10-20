import React, {useMemo} from 'react';
import {Icon} from './icons';
import {Modal} from './useModal';

// —— 409 冲突 diff（obsidian-independence.md P1：冲突 diff 视图）——
// 纯前端行级 LCS（零依赖）。左栏 = NAS 当前版本，右栏 = 本页待写版本；
// 变化行成对显示（NAS 侧红 / 本地侧绿），上下文行灰。三个动作由调用方决定执行方式。

// 行级 LCS diff：返回 [{type: 'same'|'del'|'add', a, b}]，a/b 为两侧行文本。
function diffLines(aText, bText) {
  const a = String(aText || '').split('\n'), b = String(bText || '').split('\n');
  // 编辑距离矩阵（LCS 长度）；个人笔记规模（几百行）可接受
  const n = a.length, m = b.length;
  const dp = Array.from({length: n + 1}, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({type: 'same', a: a[i], b: b[j]}); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({type: 'del', a: a[i], b: ''}); i++; }
    else { out.push({type: 'add', a: '', b: b[j]}); j++; }
  }
  while (i < n) { out.push({type: 'del', a: a[i], b: ''}); i++; }
  while (j < m) { out.push({type: 'add', a: '', b: b[j]}); j++; }
  // 收缩：把连续的 del/add 归并为一段「变化块」（渲染上对齐展示）
  const blocks = [];
  for (const row of out) {
    const last = blocks[blocks.length - 1];
    if (row.type !== 'same' && last?.type === 'change') { last.a.push(row.a); last.b.push(row.b); }
    else if (row.type !== 'same') blocks.push({type: 'change', a: [row.a], b: [row.b]});
    else blocks.push({type: 'same', a: row.a, b: row.b});
  }
  return blocks;
}

export function DiffModal({title, en = 'Conflict diff', aText, bText, aLabel, bLabel, onClose, onKeepServer, onKeepMine}) {
  const blocks = useMemo(() => diffLines(aText, bText), [aText, bText]);
  const changed = blocks.filter(b => b.type === 'change').length;
  return <Modal onClose={onClose} label="冲突对比" className="diff-modal">
      <header><h2>{title} <em>{en}</em></h2><button className="icon-btn" onClick={onClose} aria-label="关闭"><Icon name="close" size={16}/></button></header>
      <p className="quiet">NAS 上的文件在保存期间被其他编辑器改过。下面是两个版本的差异（{changed} 处）——采用哪边由你决定，不会静默覆盖。<em>{changed} changed block(s)</em></p>
      <div className="diff-cols" role="table" aria-label="差异对比">
        <div className="diff-head"><span>{aLabel}</span><span>{bLabel}</span></div>
        <div className="diff-body">
          {blocks.map((blk, i) => blk.type === 'same'
            ? <div className="diff-row same" key={i}><span>{blk.a}</span><span>{blk.b}</span></div>
            : <React.Fragment key={i}>
                {blk.a.map((l, k) => <div className="diff-row del" key={i + '-a' + k}><span>{l || ' '}</span><span/></div>)}
                {blk.b.map((l, k) => <div className="diff-row add" key={i + '-b' + k}><span/><span>{l || ' '}</span></div>)}
              </React.Fragment>)}
        </div>
      </div>
      <div className="form-actions">
        {onKeepServer && <button className="pill ghost" onClick={onKeepServer}>采用 NAS 版本 <em>Take NAS</em></button>}
        {onKeepMine && <button className="pill primary" onClick={onKeepMine}>用我的版本覆盖 <em>Keep mine</em></button>}
        <button className="pill ghost" onClick={onClose}>稍后处理 <em>Later</em></button>
      </div>
  </Modal>;
}
