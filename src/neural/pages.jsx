import React, {useEffect, useMemo, useRef, useState} from 'react';
import {KINDS, CONTENT, MODULES, neighbors, latent, LINK_EN} from './graph';
import {Icon} from './icons';
import {Analysis, Count} from './Analysis';
import {ConstellationBand} from './ConstellationBand';
import {snapshot} from '../data';
import {posts} from './works';
import {T} from './theme';
import {useSaveState, draftKey, apiUrl, refreshData, markSelfWrite} from './persist';
import {getFiles} from '../data/store';
import {SaveBadge} from './SaveStatus';
import {Assistant} from './Assistant';
import {Modal} from './useModal';
import {PublishModal, insertImageAtCursor} from './NoteModal';

const fmt = v => v == null ? '—' : Number(v).toLocaleString('zh-CN');

export function PageHead({zh, en, sub, subEn, children}) {
  return <header className="page-head">
    <div><p className="eyebrow">{en.toUpperCase()} <span>{zh}</span></p><h1>{sub}</h1><p className="page-sub">{subEn}</p></div>
    {children && <div className="page-head-actions">{children}</div>}
  </header>;
}

// —— 作品库 Works ——
export function Library({graph, selected, setSelected, onGo, onAction, onModule, aiEnabled, embedEnabled}) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('date');
  const rate = p => p.views ? p.saves / p.views : -1;
  const rows = posts.filter(p => p.title.toLowerCase().includes(q.toLowerCase())).sort((a, b) =>
    sort === 'date' ? b.date.localeCompare(a.date) : sort === 'rate' ? rate(b) - rate(a) : (b[sort] ?? -1) - (a[sort] ?? -1));
  const order = [...posts].sort((a, b) => a.date.localeCompare(b.date));
  const node = graph.index.get('post:' + selected) || graph.index.get('post:' + rows[0]?.id);
  const total = posts.reduce((s, p) => s + p.views, 0);
  const max = Math.max(1, ...posts.map(p => p.views));
  const kpis = [['已发布', 'Published', posts.length], ['账号粉丝', 'Followers', snapshot.followers], ['累计观看', 'Total views', total], ['已知涨粉', 'Known follows', posts.reduce((s, p) => s + (p.follows ?? 0), 0)]];
  return <div className="page page-library">
    <PageHead zh="作品库" en="Works" sub="每一篇，都留下回响。" subEn="Every piece leaves an echo — metrics and links side by side."/>
    <ConstellationBand page="works" onGo={onModule}/>
    <section className="kpi-band glass">{kpis.map(([zh, en, v]) => <div key={zh}><span>{zh} <em>{en}</em></span><strong><Count value={v}/></strong></div>)}</section>
    <div className="library-layout">
      <section className="works-col">
        <div className="toolbar-row">
          <label className="search"><Icon name="search" size={15}/><input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索作品… Search works" aria-label="搜索作品"/></label>
          <div className="seg" role="group" aria-label="排序">{[['date', '最新', 'Latest'], ['views', '观看', 'Views'], ['rate', '收藏率', 'Save rate'], ['follows', '涨粉', 'Follows']].map(([k, zh, en]) => <button key={k} className={sort === k ? 'active' : ''} onClick={() => setSort(k)}>{zh}<em>{en}</em></button>)}</div>
        </div>
        <div className="works-grid">{rows.map((p, i) => {
          const n = graph.index.get('post:' + p.id);
          const on = node?.id === n.id;
          return <button key={p.id} className={`work-card ${on ? 'active' : ''}`} onClick={() => setSelected(p.id)} style={{animationDelay: i * 60 + 'ms'}}>
            <span className="wc-cover">{n.cover ? <img src={n.cover} alt="" loading="lazy"/> : <span className="wc-fallback" style={{'--h': (order.indexOf(p) * 47) % 360}}><b>{p.title}</b><small>{n.media === 'video' ? '视频 · Video' : '图文 · Post'}</small></span>}<span className="wc-index">#{String(order.indexOf(p) + 1).padStart(2, '0')}</span></span>
            <span className="wc-body">
              <span className="wc-date">{p.date.slice(0, 10)} · {n.tags.length} topics</span>
              <span className="wc-title">{p.title}</span>
              <span className="wc-bar"><i style={{'--w': p.views / max}}/></span>
              <span className="wc-stats"><span>观看<em>Views</em><b>{fmt(p.views)}</b></span><span>收藏<em>Saves</em><b>{fmt(p.saves)}</b></span><span>⇄<em>Mutual</em><b>{n.mutual}</b></span></span>
            </span>
          </button>;
        })}</div>
        {!rows.length && (posts.length
          ? <div className="empty"><Icon name="search" size={30}/><p>没有找到这篇作品 <em>No match</em></p><button className="pill" onClick={() => setQ('')}>清空搜索 <em>Clear</em></button></div>
          : <div className="empty"><Icon name="works" size={30}/><p>作品库还是空的 <em>No works yet</em></p><p className="quiet">把作品笔记放进名字包含「作品 / works」的文件夹，或用 <code>--works</code> 指定 <em>Add work notes to a folder named 作品 / works</em></p></div>)}
        {posts.length > 0 && <p className="source-line"><Icon name="info" size={13}/>{posts.length} 篇作品均为{snapshot.source}；「—」表示未提供 <em>Not provided</em>。</p>}
      </section>
      {node && <aside className="library-analysis" key={node.id}><Analysis graph={graph} node={node} module={MODULES[0]} onGo={onGo} onAction={onAction} onClose={() => setSelected(null)} aiEnabled={aiEnabled} embedEnabled={embedEnabled}/></aside>}
    </div>
  </div>;
}

// —— 创作台 Drafts ——
function MiniGraph({graph, node}) {
  const nb = neighbors(graph, node.id);
  const all = [...nb.mutual.map(x => ({...x, dir: 'both'})), ...nb.out.map(x => ({...x, dir: 'out'})), ...nb.back.map(x => ({...x, dir: 'in'}))].slice(0, 16);
  const R = 92, C = 120;
  return <svg className="mini-graph" viewBox="0 0 240 240" role="img" aria-label={`${all.length} 条连接`}>
    <defs><radialGradient id="mg-core"><stop offset="0" stopColor={T.mini.glow0}/><stop offset=".5" stopColor={T.mini.core}/><stop offset="1" stopColor={T.mini.core} stopOpacity="0"/></radialGradient></defs>
    {all.map((x, i) => {
      const a = i / Math.max(all.length, 1) * Math.PI * 2 - Math.PI / 2, n = graph.index.get(x.id);
      const px = C + Math.cos(a) * R, py = C + Math.sin(a) * R;
      return <g key={x.id} style={{'--d': i * 60 + 'ms'}} className={`mg-link dir-${x.dir}`}>
        <line x1={C} y1={C} x2={px} y2={py} stroke={x.dir === 'both' ? T.mini.mutual : KINDS[n.kind].color}/>
        <circle cx={px} cy={py} r={n.kind === 'ghost' ? 3.5 : 4.5} fill={n.kind === 'ghost' ? 'none' : KINDS[n.kind].color} stroke={KINDS[n.kind].color} strokeDasharray={n.kind === 'ghost' ? '2 2' : undefined}/>
        {x.dir !== 'in' && <circle r="2.2" fill={T.mini.pulseOut} className="mg-pulse"><animateMotion dur={2 + i % 3 * .4 + 's'} repeatCount="indefinite" path={`M${C},${C} L${px},${py}`}/></circle>}
        {x.dir !== 'out' && <circle r="2" fill={T.mini.pulseIn} className="mg-pulse"><animateMotion dur={2.4 + i % 2 * .5 + 's'} repeatCount="indefinite" path={`M${px},${py} L${C},${C}`}/></circle>}
      </g>;
    })}
    <circle cx={C} cy={C} r="26" fill="url(#mg-core)"/>
    <circle cx={C} cy={C} r="8" fill={T.mini.dot}/>
  </svg>;
}

export function Drafts({graph, drafts, setDrafts, active, setActive, onNew, onDelete, onDirty, readOnly, onGo, onModule, onPublish, onToPost, aiEnabled, hydrateErr, onHydrateRetry}) {
  const draft = drafts.find(d => d.id === active) || drafts[0];
  const area = useRef(null);
  const [suggest, setSuggest] = useState(null);
  const [pick, setPick] = useState(0);
  const saveState = useSaveState(draftKey(draft?.id));
  // 正文被服务端截断（> 6000 字）时这份缓存不是全文：全文还没拉回来就不许编辑，
  // 否则第一个按键就会把截断后的正文写回 .md，6000 字之后的内容永久丢失。
  const truncated = !!draft?.truncated;
  const locked = readOnly || truncated;
  const change = (key, value) => {
    if (locked) return;
    const updated = {...draft, [key]: value};
    setDrafts(drafts.map(d => d.id === draft.id ? updated : d));
    onDirty?.(updated);
  };
  const titles = useMemo(() => graph.nodes.filter(n => CONTENT.has(n.kind) && n.id !== 'draft:' + draft?.id).map(n => ({id: n.id, title: n.path?.split('/').pop().replace(/\.md$/, '') || n.title, short: n.short || n.title, kind: n.kind})), [graph, draft?.id]);
  const check = el => {
    if (locked) return;
    const before = el.value.slice(0, el.selectionStart);
    const m = before.match(/\[\[([^\]\n]*)$/);
    if (!m) { setSuggest(null); return; }
    const q = m[1].toLowerCase();
    const list = titles.filter(t => t.title.toLowerCase().includes(q) || t.short.toLowerCase().includes(q)).slice(0, 7);
    setSuggest({q: m[1], start: el.selectionStart - m[1].length, list}); setPick(0);
  };
  const insert = t => {
    const el = area.current, s = suggest.start, e = el.selectionStart;
    const value = el.value.slice(0, s) + t.title + ']]' + el.value.slice(e).replace(/^\]\]/, '');
    change('body', value); setSuggest(null);
    requestAnimationFrame(() => { el.focus(); const pos = s + t.title.length + 2; el.setSelectionRange(pos, pos); });
  };
  const node = draft && graph.index.get('draft:' + draft.id);
  const nb = node ? neighbors(graph, node.id) : null;
  const wiki = node ? graph.links.filter(l => l.kind === 'wiki' && l.s === node.id).map(l => graph.index.get(l.t)) : [];
  // 发布默认平台：草稿自己记的 > 来源选题的 > 小红书
  const sourceIdea = draft?.source != null ? graph.nodes.find(n => n.kind === 'idea' && n.idea?.id === draft.source)?.idea : null;
  const [pubPlatform, setPubPlatform] = useState(null);
  const pubDefault = pubPlatform || draft?.platform || sourceIdea?.platform || '小红书';
  return <div className="page page-drafts">
    <PageHead zh="创作台" en="Drafts" sub="把灵感，写成下一篇。" subEn="Write with [[links]] — every link grows a backlink.">
      <button className="pill primary" onClick={() => onNew()} disabled={readOnly} title={readOnly ? '未连接 NAS，只读' : ''}><Icon name="plus" size={15}/>新建草稿 <em>New draft</em></button>
    </PageHead>
    <ConstellationBand page="drafts" onGo={onModule}/>
    <div className="drafts-layout">
      <aside className="draft-list glass">
        <h3>我的草稿 <em>My drafts</em><b>{drafts.length}</b></h3>
        {drafts.map(d => <button key={d.id} className={d.id === draft?.id ? 'active' : ''} onClick={() => setActive(d.id)}>
          <i/><span>{d.title || '未命名草稿'}<small>{(d.body || '').length} 字 chars · {graph.index.get('draft:' + d.id)?.deg || 0} 连接 links</small></span>
        </button>)}
        {!drafts.length && <p className="empty-line">还没有草稿 <em>No drafts yet</em></p>}
      </aside>
      {draft ? <section className="editor glass">
        <div className="editor-meta"><span>03-创作台 / 正在写 <em>Writing</em></span>
          <span className="editor-tools">
            <label className="img-insert" title="上传图片并插入 ![[ ]]">
              <input type="file" accept="image/*" className="visually-hidden" disabled={readOnly} onChange={async e => {
                const f = e.target.files?.[0]; e.target.value = '';
                if (!f) return;
                const err = await insertImageAtCursor(area, f, v => change('body', v));
                if (err) console.error('[attachment]', err);
              }}/>
              <button type="button" className="icon-btn" disabled={readOnly} onClick={e => { e.preventDefault(); e.currentTarget.closest('label')?.querySelector('input')?.click(); }} aria-label="插入图片"><Icon name="save" size={14}/></button>
            </label>
          </span>
          {hydrateErr ? <span><Icon name="info" size={13}/>读取全文失败：{hydrateErr} <button type="button" className="pill ghost" onClick={onHydrateRetry}>重试</button></span>
            : truncated ? <span><Icon name="info" size={13}/>正在载入全文，稍候可编辑 · Loading full text</span>
            : readOnly ? <span><Icon name="info" size={13}/>只读演示 · Read-only</span> : <SaveBadge state={saveState}/>}
        </div>
        <input className="editor-title" readOnly={locked} value={draft.title} onChange={e => change('title', e.target.value)} placeholder="给这篇内容一个标题 Title" aria-label="草稿标题"/>
        <div className="editor-area">
          <textarea ref={area} readOnly={locked} value={draft.body} aria-label="草稿正文" placeholder="开始写… 输入 [[ 链接到其他笔记 Type [[ to link a note"
            onChange={e => { change('body', e.target.value); check(e.target); }} onClick={e => check(e.target)}
            onKeyDown={e => {
              if (!suggest?.list.length) return;
              if (e.key === 'ArrowDown') { e.preventDefault(); setPick((pick + 1) % suggest.list.length); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setPick((pick - 1 + suggest.list.length) % suggest.list.length); }
              else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); insert(suggest.list[pick]); }
              else if (e.key === 'Escape') setSuggest(null);
            }}/>
          {suggest && <div className="suggest glass" role="listbox" aria-label="链接建议">
            <p>链接到笔记 <em>Link to note</em>{suggest.q && <> · “{suggest.q}”</>}</p>
            {suggest.list.map((t, i) => <button key={t.id} role="option" aria-selected={i === pick} className={i === pick ? 'on' : ''} onMouseDown={e => { e.preventDefault(); insert(t); }} style={{'--kc': KINDS[t.kind].color}}><i/>{t.short}<small>{KINDS[t.kind].label} {KINDS[t.kind].en}</small></button>)}
            {!suggest.list.length && <span className="none">没有匹配，将成为未创建的笔记 <em>Will be unresolved</em></span>}
          </div>}
        </div>
        <footer className="editor-foot">
          <span>{(draft.body || '').length} 字 <em>chars</em> · {wiki.length} 个双链 <em>wikilinks</em></span>
          <span className="pub-entry">
            <select value={pubDefault} onChange={e => setPubPlatform(e.target.value)} aria-label="发布平台" title="发布平台">
              {['小红书', '抖音', 'B站', '公众号'].map(k => <option key={k}>{k}</option>)}
            </select>
            <button className="pill" onClick={() => onPublish?.(draft.id, pubDefault)} disabled={readOnly} title={readOnly ? '未连接 NAS，只读' : '生成发布包，去平台手动发布'}>
              <Icon name="outlink" size={14}/>发布 <em>Publish</em>
            </button>
            <button className="pill ghost" onClick={() => onToPost?.(draft)} disabled={readOnly} title={readOnly ? '未连接 NAS，只读' : '移入 02-作品库，成为作品（可填指标）'}>
              <Icon name="works" size={14}/>生成作品 <em>To post</em>
            </button>
            <button className="pill ghost danger" onClick={() => onDelete(draft.id)} disabled={readOnly} title={readOnly ? '未连接 NAS，只读' : ''}><Icon name="trash" size={14}/>删除 <em>Delete</em></button>
          </span>
        </footer>
      </section> : <section className="editor glass empty"><p>新建一篇草稿开始写作 <em>Create a draft to begin</em></p></section>}
      {node && <aside className="draft-links glass">
        <h3><Icon name="pulse" size={15}/>神经连接 <em>Neural links</em></h3>
        <MiniGraph graph={graph} node={node}/>
        <div className="dl-legend"><span><i className="out"/>出链 <em>Out</em> {nb.out.length}</span><span><i className="in"/>反链 <em>In</em> {nb.back.length}</span><span><i className="both"/>双向 <em>Mutual</em> {nb.mutual.length}</span></div>
        {[['[[双链]]', 'Wikilinks', wiki.map(n => n.id)], ['提及概念', 'Concepts', nb.out.filter(x => graph.index.get(x.id).kind === 'concept').map(x => x.id)], ['双向共振', 'Resonance', nb.mutual.map(x => x.id)], ['反链 · 来源', 'Backlinks', nb.back.map(x => x.id)]].filter(g => g[2].length).map(([zh, en, ids]) => <div className="dl-group" key={zh}>
          <p>{zh} <em>{en}</em></p>
          <div className="chip-row">{ids.map(id => { const n = graph.index.get(id); const go = CONTENT.has(n.kind) || n.kind === 'concept'; return go ? <button key={id} className="chip" style={{'--kc': KINDS[n.kind].color}} onClick={() => onGo(id)}>{n.short || n.title}</button> : <span key={id} className={`chip static ${n.kind === 'ghost' ? 'ghost' : ''}`} style={{'--kc': KINDS[n.kind].color}}>{n.short || n.title}</span>; })}</div>
        </div>)}
        {!node.deg && <p className="empty-line">写下内容或 [[链接]] 后，这里会长出连接。<em>Links appear as you write.</em></p>}
      </aside>}
    </div>
    <Assistant graph={graph} readOnly={readOnly} aiEnabled={aiEnabled} showToast={msg => console.info('[assistant]', msg)} goNote={onGo}/>
  </div>;
}

// —— 选题池 Ideas ——
const LANES = [['待写', 'To write'], ['待扩展', 'To expand'], ['已转草稿', 'Drafted']];
const PRI = {高: ['High', 'high'], 中: ['Medium', 'mid'], 低: ['Low', 'low']};

export function Ideas({graph, ideas, onEdit, onNew, onGraph, onModule, readOnly}) {
  return <div className="page page-ideas">
    <PageHead zh="选题池" en="Ideas" sub="下一篇，从这里开始。" subEn="Ideas linked to what you have already published.">
      <button className="pill primary" onClick={onNew} disabled={readOnly} title={readOnly ? '未连接 NAS，只读' : ''}><Icon name="plus" size={15}/>添加选题 <em>New idea</em></button>
    </PageHead>
    <ConstellationBand page="ideas" onGo={onModule}/>
    <div className="lanes">{LANES.map(([zh, en], li) => {
      const list = ideas.filter(i => i.status === zh);
      return <section className="lane glass" key={zh} style={{animationDelay: li * 90 + 'ms'}}>
        <header><span className={`lane-dot l${li}`}/>{zh} <em>{en}</em><b>{list.length}</b></header>
        {list.map((idea, i) => {
          const n = graph.index.get('idea:' + idea.id);
          const lat = n ? latent(graph, n.id) : [];
          const works = lat.filter(x => graph.index.get(x.id).kind === 'post');
          const [pen, pc] = PRI[idea.priority] || PRI['中'];
          return <article className={`idea-card pri-${pc}`} key={idea.id} style={{animationDelay: li * 90 + i * 70 + 140 + 'ms'}}>
            <div className="ic-top"><span className="ic-pri"><i/>{idea.priority} <em>{pen}</em></span><span className="ic-plat">{idea.platform}</span></div>
            <h3>{idea.title || '未命名选题'}</h3>
            <p>{idea.note || '还没有创作备注。'}</p>
            {n?.shared?.length > 0 && <div className="chip-row">{n.shared.slice(0, 5).map(c => <span key={c} className="chip static" style={{'--kc': KINDS.concept.color}}>{c}</span>)}</div>}
            <div className="ic-reach"><Icon name="link" size={13}/>{works.length ? <>可延伸 {works.length} 篇作品 <em>builds on {works.length} works</em></> : <>暂无关联作品 <em>No related works</em></>}</div>
            <footer>
              <button className="pill ghost" onClick={() => onGraph(n.id)}><Icon name="concept" size={14}/>图谱 <em>Graph</em></button>
              <button className="pill" onClick={() => onEdit(idea)} disabled={readOnly} title={readOnly ? '未连接 NAS，只读' : ''}>编辑 <em>Edit</em><Icon name="chevron" size={13}/></button>
            </footer>
          </article>;
        })}
        {!list.length && <p className="empty-line">这个状态下还没有选题 <em>Nothing here yet</em></p>}
      </section>;
    })}</div>
  </div>;
}

// —— 知识库 Knowledge（个人知识库：灵感 / 制度 / 推文剪藏）——
const CATS = [['灵感', 'Sparks'], ['制度', 'Policies'], ['推文', 'Clips']];

export function Knowledge({graph, readOnly, onGraph, onModule, onAction, onNewDraft, onEditIdea, showToast, aiEnabled}) {
  const items = useMemo(() => graph.nodes.filter(n => n.kind === 'personal')
    .sort((a, b) => String(b.personal?.clipped || '').localeCompare(String(a.personal?.clipped || ''))), [graph]);
  const [cat, setCat] = useState('灵感');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(null); // '灵感' | '制度'
  const [formTitle, setFormTitle] = useState('');
  const [formBody, setFormBody] = useState('');
  const list = items.filter(n => (n.personal?.category || '灵感') === cat);

  const relOf = n => n.path; // personal 节点的 path 就是 vault 相对路径（06-个人知识库/xxx.md）

  const clip = async e => {
    e.preventDefault();
    if (!url.trim() || busy || readOnly) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl('/api/knowledge'), {method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({url: url.trim(), category: '推文'})});
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status);
      setUrl('');
      markSelfWrite(); // 看板自己写的，别让自动刷新弹「外部改动」
      await refreshData();
      showToast(j.analysisError ? '剪藏已保存，但 AI 分析失败：' + j.analysisError : '网页已剪藏，快照与摘要已写入知识库');
    } catch (err) { showToast('剪藏失败：' + err.message); }
    finally { setBusy(false); }
  };

  const saveComposed = async () => {
    if (!formTitle.trim() || readOnly) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl('/api/knowledge'), {method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({title: formTitle, note: formBody, category: composing})});
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status);
      setComposing(null);
      setFormTitle(''); setFormBody(''); // 不复位的话下次「新建灵感」会带着上一次的标题/正文，直接保存就重复入库
      markSelfWrite(); // 看板自己写的，别让自动刷新弹「外部改动」
      await refreshData();
      showToast('已保存到个人知识库（06-个人知识库/）');
    } catch (err) { showToast('保存失败：' + err.message); }
    finally { setBusy(false); }
  };

  const remove = async n => {
    if (!window.confirm(`删除「${n.short || n.title}」？NAS 上的 .md 文件会先备份到 vault/.trash/ 再删除。`)) return;
    try {
      const res = await fetch(apiUrl('/api/note?path=' + encodeURIComponent(relOf(n))), {method: 'DELETE'});
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status);
      markSelfWrite(); // 看板自己写的，别让自动刷新弹「外部改动」
      await refreshData();
      showToast('已删除，原文件备份在 vault/.trash/');
    } catch (err) { showToast('删除失败：' + err.message); }
  };

  // 转为选题 / 转为草稿：预填并把本条标题以 [[双链]] 引用进正文，进现有创作链
  const toIdea = n => {
    if (readOnly) return;
    onEditIdea({id: Date.now(), title: n.short || n.title, platform: '小红书', priority: '中', status: '待写',
      note: `来自个人知识库「${n.short || n.title}」。${n.personal?.summary ? '\n要点：' + n.personal.summary : ''}\n\n切入点：`});
  };
  const toDraft = n => {
    if (readOnly) return;
    onNewDraft(n.short || n.title, `【来自个人知识库「${n.short || n.title}」】\n\n参考：[[${n.short || n.title}]]\n${n.personal?.summary ? '\nAI 摘要：' + n.personal.summary : ''}\n\n要点：\n\n正文：`, null, null);
  };

  return <div className="page page-knowledge">
    <PageHead zh="个人知识库" en="Knowledge" sub="灵感、制度与好文章，都在这里。" subEn="Sparks, policies and good posts — one constellation."/>
    <ConstellationBand page="knowledge" onGo={onModule}/>
    <section className="kbar glass">
      <form className="kbar-clip" onSubmit={clip}>
        <Icon name="link" size={15}/>
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="粘贴推文或文章链接，剪藏并让 AI 分析… Paste a URL to clip & analyze"
          aria-label="剪藏网址" disabled={readOnly || busy}/>
        <button className="pill primary" disabled={readOnly || busy || !url.trim()}>{busy ? '抓取中…' : <><Icon name="save" size={14}/>剪藏 <em>Clip</em></>}</button>
      </form>
      <div className="kbar-actions">
        <button className="pill ghost" disabled={readOnly} onClick={() => setComposing('灵感')}><Icon name="spark" size={14}/>新建灵感 <em>Spark</em></button>
        <button className="pill ghost" disabled={readOnly} onClick={() => setComposing('制度')}><Icon name="file" size={14}/>新建制度 <em>Policy</em></button>
      </div>
    </section>
    <div className="seg kcats" role="group" aria-label="按分类浏览">
      {CATS.map(([zh, en]) => <button key={zh} className={cat === zh ? 'active' : ''} onClick={() => setCat(zh)}>{zh}<em>{en}</em><b>{items.filter(n => (n.personal?.category || '灵感') === zh).length}</b></button>)}
    </div>
    <div className="kgrid">
      {list.map((n, i) => {
        const p = n.personal || {};
        return <article className="kcard glass" key={n.id} style={{animationDelay: i * 60 + 'ms', '--kc': KINDS.personal.color}}>
          <header onClick={() => onGraph(n.id)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') onGraph(n.id); }}>
            <h3>{n.short || n.title}</h3>
            <p className="kc-src">{p.url
              ? <><Icon name="link" size={12}/>{p.domain || '网页'}{p.author ? ' · @' + p.author : ''}</>
              : <><Icon name="file" size={12}/>{p.category || '笔记'}</>}
              {p.clipped ? ' · ' + String(p.clipped).slice(0, 10) : ''}</p>
          </header>
          {p.summary && <p className="kc-summary">{p.summary}</p>}
          {(p.keyPoints || []).length > 0 && <ul className="kc-points">{p.keyPoints.slice(0, 4).map((k, j) => <li key={j}>{k}</li>)}</ul>}
          {!p.summary && <p className="kc-body">{(n.body || '').slice(0, 140)}{(n.body || '').length > 140 ? '…' : ''}</p>}
          {n.tags?.length > 0 && <div className="chip-row">{n.tags.slice(0, 5).map(t => <span key={t} className="chip static" style={{'--kc': KINDS.tag.color}}>#{t}</span>)}</div>}
          <footer>
            <button className="pill ghost" onClick={() => onGraph(n.id)} title="打开分析"><Icon name="concept" size={13}/>图谱 <em>Graph</em></button>
            <button className="pill ghost" disabled={readOnly} onClick={() => toIdea(n)}><Icon name="idea" size={13}/>转选题 <em>To idea</em></button>
            <button className="pill ghost" disabled={readOnly} onClick={() => toDraft(n)}><Icon name="draft" size={13}/>转草稿 <em>To draft</em></button>
            {p.url && <a className="pill ghost" href={p.url} target="_blank" rel="noopener noreferrer" title="打开原网页"><Icon name="outlink" size={13}/></a>}
            {p.snapshot && <a className="pill ghost" href={apiUrl('/api/knowledge/snapshot?path=' + encodeURIComponent(p.snapshot))} target="_blank" rel="noopener noreferrer" title="查看快照"><Icon name="eye" size={13}/></a>}
            <button className="pill ghost danger" disabled={readOnly} onClick={() => remove(n)} title="删除"><Icon name="trash" size={13}/></button>
          </footer>
        </article>;
      })}
      {!list.length && <div className="empty kempty"><Icon name="personal" size={30}/><p>{cat === '推文' ? '还没有剪藏。粘贴一个链接试试。' : `还没有「${cat}」条目。`}<em>Nothing here yet</em></p></div>}
    </div>
    {composing && <Modal onClose={() => setComposing(null)} label={'新建' + composing + '条目'}>
        <header><h2>新建{composing} <em>New {composing === '灵感' ? 'spark' : 'policy'}</em></h2><button className="icon-btn" onClick={() => setComposing(null)} aria-label="关闭"><Icon name="close" size={16}/></button></header>
        <div className="form">
          <label>标题 <em>Title</em><input autoFocus value={formTitle} onChange={e => setFormTitle(e.target.value)} placeholder={composing === '制度' ? '如：2026 年度安全检查通报' : '一句话标题'}/></label>
          <label>正文 <em>Body</em><textarea rows={8} value={formBody} onChange={e => setFormBody(e.target.value)}/></label>
          <div className="form-actions">
            <button className="pill ghost" onClick={() => setComposing(null)}>取消 <em>Cancel</em></button>
            <button className="pill primary" disabled={busy || !formTitle.trim()} onClick={saveComposed}>保存到知识库 <em>Save</em></button>
          </div>
        </div>
    </Modal>}
    <Assistant graph={graph} readOnly={readOnly} aiEnabled={aiEnabled} showToast={showToast} defaultCategory="制度" goNote={onGraph}/>
  </div>;
}


// —— 方法库 Methods（kind: note 的内页；新建笔记入口在这里）——
export function Methods({graph, readOnly, onGo, onAction, onModule, showToast, onNew, aiEnabled, embedEnabled}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);
  const items = useMemo(() => graph.nodes.filter(n => n.kind === 'note')
    .filter(n => {
      if (!q.trim()) return true;
      const k = q.toLowerCase();
      return (n.title || '').toLowerCase().includes(k) || (n.body || '').toLowerCase().includes(k) || (n.tags || []).some(tg => tg.toLowerCase().includes(k));
    }), [graph, q]);
  const node = sel ? graph.index.get(sel) : items[0] || null;
  const mod = MODULES.find(m => m.id === 'methods');
  const remove = async n => {
    if (!window.confirm(`删除「${n.short || n.title}」？NAS 上的 .md 文件会先备份到 vault/.trash/ 再删除。`)) return;
    try {
      const rel = getFiles()?.[n.id] || n.path;
      const res = await fetch(apiUrl('/api/note?path=' + encodeURIComponent(rel)), {method: 'DELETE'});
      if (!res.ok) throw new Error('HTTP ' + res.status);
      setSel(null);
      showToast('已删除，原文件备份在 vault/.trash/');
      markSelfWrite(); // 看板自己写的，别让自动刷新弹「外部改动」
      await refreshData();
    } catch (err) { showToast('删除失败：' + err.message); }
  };
  return <div className="page page-methods">
    <PageHead zh="方法库" en="Methods" sub="把做法沉淀成方法。" subEn="Every practice becomes a method.">
      <button className="pill primary" onClick={onNew} disabled={readOnly} title={readOnly ? '未连接 NAS，只读' : ''}><Icon name="plus" size={15}/>新建笔记 <em>New note</em></button>
    </PageHead>
    <ConstellationBand page="methods" onGo={onModule}/>
    <div className="library-layout">
      <section className="works-col">
        <div className="toolbar-row">
          <label className="search"><Icon name="search" size={15}/><input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索方法笔记… Search notes" aria-label="搜索方法笔记"/></label>
          <span className="quiet">{items.length} 条 · {mod?.title} <em>{mod?.en}</em></span>
        </div>
        <div className="kgrid">
          {items.map((n, i) => {
            const on = node?.id === n.id;
            return <article className={`kcard glass ${on ? 'active' : ''}`} key={n.id} style={{animationDelay: i * 60 + 'ms', '--kc': KINDS.note.color, cursor: 'pointer'}}
              onClick={() => setSel(n.id)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') setSel(n.id); }}>
              <header>
                <h3>{n.short || n.title}</h3>
                <p className="kc-src"><Icon name="methods" size={12}/>{n.path}{n.tags?.length ? ' · ' + n.tags.length + ' 话题' : ''}</p>
              </header>
              <p className="kc-body">{(n.body || '').slice(0, 140)}{(n.body || '').length > 140 ? '…' : ''}</p>
              {n.tags?.length > 0 && <div className="chip-row">{n.tags.slice(0, 5).map(tg => <span key={tg} className="chip static" style={{'--kc': KINDS.tag.color}}>#{tg}</span>)}</div>}
              <footer onClick={e => e.stopPropagation()}>
                <button className="pill ghost" onClick={() => onAction({type: 'read', id: n.id})}><Icon name="file" size={13}/>阅读 <em>Read</em></button>
                <button className="pill ghost danger" disabled={readOnly} onClick={() => remove(n)} title="删除"><Icon name="trash" size={13}/></button>
              </footer>
            </article>;
          })}
          {!items.length && <div className="empty kempty"><Icon name="methods" size={30}/><p>{q ? '没有匹配的方法笔记' : '方法库还是空的。点右上角「新建笔记」开始。'}<em>{q ? 'No match' : 'Nothing here yet'}</em></p></div>}
        </div>
      </section>
      {node && <aside className="library-analysis" key={node.id}>
        <Analysis graph={graph} node={node} module={mod} onGo={onGo} onAction={onAction} onClose={() => setSel(null)} aiEnabled={aiEnabled} embedEnabled={embedEnabled}/>
      </aside>}
    </div>
    <Assistant graph={graph} readOnly={readOnly} aiEnabled={aiEnabled} showToast={showToast} defaultCategory="灵感" goNote={onGo}/>
  </div>;
}
