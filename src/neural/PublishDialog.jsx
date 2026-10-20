// 半自动发布对话框：预览发布包 → 同一手势内复制 + 打开创作页 → 回填链接。
// 回填结果写入草稿对象（platform/url/platformId/syncedAt），由 persist.scheduleDraft 落盘。
import React, {useMemo, useState} from 'react';
import {PLATFORMS, PLATFORM_KEYS, buildPack, copyText} from './publish';
import {Icon} from './icons';
import {SaveBadge} from './SaveStatus';
import {useSaveState, draftKey} from './persist';

export function PublishDialog({draft, defaultPlatform, sourcePlatform, onClose, onSave, reduced}) {
  const [platform, setPlatform] = useState(defaultPlatform || sourcePlatform || '小红书');
  const [copied, setCopied] = useState('');
  const [url, setUrl] = useState(draft?.url || '');
  const [platformId, setPlatformId] = useState(draft?.platformId || '');
  const [err, setErr] = useState('');
  const saveState = useSaveState(draftKey(draft?.id));
  const cfg = PLATFORMS[platform] || PLATFORMS['小红书'];
  const pack = useMemo(() => buildPack(platform, {title: draft?.title, body: draft?.body, tags: draft?.tags || []}), [platform, draft]);

  // 复制与打开必须在同一个用户手势里完成（浏览器拦截分开的 window.open）。
  const copyAndOpen = async () => {
    setCopied('');
    const ok = await copyText(pack.text);
    setCopied(ok ? '已复制发布包，去平台粘贴并发布' : '复制失败，请从预览框手动全选复制');
    window.open(cfg.url, '_blank', 'noopener');
  };

  const save = () => {
    const u = url.trim();
    if (!u || !/^https?:\/\//i.test(u)) { setErr('请粘贴发布后的原文链接（http/https 开头）'); return; }
    setErr('');
    onSave({
      ...draft,
      platform,
      url: u,
      platformId: platformId.trim() || undefined,
      syncedAt: `手动 ${new Date().toISOString().slice(0, 10)}`
    });
  };

  return <div className="pub-dialog">
    <p className="quiet">发布是手动的：复制发布包 → 打开平台创作页粘贴发布 → 回填链接。链接会写入草稿，发布后同名作品自动带上来源。<em>Publish manually — paste the pack, then link back.</em></p>

    <label>目标平台 <em>Platform</em>
      <select value={platform} onChange={e => { setPlatform(e.target.value); setCopied(''); }} aria-label="选择平台 Choose platform">
        {PLATFORM_KEYS.map(k => <option key={k} value={k}>{PLATFORMS[k].zh} <em>{PLATFORMS[k].en}</em></option>)}
      </select>
    </label>
    <p className="quiet pub-hint">{cfg.hint}</p>

    <div className="pub-preview">
      <pre>{pack.text}</pre>
    </div>

    <div className="pub-actions">
      <button className="pill primary" onClick={copyAndOpen}><Icon name="outlink" size={14}/>复制并打开创作页 <em>Copy &amp; open</em></button>
      {copied && <span className="quiet" role="status">{copied}</span>}
    </div>

    <div className="form">
      <label>原文链接 <em>Post URL</em><input value={url} onChange={e => setUrl(e.target.value)} placeholder="发布后把链接粘到这里…" aria-label="作品链接 Post URL"/></label>
      <label>平台内容 ID <em>Content ID</em><input value={platformId || ''} onChange={e => setPlatformId(e.target.value)} placeholder="选填，便于后续自动拉数据" aria-label="平台内容 ID Platform content ID"/></label>
      {err && <p className="quiet" role="alert">{err}</p>}
      <div className="form-actions">
        <SaveBadge state={saveState}/>
        <button className="pill ghost" onClick={onClose}>关闭 <em>Close</em></button>
        <button className="pill primary" onClick={save}><Icon name="link" size={14}/>记录来源 <em>Link back</em></button>
      </div>
    </div>
  </div>;
}
