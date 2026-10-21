import React from 'react';
import {Icon} from './icons';

// 保存状态徽标：创作台编辑器、目标弹窗共用。
const TEXT = {
  idle: ['保存到 NAS', 'Saves to NAS'],
  saving: ['保存中…', 'Saving…'],
  saved: ['已保存到 NAS', 'Saved to NAS'],
  pending: ['离线，改动暂存在本页内存', 'Offline — kept in this tab'],
  error: ['保存失败', 'Save failed'],
  conflict: ['NAS 文件已被其他编辑器改动', 'Conflict — not overwritten'],
  dropped: ['NAS 上已不存在这个文件，本地改动已放弃', 'File gone — local edits dropped']
};

export function SaveBadge({state}) {
  const s = state?.state || 'idle';
  const [zh, en] = TEXT[s] || TEXT.idle;
  const icon = {saving: 'save', saved: 'check', pending: 'replay', error: 'info', conflict: 'info'}[s] || 'save';
  return <span className={`save-badge sb-${s}`} title={state?.message || ''} role="status">
    <Icon name={icon} size={13}/>{zh} <em>{en}</em>
  </span>;
}

const ACTIONS = new Set(['pending', 'error', 'conflict', 'dropped']);

// 顶部同步横幅：列出未落盘/冲突的条目，提供重试、放弃与冲突处理。
export function SyncBanner({items, onRetry, onOverwrite, onRefresh, onDiff, onDiscard, onDismiss}) {
  const list = items.filter(x => ACTIONS.has(x.state?.state));
  if (!list.length) return null;
  return <div className="sync-banner glass" role="status">
    <span className="sb-title"><Icon name="info" size={14}/>NAS 同步 <em>NAS sync</em></span>
    {list.map(x => <span className="sb-item" key={x.key}>
      <b>{x.label}</b>
      <span>{x.state.message || TEXT[x.state.state]?.[0]}</span>
      {x.state.state === 'conflict' && <button className="text-btn" onClick={() => onDiff?.(x.key)}>对比 <em>Diff</em></button>}
      {x.state.state === 'conflict' && x.state.serverMtime != null && <button className="text-btn" onClick={() => onOverwrite(x.key)}>用我的版本覆盖 <em>Overwrite</em></button>}
      {/* 失败态必须有出口：只给「重试」时，4xx（文件已被删、参数不对）会永远重试失败、横幅常驻 */}
      {(x.state.state === 'pending' || x.state.state === 'error') && <button className="text-btn" onClick={() => onRetry(x.key)}>重试 <em>Retry</em></button>}
      {x.state.state === 'error' && <button className="text-btn" onClick={() => onDiscard?.(x.key)}>放弃本地改动 <em>Discard</em></button>}
      {x.state.state === 'dropped' && <button className="text-btn" onClick={() => onDismiss?.(x.key)}>知道了 <em>Dismiss</em></button>}
    </span>)}
    {list.some(x => x.state.state === 'conflict') && <button className="text-btn" onClick={onRefresh}>刷新载入 NAS 版本 <em>Reload from NAS</em></button>}
  </div>;
}
