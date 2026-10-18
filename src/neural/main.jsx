import React, {useCallback, useDeferredValue, useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {seedIdeas, seedDrafts, snapshot, settings, isLive} from '../data';
import {subscribe as subscribeData, getFiles, getData} from '../data/store.js';
import {posts, monthPostsOf} from './works';
import {CONFIG, asset} from '../config';
import {buildGraph, forceLayout, stats, KINDS, MODULES} from './graph';
import {Home} from './Home';
import {Cosmos} from './Cosmos';
import {Library, Drafts, Ideas, Knowledge, Methods} from './pages';
import {PublishDialog} from './PublishDialog';
import {NewNoteModal, PublishModal} from './NoteModal';
import {DiffModal} from './DiffModal';
import {SettingsPanel} from './SettingsPanel';
import {insertImageAtCursor} from './NoteModal';
import {Count} from './Analysis';
import {Icon} from './icons';
import {T} from './theme';
import * as persist from './persist';
import {SaveBadge, SyncBanner} from './SaveStatus';
import './neural.css';

// 业务数据只存 NAS（部署模式）；纯静态模式只读，不写 localStorage。
// 保存状态、离线重试、409 冲突都由 persist.js 统一处理。

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

const navs = [['home', '工作台', 'Workspace'], ['library', '作品库', 'Works'], ['drafts', '创作台', 'Drafts'], ['ideas', '选题池', 'Ideas'], ['knowledge', '知识库', 'Knowledge'], ['methods', '方法库', 'Methods']];
const initialPage = () => { const h = location.hash.slice(1); return navs.some(n => n[0] === h) ? h : 'home'; };

function Snapshot({goal, onGoal, ideas, drafts, onIdea, onDraft, onLibrary, monthCount}) {
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
          <button className="ring" onClick={onGoal} aria-label={`修改目标，本月 ${monthCount} 篇，目标 ${goal} 篇`}>
            <svg viewBox="0 0 180 180"><defs><linearGradient id="ring-g" x1="0" x2="1"><stop offset="0" stopColor={T.ring[0]}/><stop offset="1" stopColor={T.ring[1]}/></linearGradient></defs><circle cx="90" cy="90" r="72" className="track"/><circle cx="90" cy="90" r="72" className="value" strokeDasharray={`${Math.min(monthCount / goal, 1) * 452.39} 452.39`}/></svg>
            <span><strong>{monthCount}</strong>/{goal}<small>本月目标 Goal</small></span>
          </button>
          <div className="plan-ideas"><h3>下一篇写什么 <em>Up next</em></h3>{ideas.slice(0, 3).map((idea, i) => <button key={idea.id} onClick={() => onIdea(idea)}><b>{i + 1}</b><span>{idea.title}</span></button>)}</div>
        </div>
        <button className="plan-draft" onClick={() => onDraft(drafts[0]?.id)}><Icon name="draft" size={15}/>继续创作 <em>Continue</em><span>{drafts[0]?.title || '开始第一篇草稿'}</span><Icon name="arrow" size={15}/></button>
      </section>
    </div>
  </section>;
}

function App() {
  const live = isLive();
  const [page, setPage] = useState(initialPage);
  const [goal, setGoal] = useState(() => settings?.goal ?? 8);
  const [ideas, setIdeas] = useState(seedIdeas);
  const [drafts, setDrafts] = useState(seedDrafts);
  const [active, setActive] = useState(() => drafts[0]?.id);
  const [focus, setFocus] = useState({mod: null, sel: null});
  const [libSel, setLibSel] = useState(posts[1]?.id ?? null);
  const [modal, setModal] = useState(null);
  const [editing, setEditing] = useState(null);
  const [goalInput, setGoalInput] = useState(String(goal));
  const [toast, setToast] = useState('');
  const [settingsLive, setSettingsLive] = useState(null); // /api/settings 的脱敏视图（打开设置时现拉）
  const [settingsRev, setSettingsRev] = useState(0); // AI 配置保存后手动刷新（重新拉 settings + ai info）
  const [aiInfo, setAiInfo] = useState(null);
  const [dataRev, setDataRev] = useState(0);
  const reduced = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  const slowDrafts = useDeferredValue(drafts);
  // 数据仓变化（AI 语义边写回、外部改动自动刷新）时重建图谱，不必刷新页面。
  // 同步把 store 里的选题/草稿搬进本地 state：新增/删除总是跟随；
  // 已有条目只有在没有未保存编辑（persist.isPending）时才覆盖，正在写的草稿不会被外部刷新冲掉。
  useEffect(() => subscribeData(() => {
    setDataRev(v => v + 1);
    const d = getData();
    if (isLive()) {
      if (Array.isArray(d.seedIdeas)) setIdeas(list => {
        const byId = new Map(list.map(x => [x.id, x]));
        return (d.seedIdeas || []).map(x => (byId.get(x.id) && persist.isPending(persist.ideaKey(x.id))) ? byId.get(x.id) : x);
      });
      if (Array.isArray(d.seedDrafts)) setDrafts(list => {
        const freshIds = new Set((d.seedDrafts || []).map(x => x.id));
        const kept = list.filter(x => !freshIds.has(x.id)); // store 里已消失的本地草稿保留（未落盘的新建稿）
        return [...(d.seedDrafts || []).map(x => {
          const prev = list.find(y => y.id === x.id);
          return (prev && persist.isPending(persist.draftKey(x.id))) ? prev : x;
        }), ...kept];
      });
    }
  }), []);
  // 外部改动自动刷新：每 5s 轮询 /api/version 的 vault 指纹，变了就 refreshData()。
  // 自己刚写盘（4s 内）不拉取——数据就是本页刚写的；页面不可见时暂停，回来立即查一次。
  useEffect(() => {
    if (!live) return;
    let stopped = false, lastV = null;
    let timer;
    const check = async () => {
      try {
        const r = await fetch(persist.apiUrl('/api/version'));
        if (!r.ok) return;
        const j = await r.json();
        if (stopped) return;
        if (lastV != null && j.v !== lastV) {
          if (Date.now() - persist.lastSelfWrite() < 4000) { lastV = j.v; return; }
          lastV = j.v;
          await persist.refreshData();
          setToast('笔记库有外部改动，看板已更新 · Vault updated');
          return;
        }
        lastV = j.v;
      } catch { /* 服务暂不可达，下个周期再试 */ }
    };
    const tick = () => { if (!document.hidden) check().finally(() => { if (!stopped) timer = setTimeout(tick, 5000); }); else timer = setTimeout(tick, 5000); };
    const onVis = () => { if (!document.hidden) check(); };
    tick();
    document.addEventListener('visibilitychange', onVis);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); };
  }, [live]);

  const graph = useMemo(() => buildGraph({ideas, drafts: slowDrafts}), [ideas, slowDrafts, dataRev]);
  // 「本月已发布」随数据仓变化现算：发布新作品 / 外部改动刷新后，环形进度与设置面板立即反映实际数量
  const monthPosts = useMemo(() => monthPostsOf(getData().posts), [dataRev]);
  const layout = useMemo(() => forceLayout(graph), [graph]);
  const draftsRef = useRef(drafts);
  useEffect(() => { draftsRef.current = drafts; }, [drafts]);
  const goalSave = persist.useSaveState('goal');
  const pendingSaves = persist.usePendingSaves();
  const saveItems = pendingSaves.map(({key, state}) => {
    let label = key;
    if (key === 'goal') label = '本月目标 Monthly goal';
    else if (key === 'aiModel') label = 'AI 模型 Model';
    else if (key.startsWith('idea:')) label = ideas.find(i => 'idea:' + i.id === key)?.title || '选题 Idea';
    else if (key.startsWith('draft:')) label = drafts.find(d => 'draft:' + d.id === key)?.title || '草稿 Draft';
    return {key, state, label};
  });

  // 旧版把选题/草稿/目标存在 localStorage；现在以 NAS 为唯一真相，连上后清掉旧键（不上传）。
  useEffect(() => {
    if (!live) return;
    try {
      const prefix = CONFIG.storagePrefix + '-';
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith(prefix) || key === 'ai-model') localStorage.removeItem(key);
      }
    } catch {}
  }, [live]);

  // 打开草稿时补拉完整正文：/api/data 里的正文被服务端截断到 6000 字，
  // 直接写回会丢内容。用户在这期间已经开始改的话就不覆盖。
  useEffect(() => {
    if (!live || !active) return;
    const before = draftsRef.current.find(x => x.id === active)?.body ?? '';
    let on = true;
    persist.hydrateDraft(active).then(full => {
      if (!on || !full) return;
      setDrafts(list => list.map(x => x.id === active && (x.body ?? '') === before ? {...x, body: full.body} : x));
    }).catch(() => {});
    return () => { on = false; };
  }, [active, live]);

  useEffect(() => { history.replaceState(null, '', page === 'home' ? location.pathname : '#' + page); window.scrollTo({top: 0}); }, [page]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 2800); return () => clearTimeout(t); }, [toast]);

  // 打开设置弹窗时现拉一份脱敏设置（公众号是否已配置、同步时间等）。
  // seqRef 防乱序：并发重拉时（弹窗开着保存了多次），只有最新一次的响应允许落盘，
  // 旧快照晚到不会再覆盖新状态。
  const settingsSeq = useRef(0);
  useEffect(() => {
    if (modal !== 'settings') return;
    const seq = ++settingsSeq.current;
    fetch(persist.apiUrl('/api/settings')).then(r => r.json()).then(j => { if (seq === settingsSeq.current) setSettingsLive(j); }).catch(() => {});
  }, [modal, settingsRev]); // settingsRev：AI 配置保存后重拉

  // AI 启用状态（Assistant / AiPanel / 设置面板的单一事实源）：挂载即拉，保存 AI 配置后重拉。
  // 不挂 dataRev——aiInfo 只在保存 AI 配置时才会变，跟随每次 vault 变化重拉是纯浪费，
  // 还会在设置弹窗开着时连带刷掉正在编辑的表单。
  useEffect(() => {
    if (!live) return;
    let on = true;
    fetch(persist.apiUrl('/api/ai/info')).then(r => r.json()).then(j => { if (on) setAiInfo(j); }).catch(() => {});
    return () => { on = false; };
  }, [live, settingsRev]);

  const close = useCallback(() => setModal(null), []);
  const signOut = useCallback(async () => {
    try { await fetch(persist.apiUrl('/api/logout'), {method: 'POST'}); } catch {}
    location.replace((import.meta.env.BASE_URL || '/') + 'login.html');
  }, []);
  const sourceTitleOf = sourceId => ideas.find(i => i.id === sourceId)?.title || null;
  const onDraftDirty = useCallback(d => {
    if (!live) return;
    persist.scheduleDraft(d, sourceTitleOf(d.source));
  }, [live, ideas]); // eslint-disable-line react-hooks/exhaustive-deps

  function newDraft(title = '未命名草稿', body = '', source = null, sourceTitle = null) {
    if (!live) { setToast('未连接 NAS，当前为只读演示 · Read-only (no NAS)'); return; }
    const id = 'draft-' + Date.now();
    const draft = {id, title, body, source};
    setDrafts(d => [draft, ...d]);
    setActive(id); setPage('drafts'); setModal(null);
    // 新建后立刻落盘；服务端返回的 path/mtime 由 persist 记住，后续编辑无需刷新。
    persist.createDraft({id, title, body, sourceTitle: sourceTitle ?? sourceTitleOf(source)})
      .then(ref => {
        const st = persist.getSaveState(persist.draftKey(id));
        if (st.state === 'error') setToast(st.message || '草稿创建失败 · Create failed');
        else setToast(ref
          ? '草稿已创建，已写入 NAS 笔记库（03-创作台/）· Saved to vault on NAS'
          : '草稿已创建，等待网络写入 NAS · Waiting to sync to NAS');
      });
  }
  function editIdea(idea) {
    if (!live) { setToast('未连接 NAS，当前为只读演示 · Read-only (no NAS)'); return; }
    setEditing({...idea});
    setModal('idea');
    // 看板缓存里的 note 可能被截断；打开时补拉一次完整备注，用户没改再替换。
    const before = idea.note ?? '';
    persist.hydrateIdea(idea.id).then(full => {
      if (!full) return;
      setEditing(cur => cur && cur.id === idea.id && (cur.note ?? '') === before ? {...cur, note: full.note} : cur);
    }).catch(() => {});
  }
  function saveIdea() {
    if (!live || !editing.title.trim()) return;
    const prev = ideas.find(i => i.id === editing.id);
    setIdeas(ideas.some(i => i.id === editing.id) ? ideas.map(i => i.id === editing.id ? editing : i) : [...ideas, editing]);
    setModal(null);
    persist.saveIdeaNow(editing).then(() => {
      const st = persist.getSaveState(persist.ideaKey(editing.id));
      if (st.state === 'saved') setToast('选题已保存到 NAS 笔记库（04-选题池/）· Saved to vault on NAS');
      else setToast(st.message || '选题保存中… · Saving to NAS');
    });
  // 选题改名不再需要同步草稿：sourceIdeaId（稳定 id）关联，标题变了边还在
  }
  function toDraft(idea) {
    if (!live) { setToast('未连接 NAS，当前为只读演示 · Read-only (no NAS)'); return; }
    const existing = drafts.find(d => d.source === idea.id);
    if (existing) { setActive(existing.id); setPage('drafts'); setModal(null); setToast('已打开关联草稿 · Linked draft opened'); return; }
    const item = {...idea, status: '已转草稿'};
    setIdeas(ideas.some(i => i.id === item.id) ? ideas.map(i => i.id === item.id ? item : i) : [...ideas, item]);
    persist.saveIdeaNow(item);
    newDraft(item.title, `【根据选题创建的写作提纲，未调用 AI】\n\n创作方向：${item.note}\n\n开场：\n\n核心观点：\n\n操作示例：\n\n结尾：`, item.id, item.title);
  }
  async function deleteDraft(id) {
    if (!live) { setToast('未连接 NAS，当前为只读演示 · Read-only (no NAS)'); return; }
    const d = drafts.find(x => x.id === id);
    if (!window.confirm(`删除草稿「${d?.title || '未命名草稿'}」？NAS 上的 .md 文件会先备份到 vault/.trash/ 再删除。\nThis deletes the note file on NAS (backed up to .trash/).`)) return;
    const r = await persist.deleteDraft(id);
    if (!r.ok) { setToast((r.error || '删除失败') + ' · Delete failed'); return; }
    const rest = draftsRef.current.filter(x => x.id !== id);
    setDrafts(rest); setActive(rest[0]?.id);
    setToast(r.gone ? '草稿已删除，原文件已备份到 vault/.trash/ · Deleted (backed up to .trash/)' : '草稿已删除 · Draft deleted');
  }
  const onAction = useCallback(a => {
    if (a.type === 'page') { if (a.page === 'library') setLibSel(a.id); if (a.page === 'drafts') setActive(a.id); setPage(a.page); }
    if (a.type === 'read') setModal({read: graph.index.get(a.id)});
    if (a.type === 'editIdea') editIdea(a.idea);
    if (a.type === 'ideaToDraft') toDraft(a.idea);
    if (a.type === 'url') window.open(a.url, '_blank', 'noopener');
    if (a.type === 'snapshot') window.open(persist.apiUrl('/api/knowledge/snapshot?path=' + encodeURIComponent(a.path)), '_blank', 'noopener');
    if (a.type === 'publish') publishDraft(a.draftId, a.platform);
  }, [graph, drafts, ideas]); // eslint-disable-line react-hooks/exhaustive-deps

  // 半自动发布：补全正文（看板缓存截断过）→ 打开发布对话框
  function publishDraft(draftId, platform) {
    if (!live) { setToast('未连接 NAS，当前为只读演示 · Read-only (no NAS)'); return; }
    const draft = draftsRef.current.find(x => x.id === draftId);
    if (!draft) return;
    setModal({publish: {draftId, platform}});
    persist.hydrateDraft(draftId).then(full => {
      if (!full) return;
      setDrafts(list => list.map(x => x.id === draftId && (x.body ?? '') === draft.body ? {...x, body: full.body} : x));
    }).catch(() => {});
  }
  // 草稿 → 作品：打开发布表单（移动文件 + 可选指标），作品唯一的创建入口。
  // 路径从 /api/data 的 files 映射反查（draft:<id> → vault 相对路径），未落盘的草稿没有 path。
  function toPost(draft) {
    if (!live) { setToast('未连接 NAS，当前为只读演示 · Read-only (no NAS)'); return; }
    const path = getFiles()['draft:' + draft.id] || null;
    if (!path) { setToast('草稿还没同步到 NAS，等保存完成后再发布 · Not synced yet'); return; }
    setModal({toPost: {path, title: draft.title}});
  }
  // 回填保存：更新草稿对象并走同一条防抖保存管线（platform/url/platformId/syncedAt 随 fm 落盘）
  function savePublishBack(published) {
    setDrafts(list => list.map(x => x.id === published.id ? published : x));
    onDraftDirty(published);
    setToast('发布来源已写入草稿，发布后同名作品会自动带上 · Source saved');
    setModal(null);
  }
  // 内页星座轨 / 标签的点击：本模块有内页就直接切页，没有就回工作台并展开该星座
  const goModule = useCallback(id => {
    const m = MODULES.find(x => x.id === id);
    if (m?.page) setPage(m.page); else { setFocus({mod: id, sel: null}); setPage('home'); }
  }, []);
  const openInGraph = id => { const n = graph.index.get(id); const mod = {post: 'works', note: 'methods', idea: 'ideas', draft: 'drafts', concept: 'concepts', personal: 'personal'}[n?.kind]; if (mod) { setFocus({mod, sel: id}); setPage('home'); } };
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
        <button className="pill primary" onClick={() => newDraft()} disabled={!live} title={live ? '' : '未连接 NAS，只读'}><Icon name="plus" size={14}/>新建草稿 <em>New</em></button>
        <button className="avatar set-btn" onClick={() => { setSettingsLive(null); setModal('settings'); }} aria-label="打开设置"><Icon name="gear" size={17}/></button>
        <button className="avatar" onClick={() => setModal('about')} aria-label={`${snapshot.account}，查看账号与数据来源`}><img src={asset(CONFIG.avatar)} alt=""/></button>
      </div>
    </header>

    {live
      ? <SyncBanner items={saveItems} onRetry={persist.retry} onOverwrite={persist.overwriteConflict} onRefresh={() => location.reload()} onDiff={key => setModal({diff: key})}/>
      : <div className="sync-banner glass read-only" role="status">
          <span className="sb-title"><Icon name="info" size={14}/>未连接 NAS 笔记库 · 只读演示 <em>Read-only (no NAS)</em></span>
          <span className="sb-item">选题、草稿与目标的编辑已禁用；连接 note-api 后自动恢复 <em>Connect note-api to edit</em></span>
        </div>}

    <main>
      {page === 'home' && <>
        <Home graph={graph} layout={layout} focus={focus} setFocus={setFocus} onAction={onAction} onAbout={() => setModal('about')} reduced={reduced} aiEnabled={aiInfo?.enabled} embedEnabled={!!aiInfo?.embed?.enabled}/>
        <Snapshot goal={goal} onGoal={() => { setGoalInput(String(goal)); setModal('goal'); }} ideas={ideas} drafts={drafts} onIdea={editIdea} onDraft={id => { setActive(id); setPage('drafts'); }} onLibrary={id => { if (typeof id === 'string') setLibSel(id); setPage('library'); }} monthCount={monthPosts.length}/>
      </>}
      {page === 'library' && <Library graph={graph} selected={libSel} setSelected={setLibSel} onGo={openInGraph} onAction={onAction} onModule={goModule} aiEnabled={aiInfo?.enabled} embedEnabled={!!aiInfo?.embed?.enabled}/>}
      {page === 'drafts' && <Drafts graph={graph} drafts={drafts} setDrafts={setDrafts} active={active} setActive={setActive} onNew={() => newDraft()} onDelete={deleteDraft} onDirty={onDraftDirty} readOnly={!live} onGo={openInGraph} onModule={goModule} onPublish={publishDraft} onToPost={toPost} aiEnabled={aiInfo?.enabled}/>}
      {page === 'ideas' && <Ideas graph={graph} ideas={ideas} onEdit={editIdea} onGraph={openInGraph} onModule={goModule} readOnly={!live} onNew={() => editIdea({id: Math.max(0, ...ideas.map(i => i.id)) + 1, title: '', platform: '小红书', priority: '中', status: '待写', note: ''})}/>}
      {page === 'methods' && <Methods graph={graph} readOnly={!live} onGo={openInGraph} onAction={onAction} onModule={goModule} showToast={setToast} onNew={() => setModal('new-note')} aiEnabled={aiInfo?.enabled} embedEnabled={!!aiInfo?.embed?.enabled}/>}
      {page === 'knowledge' && <Knowledge graph={graph} readOnly={!live} onGraph={openInGraph} onModule={goModule} onAction={onAction} onNewDraft={newDraft} onEditIdea={editIdea} ideas={ideas} drafts={drafts} onDeleteDraft={deleteDraft} showToast={setToast} aiEnabled={aiInfo?.enabled}/>}
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
        <p>全部由当前笔记库的资料在浏览器中推导，不依赖 Obsidian 插件：</p>
        <ul>
          <li><b>[[双链]] Wikilinks</b>：方法笔记与草稿正文中的双链；找不到对应笔记的记为「未创建」。</li>
          <li><b>话题 Topics</b>：内容正文里的 # 话题标签和 frontmatter 的 tags，都会自动成为话题节点。</li>
          <li><b>正文提及 Mentions</b>：内容中出现概念词（如「模板」「口播」），且至少两条内容提及才成为概念节点。</li>
          <li><b>双向共振 Resonance</b>：两条内容共同提及 ≥2 个概念，或选题与草稿互相记录。</li>
          <li><b>选题来源 Source</b>：草稿记录来源选题；选题状态为「已转草稿」时反向成立；缺 <code>source</code> 时按同名标题自动回连。</li>
          <li><b>发布为作品 Published as</b>：草稿与作品标题相同（忽略编号和 Obsidian 前缀）即自动连线。</li>
          <li><b>热点依据 News source</b>：选题的 <code>sourceNews</code> 指向当天的 AI 热点日报。</li>
          <li><b>同名概念 Shared concept</b>：方法笔记侧和作品侧出现同名概念时自动桥接。</li>
          <li><b>语义相关 Semantic</b>：部署模式下由 embedding 计算并持久化的语义边。</li>
        </ul>
        <p>作品库：{posts.length} 篇<b>示例作品</b>，账号、标题、日期与指标均为虚构，仅用于展示效果。</p>
        <p>当前：{s.content} 条内容 · {s.links} 条连接 · {s.mutual} 组双向 · {s.ghosts} 个未创建双链。</p>
        <p className="quiet">{live ? '已连接 NAS 笔记库：选题、草稿与目标都写入 NAS（设置文件为 vault/.dashboard/settings.json），浏览器不保存业务数据。' : '未连接 NAS：当前为只读演示，编辑入口已禁用。'}<em>{live ? 'All data lives on the NAS vault' : 'Read-only demo (no NAS)'}</em></p>
        {live && <div className="form-actions signout-row">
          <button className="pill ghost" onClick={signOut}>退出登录 <em>Sign out</em></button>
        </div>}
      </div>
    </Modal>}
    {modal === 'goal' && <Modal title="本月发布目标" en="Monthly goal" onClose={close}>
      <form className="form" onSubmit={e => {
        e.preventDefault();
        const n = Number(goalInput);
        if (!(Number.isInteger(n) && n >= 1 && n <= 100)) return;
        setGoal(n); setModal(null);
        if (!live) return;
        persist.saveGoal(n).then(() => {
          const st = persist.getSaveState('goal');
          setToast(st.state === 'saved' ? '发布目标已保存到 NAS · Saved to NAS' : (st.message || '目标保存中… · Saving to NAS'));
        });
      }}>
        <p className="quiet">{live ? `本月已发布 ${monthPosts.length} 篇。目标写入 NAS 设置文件 vault/.dashboard/settings.json` : `本月已发布 ${monthPosts.length} 篇。未连接 NAS，当前为只读演示。`}<em>{live ? 'Synced to NAS' : 'Read-only (no NAS)'}</em></p>
        <label>目标篇数 <em>Target</em><input autoFocus type="number" min="1" max="100" step="1" required disabled={!live} value={goalInput} onChange={e => setGoalInput(e.target.value)}/></label>
        <div className="form-actions">{live && <SaveBadge state={goalSave}/>}<button type="button" className="pill ghost" onClick={close}>取消 <em>Cancel</em></button><button className="pill primary" disabled={!live}>保存目标 <em>Save</em></button></div>
      </form>
    </Modal>}
    {modal === 'settings' && <Modal title="设置" en="Settings" onClose={close} wide>
      <SettingsPanel
        settings={settingsLive}
        ai={aiInfo}
        goal={goal}
        monthCount={monthPosts.length}
        readOnly={!live}
        onClose={close}
        onRefresh={() => {
          // 只需重拉 aiInfo / settings（AI 配置的单一事实源）；全量 refreshData 已无必要——
          // Assistant / AiPanel 都读 aiInfo prop，store.data.ai 没有消费者了。
          setSettingsRev(v => v + 1);
        }}
      />
      {live && <div className="form-actions signout-row">
        <button className="pill ghost" onClick={signOut}>退出登录 <em>Sign out</em></button>
      </div>}
    </Modal>}
    {modal === 'idea' && editing && <Modal title="选题详情" en="Idea" onClose={close}>
      <div className="form">
        <p className="quiet">{live ? '保存后写入 NAS 笔记库（04-选题池/），Obsidian 端同步可见' : '未连接 NAS：只读演示，编辑已禁用'}<em>{live ? 'Saved to vault on NAS' : 'Read-only (no NAS)'}</em></p>
        <label>选题标题 <em>Title</em><input autoFocus disabled={!live} value={editing.title} onChange={e => setEditing({...editing, title: e.target.value})}/></label>
        <div className="form-row">
          <label>优先级 <em>Priority</em><select disabled={!live} value={editing.priority} onChange={e => setEditing({...editing, priority: e.target.value})}><option>高</option><option>中</option><option>低</option></select></label>
          <label>状态 <em>Status</em><select disabled={!live} value={editing.status} onChange={e => setEditing({...editing, status: e.target.value})}><option>待写</option><option>待扩展</option><option>已转草稿</option></select></label>
        </div>
        <label>创作备注 <em>Brief</em><textarea disabled={!live} value={editing.note} onChange={e => setEditing({...editing, note: e.target.value})}/></label>
        <div className="form-actions">
          <button className="pill ghost" disabled={!live || !editing.title.trim()} onClick={saveIdea}>保存选题 <em>Save</em></button>
          <button className="pill primary" disabled={!live || !editing.title.trim()} onClick={() => toDraft(editing)}><Icon name="draft" size={14}/>{drafts.some(d => d.source === editing.id) ? '打开关联草稿' : '转为草稿'} <em>{drafts.some(d => d.source === editing.id) ? 'Open draft' : 'To draft'}</em></button>
        </div>
        <p className="quiet">转为草稿只生成本地写作提纲，不模拟 AI 生成结果。</p>
      </div>
    </Modal>}
    {modal?.read && <ReadModal node={modal.read} onClose={close} editable={live}/>}
    {modal?.diff && (() => {
      const c = persist.conflictInfo(modal.diff);
      if (!c) return null;
      return <DiffModal title={c.localTitle || c.path || '冲突'}
        aText={persist.stripFrontmatter(c.serverContent)} bText={c.localBody || ''}
        aLabel="NAS 版本 NAS" bLabel="我的版本 Mine"
        onClose={close}
        onKeepServer={() => { persist.discardLocal(modal.diff); setModal(null); setToast('已采用 NAS 版本，本地改动放弃 · NAS version kept'); persist.refreshData().catch(() => {}); }}
        onKeepMine={() => { persist.overwriteConflict(modal.diff); setModal(null); setToast('已用本地版本覆盖 NAS · Overwritten with mine'); }}/>;
    })()}
    {modal === 'new-note' && <NewNoteModal onClose={close} onDone={path => { setModal(null); setToast('方法笔记已创建（05-方法库/），刷新后进图谱 · Note created'); location.reload(); }}/>}
    {modal?.toPost && (() => {
      const draft = drafts.find(x => x.title === modal.toPost.title);
      if (!draft) return null;
      return <PublishModal draft={{...draft, path: modal.toPost.path}} onClose={close}
        onDone={path => { setModal(null); setToast('作品已生成（02-作品库/），正在刷新 · Post created'); location.reload(); }}/>;
    })()}
    {modal?.publish && (() => {
      const draft = drafts.find(x => x.id === modal.publish.draftId);
      if (!draft) return null;
      return <Modal title="发布此稿" en="Publish" onClose={close} wide>
        <PublishDialog draft={draft} defaultPlatform={modal.publish.platform}
          sourcePlatform={ideas.find(i => i.id === draft.source)?.platform}
          onClose={close} onSave={savePublishBack}/>
      </Modal>;
    })()}
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

// 方法笔记 / 个人知识库 / 作品的阅读弹窗。部署模式下提供「编辑正文」：拉原文 → textarea → 保存落盘。
function ReadModal({node, onClose, editable}) {
  const isNote = node.kind === 'note' || node.kind === 'personal';
  const editArea = React.useRef(null);
  const personal = node.kind === 'personal' ? node.personal || {} : null;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(node.body || '');
  const [mtime, setMtime] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [serverText, setServerText] = useState(null); // 409 时的 NAS 版本，diff 用
  const [diffView, setDiffView] = useState(null); // {a, b} 内部 diff 弹窗

  // 部署模式下拉服务器上的原文（带 mtime 做乐观锁）；本地模式直接用图谱里的 body。
  useEffect(() => {
    if (!editing || !isNote) return;
    let on = true;
    fetch(persist.apiUrl('/api/note?id=' + encodeURIComponent(node.id))).then(r => r.json()).then(j => {
      if (on) { setText(j.text || node.body || ''); setMtime(j.mtime); }
    }).catch(() => { if (on) { setText(node.body || ''); setErr('读不到原文，编辑的是看板缓存'); } });
    return () => { on = false; };
  }, [editing, isNote, node.id, node.body]);

  async function save() {
    setBusy(true); setErr('');
    try {
      const res = await fetch(persist.apiUrl('/api/note'), {
        method: 'PUT', headers: {'content-type': 'application/json'},
        body: JSON.stringify({id: node.id, body: text, mtime})
      });
      if (res.status === 409) {
        const j = await res.json().catch(() => ({}));
        setErr('文件已被其他编辑器改动，未覆盖 · Conflict: file changed elsewhere, not overwritten');
        setMtime(j.mtime);
        setServerText(j.content || ''); // NAS 当前版本，供 diff；不再直接覆盖编辑框（丢输入）
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
          {personal && <p className="quiet">{personal.url
            ? <>来源 <em>Source</em>：<a href={personal.url} target="_blank" rel="noopener noreferrer">{personal.domain || personal.url}</a>
               {personal.snapshot && <> · <a href={persist.apiUrl('/api/knowledge/snapshot?path=' + encodeURIComponent(personal.snapshot))} target="_blank" rel="noopener noreferrer">查看快照 <em>Snapshot</em></a></>}</>
            : <>个人知识库 · {personal.category || '笔记'} <em>Personal knowledge</em></>}</p>}
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
          <div className="reader-edit-row">
            <textarea ref={editArea} className="reader-edit" value={text} onChange={e => setText(e.target.value)} rows={16} aria-label="编辑笔记正文" autoFocus/>
            {editable && <label className="img-insert" title="上传图片并插入 ![[ ]]">
              <input type="file" accept="image/*" className="visually-hidden" onChange={async e => {
                const f = e.target.files?.[0]; e.target.value = '';
                if (!f) return;
                const err = await insertImageAtCursor(editArea, f, setText);
                if (err) setErr(err);
              }}/>
              <button type="button" className="icon-btn" onClick={e => { e.preventDefault(); e.currentTarget.closest('label')?.querySelector('input')?.click(); }} aria-label="插入图片"><Icon name="save" size={14}/></button>
            </label>}
          </div>
          {err && <p className="quiet" role="alert">{err}
              {serverText != null && <> · <button className="text-btn" onClick={() => setDiffView({a: serverText, b: text, mtime: mtime})}>对比差异 <em>Diff</em></button></>}
            </p>}
          <div className="form-actions">
            <button className="pill ghost" onClick={() => { setEditing(false); setErr(''); setServerText(null); }} disabled={busy}>取消 <em>Cancel</em></button>
            <button className="pill primary" onClick={save} disabled={busy || mtime == null}>{busy ? '保存中…' : '保存到 NAS 笔记库'} <em>Save to vault on NAS</em></button>
          </div>
        </div>}

    {diffView && <DiffModal title={node.short || node.title} en="Conflict diff"
      aText={persist.stripFrontmatter(diffView.a)} bText={diffView.b}
      aLabel="NAS 版本 NAS" bLabel="我的编辑 Mine"
      onClose={() => setDiffView(null)}
      onKeepServer={() => { setText(persist.stripFrontmatter(diffView.a)); setMtime(diffView.mtime); setDiffView(null); setErr(''); setServerText(null); }}
      onKeepMine={() => { setDiffView(null); setServerText(null); setErr('保留本地编辑，重新保存将覆盖 NAS · Keeping mine'); }}/>}
  </Modal>;
}

createRoot(document.getElementById('root')).render(<App/>);
