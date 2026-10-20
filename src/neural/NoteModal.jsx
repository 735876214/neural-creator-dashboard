import React, {useRef, useState} from 'react';
import {Icon} from './icons';
import {apiUrl, refreshData, markSelfWrite} from './persist';
import {Modal} from './useModal';

// —— 脱离外部编辑器的独立创作入口（obsidian-independence.md P0）——
// uploadAttachment：上传图片到 vault 附件目录（99-附件/），返回 ![[名称]] 插入文本。
// NewNoteModal：新建方法笔记（05-方法库）。
// PublishModal：把草稿发布为作品（唯一的作品创建入口），表单填指标，可留空稍后补。

export async function uploadAttachment(file) {
  const res = await fetch(apiUrl('/api/attachment'), {
    method: 'POST',
    headers: {'x-filename': encodeURIComponent(file.name), 'content-type': 'application/octet-stream'},
    body: file
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status);
  markSelfWrite(); // 这次是看板自己写的：自动刷新轮询别把它当外部改动
  await refreshData().catch(() => {});
  return j; // {path, name}
}

// 编辑器通用：上传并在光标处插入 ![[附件名]]。返回错误消息（null = 成功）。
export async function insertImageAtCursor(areaRef, file, onChange) {
  try {
    const j = await uploadAttachment(file);
    const el = areaRef.current;
    const snippet = `![[${j.name}]]`;
    if (el && typeof el.selectionStart === 'number') {
      const s = el.selectionStart, e = el.selectionEnd;
      const value = el.value.slice(0, s) + snippet + el.value.slice(e);
      onChange(value);
      requestAnimationFrame(() => { el.focus(); const pos = s + snippet.length; el.setSelectionRange(pos, pos); });
    } else {
      onChange((el?.value || '') + '\n' + snippet);
    }
    return null;
  } catch (e) { return e.message; }
}

const METRIC_FIELDS = [
  ['views', '观看', 'Views'], ['likes', '点赞', 'Likes'], ['comments', '评论', 'Comments'],
  ['saves', '收藏', 'Saves'], ['shares', '分享', 'Shares'], ['follows', '涨粉', 'Follows']
];

// 新建方法笔记：标题 + 正文 + 话题标签
export function NewNoteModal({onClose, onDone}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef(null);

  const save = async () => {
    if (!title.trim() || busy) return;
    setBusy(true); setErr('');
    try {
      const res = await fetch(apiUrl('/api/note-new'), {method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({title, body, fm: {tags: tags.split(/[,，\s]+/).filter(Boolean)}})});
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status);
      markSelfWrite(); // 这次是看板自己写的：自动刷新轮询别把它当外部改动
      await refreshData().catch(() => {});
      onDone?.(j.path);
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  return <Modal onClose={onClose} label="新建方法笔记">
      <header><h2>新建方法笔记 <em>New note</em></h2><button className="icon-btn" onClick={onClose} aria-label="关闭 Close"><Icon name="close" size={16}/></button></header>
      <div className="form">
        <p className="quiet">保存后写入 NAS 笔记库（05-方法库/），方法库星座即时多一颗星（刷新后可见）<em>Saved to vault on NAS</em></p>
        <label>标题 <em>Title</em><input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder="如：每周复盘的四步流程"/></label>
        <div className="form-row">
          <label>话题标签 <em>Tags</em><input value={tags} onChange={e => setTags(e.target.value)} placeholder="逗号分隔，如：复盘, 流程"/></label>
          <label className="nn-img">
            插入图片 <em>Image</em>
            <input type="file" accept="image/*" ref={fileRef} className="visually-hidden" onChange={async e => {
              const f = e.target.files?.[0]; e.target.value = '';
              if (!f) return;
              const err2 = await insertImageAtCursor({current: null}, f, v => setBody(b => (b ? b + '\n' : '') + v));
              if (err2) setErr(err2);
            }}/>
            <button type="button" className="pill ghost" onClick={() => fileRef.current?.click()}><Icon name="save" size={13}/>上传</button>
          </label>
        </div>
        <label>正文 <em>Body</em><textarea rows={8} value={body} onChange={e => setBody(e.target.value)}/></label>
        {err && <p className="quiet" role="alert">{err}</p>}
        <div className="form-actions">
          <button className="pill ghost" onClick={onClose}>取消 <em>Cancel</em></button>
          <button className="pill primary" disabled={busy || !title.trim()} onClick={save}>保存到方法库 <em>Save</em></button>
        </div>
      </div>
  </Modal>;
}

// 草稿发布为作品：移动文件 + 指标表单（全部可空，发布后可在作品库补填）
export function PublishModal({draft, onClose, onDone}) {
  const [title, setTitle] = useState(draft?.title || '');
  const [metrics, setMetrics] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, v) => setMetrics(m => ({...m, [k]: v}));

  const publish = async () => {
    if (busy) return;
    setBusy(true); setErr('');
    try {
      const res = await fetch(apiUrl('/api/publish'), {method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({path: draft.path, title: title !== draft.title ? title : undefined, metrics})});
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status);
      markSelfWrite(); // 这次是看板自己写的：自动刷新轮询别把它当外部改动
      await refreshData().catch(() => {});
      onDone?.(j.path);
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  return <Modal onClose={onClose} label="发布为作品">
      <header><h2>发布为作品 <em>Publish</em></h2><button className="icon-btn" onClick={onClose} aria-label="关闭 Close"><Icon name="close" size={16}/></button></header>
      <div className="form">
        <p className="quiet">「{draft?.title}」将移入 NAS 笔记库的 02-作品库/，成为作品库星座的一颗星；指标现在可以不填，稍后在作品页补 <em>Moves the draft into 02-作品库/</em></p>
        <label>作品标题 <em>Title</em><input autoFocus value={title} onChange={e => setTitle(e.target.value)}/></label>
        <div className="pub-metrics">
          {METRIC_FIELDS.map(([k, zh, en]) => <label key={k}>{zh} <em>{en}</em>
            <input type="number" min="0" inputMode="numeric" value={metrics[k] ?? ''} onChange={e => set(k, e.target.value)} placeholder="—"/>
          </label>)}
        </div>
        {err && <p className="quiet" role="alert">{err}</p>}
        <div className="form-actions">
          <button className="pill ghost" onClick={onClose}>取消 <em>Cancel</em></button>
          <button className="pill primary" disabled={busy} onClick={publish}>{busy ? '发布中…' : <>{'发布'} <em>Publish</em></>}</button>
        </div>
      </div>
  </Modal>;
}
