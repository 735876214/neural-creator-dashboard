import React, {useCallback, useDeferredValue, useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {seedIdeas, seedDrafts, snapshot, meta, files} from '../data';
import {posts, monthPosts} from './works';
import {CONFIG, asset} from '../config';
import {buildGraph, forceLayout, stats, KINDS, MODULES} from './graph';
import {Home} from './Home';
import {Cosmos} from './Cosmos';
import {Library, Drafts, Ideas} from './pages';
import {Count} from './Analysis';
import {Icon} from './icons';
import {T} from './theme';
import {saveNote, createEntry, isLive} from './sync';
import './neural.css';

// 选题、草稿与目标保存在当前浏览器（localStorage）；连着 note-api 时由 sync.js 落盘到 vault。
//
// 数据优先级（关键，防止旧缓存盖住 NAS 数据）：
//   部署模式（boot.js 已把 /api/data 填进 store）—— 初始值永远用后端数据；
//   localStorage 里的旧 seed 数据（此前用示例数据时存下的）不恢复，只在用户
//   之后做出改动时按「本次会话的覆盖」缓存。否则浏览器里遗留的示例选题、
//   示例草稿会永远盖住 NAS 上的真实文件（config.js 注释里提过的坑）。
function useSaved(key, fallback) {
  const [v, set] = useState(() => {
    if (isLive()) return fallback;
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }, [key, v]);
  return [v, set];
}

function Modal({title, en, onClose, children, wide}) {
  const ref = useRef(null), closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const before = document.activeElement;
    ref.current?.focus({preventScroll: true});
    const key = e => {
      if (e.key === 'Escape' && !e.isComposing) closeRef.current();
      if (e.key === 'Tab') {
        const list = [...ref.current.querySelectorAll('button,input,textarea,select,a[href]')].filter(n => !n.disabled);
        const first = list[0], last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); if (before?.isConnected) before.focus({preventScroll: true}); };
  }, []);
  return <div className="veil" onClick={onClose}>
    <section ref={ref} tabIndex={-1} className={`modal glass ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
      <header><h2>{title} <em>{en}</em></h2><button className="icon-btn" onClick={onClose} aria-label="关闭弹窗"><Icon name="close" size={16}/></button></header>
      {children}
    </section>
  </div>;
}

const navs = [['home', '工作台', 'Workspace'], ['library', '作品库', 'Works'], ['drafts', '创作台', 'Drafts'], ['ideas', '选题池', 'Ideas']];
const initialPage = () => { const h = location.hash.slice(1); return navs.some(n => n[0] === h) ? h : 'home'; };

function Snapshot({goal, onGoal, ideas, drafts, onIdea, onDraft, onLibrary}) {
  const total = posts.reduce((s, p) => s + p.views, 0);
  const stats4 = [['已发布笔记', 'Published', posts.length], ['账号粉丝', 'Followers', snapshot.followers], ['累计观看', 'Total views', total], ['已知笔记涨粉', 'Known follows', posts.reduce((s, p) => s + (p.follows ?? 0), 0)]];
  const max = Math.max(...posts.map(p => p.views));
  return <section className="snapshot" aria-label="账号数据快照">
    <div className="snapshot-head"><p className="eyebrow">SNAPSHOT <span>账号快照</span></p><p className="quiet">{snapshot.source} · {snapshot.capturedAt} <em>Sample data</em></p></div>
    <div className="kpi-band glass">{stats4.map(([zh, en, v]) => <div key={zh}><span>{zh} <em>{en}</em></span><strong><Count value={v}/></strong></div>)}</div>
    <div className="snapshot-grid">
      <section className="glass card perf">
        <header><h2>作品表现 <em>Performance</em></h2><button className="text-btn" onClick={onLibrary}>全部作品 <em>All works</em><Icon name="arrow" size={14}/></button></header>
        <table><thead><tr><th>笔记 <em>Note</em></th><th>观看 <em>Views</em></th><th>收藏 <em>Saves</em></th><th>涨粉 <em>Follows</em></th></tr></thead>
          <tbody>{[...posts].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6).map(p => <tr key={p.id} onClick={() => onLibrary(p.id)}><td><span className="t-title">{p.title}</span><span className="t-bar"><i style={{'--w': p.views / max}}/></span></td><td>{p.views.toLocaleString('zh-CN')}</td><td>{p.saves}</td><td>{p.follows ?? '—'}</td></tr>)}</tbody></table>
        <p className="quiet">最近 6 篇 · 共 {posts.length} 篇 · 缺失数据保留为「—」<em>Latest 6 of {posts.length}</em></p>
      </section>
      <section className="glass card plan">
        <header><h2>创作计划 <em>Plan</em></h2></header>
        <div className="plan-body">
          <button className="ring" onClick={onGoal} aria-label={`修改目标，本月 ${monthPosts.length} 篇，目标 ${goal} 篇`}>
            <svg viewBox="0 0 180 180"><defs><linearGradient id="ring-g" x1="0" x2="1"><stop offset="0" stopColor={T.ring[0]}/><stop offset="1" stopColor={T.ring[1]}/></linearGradient></defs><circle cx="90" cy="90" r="72" className="track"/><circle cx="90" cy="90" r="72" className="value" strokeDasharray={`${Math.min(monthPosts.length / goal, 1) * 452.39} 452.39`}/></svg>
            <span><strong>{monthPosts.length}</strong>/{goal}<small>本月目标 Goal</small></span>
          </button>
          <div className="plan-ideas"><h3>下一篇写什么 <em>Up next</em></h3>{ideas.slice(0, 3).map((idea, i) => <button key={idea.id} onClick={() => onIdea(idea)}><b>{i + 1}</b><span>{idea.title}</span></button>)}</div>
        </div>
        <button className="plan-draft" onClick={() => onDraft(drafts[0]?.id)}><Icon name="draft" size={15}/>继续创作 <em>Continue</em><span>{drafts[0]?.title || '开始第一篇草稿'}</span><Icon name="arrow" size={15}/></button>
      </section>
    </div>
  </section>;
}

function App() {
  const [page, setPage] = useState(initialPage);
  const [goal, setGoal] = useSaved(CONFIG.storagePrefix + '-goal-v1', 8);
  const [ideas, setIdeas] = useSaved(CONFIG.storagePrefix + '-ideas-v1', seedIdeas);
  const [drafts, setDrafts] = useSaved(CONFIG.storagePrefix + '-drafts-v1', seedDrafts);
  const [active, setActive] = useState(() => drafts[0]?.id);
  const [focus, setFocus] = useState({mod: null, sel: null});
  const [libSel, setLibSel] = useState(posts[1].id);
  const [modal, setModal] = useState(null);
  const [editing, setEditing] = useState(null);
  const [goalInput, setGoalInput] = useState(String(goal));
  const [toast, setToast] = useState('');
  const reduced = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  const slowDrafts = useDeferredValue(drafts);
  const graph = useMemo(() => buildGraph({ideas, drafts: slowDrafts}), [ideas, slowDrafts]);
  const layout = useMemo(() => forceLayout(graph), [graph]);

  // 部署模式：草稿正文 / 标题改动 1.2s 后落盘到 vault（title 键只在文件里已有该键时才改，
  // 文件名跟随标题的策略由服务端负责）。
  const saveTimer = useRef(null);
  const draftRel = useRef(null);
  useEffect(() => {
    if (!meta || !active) return;
    const d = drafts.find(x => x.id === active);
    if (!d) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const rel = files['draft:' + d.id] || draftRel.current;
      if (!rel) return; // 新建草稿的落盘由 createEntry 负责，等下次 /api/data 才有 path
      draftRel.current = rel;
      try {
        const cur = await fetch('/api/note?path=' + encodeURIComponent(rel)).then(r => r.json());
        const fm = {title: d.title};
        await saveNote({path: rel, fm, body: d.body, mtime: cur.mtime});
      } catch { /* 离线或 409：本地已有副本，不打断写作 */ }
    }, 1200);
    return () => clearTimeout(saveTimer.current);
  }, [active, drafts, meta]);

  useEffect(() => { history.replaceState(null, '', page === 'home' ? location.pathname : '#' + page); window.scrollTo({top: 0}); }, [page]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 2800); return () => clearTimeout(t); }, [toast]);

  const close = useCallback(() => setModal(null), []);
  function newDraft(title = '未命名草稿', body = '', source) {
    const id = 'draft-' + Date.now();
    setDrafts(d => [{id, title, body, source}, ...d]);
    setActive(id); setPage('drafts'); setModal(null);
    // 连着 note-api 时同步落到 vault 的 03-创作台/；失败不阻塞，本地已有副本
    if (meta) createEntry('draft', {title, body, fm: source != null ? {source: String(source)} : {}})
      .then(() => setToast('草稿已创建，已写入 NAS 笔记库（03-创作台/）· Saved to vault on NAS'))
      .catch(() => setToast('草稿已创建，暂时只在此浏览器（连不上 NAS，恢复后同步）· Local only, will sync'));
    else setToast('草稿已创建，只保存在此浏览器（未连接 NAS）· Saved in this browser only');
  }
  function editIdea(idea) { setEditing({...idea}); setModal('idea'); }
  function saveIdea() {
    if (!editing.title.trim()) return;
    setIdeas(ideas.some(i => i.id === editing.id) ? ideas.map(i => i.id === editing.id ? editing : i) : [...ideas, editing]);
    setModal(null); setToast('选题已保存 · Idea saved');
    // 部署模式：选题落在 04-选题池/（已有文件就更新，没有就新建）
    if (meta) {
      const rel = files['idea:' + editing.id];
      const fm = {platform: editing.platform, priority: editing.priority, status: editing.status, note: editing.note};
      (rel
        ? (async () => { const cur = await fetch('/api/note?path=' + encodeURIComponent(rel)).then(r => r.json()); return saveNote({path: rel, fm, mtime: cur.mtime}); })()
        : createEntry('idea', {title: editing.title, fm})
      ).then(() => setToast(`选题已写入 NAS 笔记库（04-选题池/）· Saved to vault on NAS`))
        .catch(e => setToast(e?.code === 409 ? 'NAS 上的文件已被其他编辑器改动，未覆盖 · Conflict with NAS file' : '选题已保存，暂时只在此浏览器（连不上 NAS）· Local only, will sync'));
    } else {
      setToast('选题已保存，只在此浏览器（未连接 NAS）· Saved in this browser only');
    }
  }
  function toDraft(idea) {
    const existing = drafts.find(d => d.source === idea.id);
    if (existing) { setActive(existing.id); setPage('drafts'); setModal(null); setToast('已打开关联草稿 · Linked draft opened'); return; }
    const item = {...idea, status: '已转草稿'};
    setIdeas(ideas.some(i => i.id === item.id) ? ideas.map(i => i.id === item.id ? item : i) : [...ideas, item]);
    newDraft(item.title, `【根据选题创建的写作提纲，未调用 AI】\n\n创作方向：${item.note}\n\n开场：\n\n核心观点：\n\n操作示例：\n\n结尾：`, item.id);
  }
  function deleteDraft(id) {
    const d = drafts.find(x => x.id === id);
    const scope = meta
      ? '将同时从 NAS 笔记库（03-创作台/）和此浏览器删除。'
      : '只影响此浏览器（未连接 NAS，笔记库文件不动）。';
    if (!window.confirm(`删除草稿「${d?.title || '未命名草稿'}」？${scope}`)) return;
    const rest = drafts.filter(x => x.id !== id);
    setDrafts(rest); setActive(rest[0]?.id); setToast(meta ? '草稿已删除（浏览器记录；NAS 文件保留）· Removed locally' : '草稿已删除 · Draft deleted');
  }
  const onAction = useCallback(a => {
    if (a.type === 'page') { if (a.page === 'library') setLibSel(a.id); if (a.page === 'drafts') setActive(a.id); setPage(a.page); }
    if (a.type === 'read') setModal({read: graph.index.get(a.id)});
    if (a.type === 'editIdea') editIdea(a.idea);
    if (a.type === 'ideaToDraft') toDraft(a.idea);
  }, [graph, drafts, ideas]); // eslint-disable-line react-hooks/exhaustive-deps
  // 内页星座轨 / 标签的点击：本模块有内页就直接切页，没有就回工作台并展开该星座
  const goModule = useCallback(id => {
    const m = MODULES.find(x => x.id === id);
    if (m?.page) setPage(m.page); else { setFocus({mod: id, sel: null}); setPage('home'); }
  }, []);
  const openInGraph = id => { const n = graph.index.get(id); const mod = {post: 'works', note: 'methods', idea: 'ideas', draft: 'drafts', concept: 'concepts'}[n?.kind]; if (mod) { setFocus({mod, sel: id}); setPage('home'); } };
  const s = stats(graph);

  return <div className={`neural page-${page}`}>
    <Cosmos reduced={reduced}/>
    <header className="topbar">
      <a className="brand" href={asset('')} onClick={e => { e.preventDefault(); setPage('home'); setFocus({mod: null, sel: null}); }}>
        <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="19" height="19"><g stroke={T.logo[0]} strokeWidth=".7" opacity=".85"><path d="M12 5 6.5 9M12 5l6 3.6M6.5 9 7 17.5M12 5v12.4M18 8.6 17 17.6M7 17.5l10 .1"/></g><path fill={T.logo[2]} d="m12 1.6 1.5 4.3 4.3 1.5-4.3 1.5L12 13.2l-1.5-4.3L6.2 7.4l4.3-1.5Z"/><circle cx="7" cy="17.6" r="1.5" fill={T.logo[1]}/><circle cx="17" cy="17.7" r="1.1" fill={T.logo[3]}/><circle cx="18" cy="8.6" r=".9" fill="#ffffff"/></svg></span>
        <span className="brand-text">{CONFIG.brand.name} <b>/ {CONFIG.brand.sub}</b><small>{CONFIG.brand.tagline} · {CONFIG.brand.taglineEn}</small></span>
      </a>
      <nav aria-label="主导航">{navs.map(([id, zh, en]) => <button key={id} className={page === id ? 'active' : ''} aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)}>{zh}<em>{en}</em></button>)}</nav>
      <div className="top-actions">
        <button className="pill primary" onClick={() => newDraft()}><Icon name="plus" size={14}/>新建草稿 <em>New</em></button>
        <button className="avatar" onClick={() => setModal('about')} aria-label={`${snapshot.account}，查看账号与数据来源`}><img src={asset(CONFIG.avatar)} alt=""/></button>
      </div>
    </header>

    <main>
      {page === 'home' && <>
        <Home graph={graph} layout={layout} focus={focus} setFocus={setFocus} onAction={onAction} onAbout={() => setModal('about')} reduced={reduced}/>
        <Snapshot goal={goal} onGoal={() => { setGoalInput(String(goal)); setModal('goal'); }} ideas={ideas} drafts={drafts} onIdea={editIdea} onDraft={id => { setActive(id); setPage('drafts'); }} onLibrary={id => { if (typeof id === 'string') setLibSel(id); setPage('library'); }}/>
      </>}
      {page === 'library' && <Library graph={graph} selected={libSel} setSelected={setLibSel} onGo={openInGraph} onAction={onAction} onModule={goModule}/>}
      {page === 'drafts' && <Drafts graph={graph} drafts={drafts} setDrafts={setDrafts} active={active} setActive={setActive} onNew={() => newDraft()} onDelete={deleteDraft} onGo={openInGraph} onModule={goModule}/>}
      {page === 'ideas' && <Ideas graph={graph} ideas={ideas} onEdit={editIdea} onGraph={openInGraph} onModule={goModule} onNew={() => editIdea({id: Math.max(0, ...ideas.map(i => i.id)) + 1, title: '', platform: '小红书', priority: '中', status: '待写', note: ''})}/>}
    </main>

    <footer className="site-foot">
      <button onClick={() => setModal('about')}><Icon name="info" size={13}/>当前展示的是虚构示例数据，换成你自己的数据见 README <em>Sample data</em></button>
      <span>{CONFIG.footer.zh}<em>{CONFIG.footer.en}</em></span>
    </footer>

    {toast && <div className="toast glass" role="status"><Icon name="check" size={15}/>{toast}</div>}

    {modal === 'about' && <Modal title="关于这份数据" en="About the data" onClose={close}>
      <div className="about">
        <p>账号 <em>Account</em>：<strong>{snapshot.account}</strong> · 读取日期 <em>Captured</em>：{snapshot.capturedAt}</p>
        <p>数据来源 <em>Source</em>：{snapshot.source}；笔记首发 {snapshot.publishedFrom} — {snapshot.publishedTo}。</p>
        <hr/>
        <h3>图谱怎么来的 <em>How the graph is built</em></h3>
        <p>全部由 <code>src/data/sample.js</code> 里的资料在浏览器中推导，不读取外部 Obsidian 仓库：</p>
        <ul>
          <li><b>[[双链]] Wikilinks</b>：方法笔记与草稿正文中的双链；找不到对应笔记的记为「未创建」。</li>
          <li><b>话题 Topics</b>：作品正文里的 # 话题标签。</li>
          <li><b>正文提及 Mentions</b>：内容中出现概念词（如「模板」「口播」），且至少两条内容提及才成为概念节点。</li>
          <li><b>双向共振 Resonance</b>：两条内容共同提及 ≥2 个概念，或选题与草稿互相记录。</li>
          <li><b>选题来源 Source</b>：草稿记录来源选题；选题状态为「已转草稿」时反向成立。</li>
        </ul>
        <p>作品库：{posts.length} 篇<b>示例作品</b>，账号、标题、日期与指标均为虚构，仅用于展示效果。</p>
        <p>当前：{s.content} 条内容 · {s.links} 条连接 · {s.mutual} 组双向 · {s.ghosts} 个未创建双链。</p>
        <p className="quiet">{meta ? '已连接 NAS 笔记库：选题与草稿会写入 NAS 上的 .md 文件；本月目标只保存在此浏览器。' : '未连接 NAS：选题、草稿与目标都只保存在此浏览器。'}<em>{meta ? 'Connected to NAS vault' : 'Local only (no NAS)'}</em></p>
      </div>
    </Modal>}
    {modal === 'goal' && <Modal title="本月发布目标" en="Monthly goal" onClose={close}>
      <form className="form" onSubmit={e => { e.preventDefault(); const n = Number(goalInput); if (Number.isInteger(n) && n >= 1 && n <= 100) { setGoal(n); setModal(null); setToast('发布目标已更新（只保存在此浏览器）· Saved in this browser'); } }}>
        <p className="quiet">本月已发布 {monthPosts.length} 篇。目标只保存在此浏览器，不写入 NAS <em>Browser only, not synced to NAS</em></p>
        <label>目标篇数 <em>Target</em><input autoFocus type="number" min="1" max="100" step="1" required value={goalInput} onChange={e => setGoalInput(e.target.value)}/></label>
        <div className="form-actions"><button type="button" className="pill ghost" onClick={close}>取消 <em>Cancel</em></button><button className="pill primary">保存目标 <em>Save</em></button></div>
      </form>
    </Modal>}
    {modal === 'idea' && editing && <Modal title="选题详情" en="Idea" onClose={close}>
      <div className="form">
        <p className="quiet">{meta ? '保存后写入 NAS 笔记库（04-选题池/），Obsidian 端同步可见 <em>Saved to vault on NAS</em>' : '未连接 NAS：保存后只在此浏览器 <em>Saved in this browser only</em>'}</p>
        <label>选题标题 <em>Title</em><input autoFocus value={editing.title} onChange={e => setEditing({...editing, title: e.target.value})}/></label>
        <div className="form-row">
          <label>优先级 <em>Priority</em><select value={editing.priority} onChange={e => setEditing({...editing, priority: e.target.value})}><option>高</option><option>中</option><option>低</option></select></label>
          <label>状态 <em>Status</em><select value={editing.status} onChange={e => setEditing({...editing, status: e.target.value})}><option>待写</option><option>待扩展</option><option>已转草稿</option></select></label>
        </div>
        <label>创作备注 <em>Brief</em><textarea value={editing.note} onChange={e => setEditing({...editing, note: e.target.value})}/></label>
        <div className="form-actions">
          <button className="pill ghost" disabled={!editing.title.trim()} onClick={saveIdea}>保存选题 <em>Save</em></button>
          <button className="pill primary" disabled={!editing.title.trim()} onClick={() => toDraft(editing)}><Icon name="draft" size={14}/>{drafts.some(d => d.source === editing.id) ? '打开关联草稿' : '转为草稿'} <em>{drafts.some(d => d.source === editing.id) ? 'Open draft' : 'To draft'}</em></button>
        </div>
        <p className="quiet">转为草稿只生成本地写作提纲，不模拟 AI 生成结果。</p>
      </div>
    </Modal>}
    {modal?.read && <ReadModal node={modal.read} onClose={close} editable={!!meta}/>}
  </div>;
}

// 日报正文渲染：每行独立处理，[标题](链接) 变成可点的标题（链接只在 href 里，不显示 URL），
// ## 行渲染成小标题，列表行渲染成列表项；外链新窗口打开。只读展示，不解析任意 Markdown。
function renderNewsBody(body) {
  const link = (label, url) => <a href={url} target="_blank" rel="noreferrer noopener">{label}</a>;
  return String(body || '').split('\n').map((line, i) => {
    const h = line.match(/^##\s+(.+)/);
    if (h) return <h3 key={i}>{h[1]}</h3>;
    const li = line.match(/^-\s+(.*)$/);
    if (li) {
      const m = li[1].match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      return <p className="rn-item" key={i}>{m ? link(m[1], m[2]) : li[1]}</p>;
    }
    const all = line.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (all) return <p key={i}>{link(all[1], all[2])}</p>;
    if (!line.trim()) return null;
    return <p key={i}>{line}</p>;
  });
}

// 方法笔记 / 作品的阅读弹窗。部署模式下提供「编辑正文」：拉原文 → textarea → 保存落盘。
function ReadModal({node, onClose, editable}) {
  const isNote = node.kind === 'note';
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(node.body || '');
  const [mtime, setMtime] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // 部署模式下拉服务器上的原文（带 mtime 做乐观锁）；本地模式直接用图谱里的 body。
  useEffect(() => {
    if (!editing || !isNote) return;
    let on = true;
    fetch('/api/note?id=' + encodeURIComponent(node.id)).then(r => r.json()).then(j => {
      if (on) { setText(j.text || node.body || ''); setMtime(j.mtime); }
    }).catch(() => { if (on) { setText(node.body || ''); setErr('读不到原文，编辑的是看板缓存'); } });
    return () => { on = false; };
  }, [editing, isNote, node.id, node.body]);

  async function save() {
    setBusy(true); setErr('');
    try {
      const res = await fetch('/api/note', {
        method: 'PUT', headers: {'content-type': 'application/json'},
        body: JSON.stringify({id: node.id, body: text, mtime})
      });
      if (res.status === 409) {
        const j = await res.json().catch(() => ({}));
        setErr('文件已被 Obsidian 或其他编辑器改动，没有覆盖。请重新打开比对 · Conflict: file changed elsewhere, not overwritten');
        setMtime(j.mtime); setText(j.content || text);
        return;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      onClose();
    } catch (e) { setErr('保存失败：' + e.message + ' · Save failed'); }
    finally { setBusy(false); }
  }

  return <Modal title={node.short || node.title} en={KINDS[node.kind].en} onClose={onClose} wide>
    {!editing
      ? <div className="reader">
          <p className="quiet">{node.path}</p>
          {/* 日报（news）：把 [标题](链接) 渲染成可点的标题，链接本身不显示；其余保持纯文本 */}
          {node.kind === 'news'
            ? <div className="reader-news">{renderNewsBody(node.body)}</div>
            : <pre>{node.body}</pre>}
          {(isNote || node.kind === 'news') && editable && <div className="form-actions">
            <button className="pill primary" onClick={() => setEditing(true)}><Icon name="draft" size={14}/>编辑正文 <em>Edit</em></button>
            <span className="quiet">改动会写回 NAS 笔记库文件 <em>Writes back to the vault on NAS</em></span>
          </div>}
        </div>
      : <div className="reader">
          <p className="quiet">{node.path} · 保存前会比对修改时间，不会静默覆盖别人的改动 <em>Conflict-safe</em></p>
          <textarea className="reader-edit" value={text} onChange={e => setText(e.target.value)} rows={16} aria-label="编辑笔记正文" autoFocus/>
          {err && <p className="quiet" role="alert">{err}</p>}
          <div className="form-actions">
            <button className="pill ghost" onClick={() => { setEditing(false); setErr(''); }} disabled={busy}>取消 <em>Cancel</em></button>
            <button className="pill primary" onClick={save} disabled={busy || mtime == null}>{busy ? '保存中…' : '保存到 NAS 笔记库'} <em>Save to vault on NAS</em></button>
          </div>
        </div>}
  </Modal>;
}

createRoot(document.getElementById('root')).render(<App/>);
