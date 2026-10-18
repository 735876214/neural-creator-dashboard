import React, {useEffect, useMemo, useState} from 'react';
import {KINDS, CONTENT, MODULES, neighbors, latent, askGraph, LINK_KINDS, LINK_EN} from './graph';
import {Icon} from './icons';
import {profileFor, bandsOf, outerCountOf} from './v41';
import {isLive, getMeta, getFiles, setSemantic} from '../data/store';
import {aiAnalyze, aiRelate, aiIdeas, aiModels, pickedModel, setPickedModel} from './sync';
import {apiUrl, refreshData} from './persist';

const fmt = (v, d = 0) => v == null || Number.isNaN(v) ? '—' : Number(v).toLocaleString('zh-CN', {minimumFractionDigits: d, maximumFractionDigits: d});
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Count({value, decimals = 0, suffix = ''}) {
  const [v, setV] = useState(reducedMotion() ? value : 0);
  useEffect(() => {
    if (value == null || reducedMotion()) { setV(value); return; }
    let raf; const t0 = performance.now();
    const run = now => { const p = Math.min(1, (now - t0) / 1000); setV(value * (1 - Math.pow(1 - p, 3))); if (p < 1) raf = requestAnimationFrame(run); };
    raf = requestAnimationFrame(run);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{fmt(v, decimals)}{value != null && suffix}</>;
}

function Bars({bars}) {
  const max = Math.max(...bars.map(b => b.v || 0), 1e-6);
  return <div className="bars" aria-hidden="true">{bars.map((b, i) => <i key={i} className={b.on ? 'on' : ''} title={b.label} style={{'--h': Math.max(.06, (b.v || 0) / max), animationDelay: 120 + i * 28 + 'ms'}}/>)}</div>;
}

function Metric({label, en, value, decimals = 1, suffix = '%', level, delta, deltaEn, bars}) {
  return <section className="an-metric">
    <header><span>{label} <em>{en}</em></span>{level && <b className={`lvl lvl-${level[2]}`}>{level[0]} <em>{level[1]}</em></b>}</header>
    <div className="an-metric-body">
      <strong><Count value={value} decimals={decimals} suffix={suffix}/></strong>
      {delta && <small className={delta.startsWith('-') ? 'down' : 'up'}>{delta}<em>{deltaEn}</em></small>}
      <Bars bars={bars}/>
    </div>
  </section>;
}

function Tiles({tiles}) {
  return <div className="an-tiles">{tiles.map(([icon, v, zh, en, d], i) => <div className="an-tile" key={zh} style={{animationDelay: 200 + i * 70 + 'ms'}}>
    <span className="t-icon"><Icon name={icon} size={16}/></span>
    <strong>{typeof v === 'number' ? <Count value={v} decimals={d || 0}/> : v}</strong>
    <p>{zh}<em>{en}</em></p>
  </div>)}</div>;
}

function Chip({graph, id, onGo, sub}) {
  const n = graph.index.get(id);
  if (!n) return null;
  const go = CONTENT.has(n.kind) || n.kind === 'concept';
  const body = <>{n.short || n.title}{sub && <small>{sub}</small>}</>;
  return go ? <button className="chip" style={{'--kc': KINDS[n.kind].color}} onClick={() => onGo(id)}>{body}</button>
    : <span className={`chip static ${n.kind === 'ghost' ? 'ghost' : ''}`} style={{'--kc': KINDS[n.kind].color}}>{body}</span>;
}

function Links({graph, node, onGo}) {
  const nb = useMemo(() => neighbors(graph, node.id), [graph, node.id]);
  const lat = useMemo(() => latent(graph, node.id).slice(0, 6), [graph, node.id]);
  const groups = [
    ['双向', 'Mutual', '⇄', nb.mutual.sort((a, b) => b.link.w - a.link.w), l => l.link.kind === 'resonance' ? `${l.link.w} 概念` : LINK_KINDS[l.link.kind]],
    ['出链', 'Outgoing', '→', nb.out, l => LINK_EN[l.link.kind]],
    ['反链', 'Backlinks', '←', nb.back, l => LINK_EN[l.link.kind]],
    ['二度关联', 'Latent', '⋯', lat, l => 'via ' + l.via.slice(0, 2).join('、')]
  ].filter(g => g[3].length);
  return <section className="an-section">
    <h3>双向链接 <em>Bidirectional links</em></h3>
    {groups.map(([zh, en, arrow, list, sub]) => <div className="link-group" key={zh}>
      <p><i>{arrow}</i>{zh} <em>{en}</em><b>{list.length}</b></p>
      <div className="chip-row">{list.slice(0, 14).map(l => <Chip key={l.id} graph={graph} id={l.id} onGo={onGo} sub={sub(l)}/>)}{list.length > 14 && <span className="chip static more">+{list.length - 14}</span>}</div>
    </div>)}
  </section>;
}

function Insights({items}) {
  if (!items.length) return null;
  return <section className="an-section">
    <h3><Icon name="spark" size={14}/>图谱分析 <em>Graph insights</em></h3>
    {items.map(([title, en, text, tone], i) => <article key={i} className={`insight tone-${tone || 'info'}`} style={{animationDelay: 380 + i * 90 + 'ms'}}>
      <h4>{title} <em>{en}</em></h4><p>{text}</p>
    </article>)}
  </section>;
}

// AI 区块：方法笔记与个人知识库（网页剪藏）显示。
// note：打标签 + 摘要写回 frontmatter；语义边刷新后重算。
// personal：调 /api/knowledge/analyze 重跑网页分析（摘要 + 要点 + 标签）。
function AiPanel({graph, node, onGo, onToast, aiEnabled, embedEnabled: embedOn}) {
  // aiEnabled 由调用方传入（App 拉取 /api/ai/info 的单一事实源，配置保存后即时刷新）；
  // 不再读 store.data.ai——那份数据在设置保存后不会自动更新。
  const isPersonal = node.kind === 'personal';
  const rel = getFiles()?.[isPersonal ? 'personal:' + node.id.replace(/^personal:/, '') : 'note:' + node.id] || null;
  if (!isLive() || !aiEnabled || (isPersonal ? !rel : false)) return null;
  const [state, setState] = useState({busy: false, msg: '', tags: null, summary: null, related: null});
  const run = (fn, okMsg) => async () => {
    setState(s => ({...s, busy: true, msg: ''}));
    try { const r = await fn(); setState(s => ({...s, busy: false, ...r, msg: okMsg})); onToast?.(okMsg); }
    catch (e) { setState(s => ({...s, busy: false, msg: '失败：' + e.message})); }
  };
  return <section className="an-section ai-panel">
    <h3><Icon name="agent" size={14}/>AI 分析 <em>AI insights</em></h3>
    {isPersonal && <div className="chip-row">
      <button className="pill ghost" disabled={state.busy} onClick={run(async () => {
        const res = await fetch(apiUrl('/api/knowledge/analyze'), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({id: node.id})});
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status);
        await refreshData();
        return {summary: j.analysis?.summary, tags: j.analysis?.tags};
      }, '网页分析已写回笔记')}>重新分析网页 <em>Re-analyze</em></button>
    </div>}
    {!isPersonal && <div className="chip-row">
      <button className="pill ghost" disabled={state.busy} onClick={run(async () => {
        // 打标签 + 摘要，写回 frontmatter（tags / summary 键）
        const dry = await aiAnalyze([rel], true);
        if (!dry.todo) return {msg: '这篇已经分析过了'};
        const job = await aiAnalyze([rel]);
        const r = await pollJob(job.job.id);
        const one = r.result?.find(x => x.id === 'note:' + node.id);
        return one ? {tags: one.tags, summary: one.summary} : {};
      }, '标签与摘要已写入笔记')}>打标签 + 摘要 <em>Tag &amp; summarize</em></button>
      {embedOn && <button className="pill ghost" disabled={state.busy} onClick={run(async () => {
        const job = await aiRelate();
        const r = await pollJob(job.job.id);
        const edges = r.result?.edges || [];
        // 写入运行时仓：主图谱立即重建，语义边不用刷新页面才出现。
        setSemantic(edges);
        // 语义边已覆盖全部内容类型：node.id 就是图谱完整 id（post:/note:/idea:/draft:/personal:）
        const mine = edges.filter(e => e.a === node.id || e.b === node.id);
        return {related: mine.map(e => ({id: e.a === node.id ? e.b : e.a, sim: e.sim}))};
      }, '语义关联已更新')}>语义关联 <em>Semantic links</em></button>}
      <button className="pill ghost" disabled={state.busy} onClick={run(async () => {
        const r = await aiIdeas([rel]);
        return {msg: r.candidates?.length ? '候选选题：' + r.candidates.map(c => c.title).join('；') : '没有生成候选'};
      }, '选题候选已生成')}>生成选题 <em>Seed ideas</em></button>
    </div>}
    {state.busy && <p className="quiet">AI 正在处理…</p>}
    {state.msg && <p className="quiet">{state.msg}</p>}
    {state.summary && <p className="ai-summary">{state.summary}</p>}
    {state.tags && <div className="chip-row">{state.tags.map(t => <span key={t} className="chip static" style={{'--kc': KINDS.tag.color}}>#{t}</span>)}</div>}
    {state.related?.length > 0 && <div className="chip-row">{state.related.map(x => <Chip key={x.id} graph={graph} id={x.id} onGo={onGo} sub={'相似 ' + x.sim}/>)}</div>}
  </section>;
}

function ModelPicker({models, value, onChange}) {
  if (!models.length) return null; // 拉不到列表就隐藏，请求仍用服务端默认模型
  return <select className="model-picker" value={value || ''} onChange={e => onChange(e.target.value || null)}
    aria-label="选择 AI 模型" title="本次会话使用的 AI 模型">
    <option value="">默认模型</option>
    {models.map(m => <option key={m.id} value={m.id}>{m.name}{m.reasoning ? '（思考型）' : ''}</option>)}
  </select>;
}

function AskBox({graph, node, onGo, aiEnabled}) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState([]);
  const [model, setModel] = useState(pickedModel());
  const ai = isLive() && !!aiEnabled;
  // 只在第一次挂 AI 时拉一次模型列表
  useEffect(() => { if (ai) aiModels().then(setModels); }, [ai]);
  const choose = id => { setModel(id); setPickedModel(id); };
  const submit = async e => {
    e.preventDefault();
    if (!q.trim() || busy) return;
    setBusy(true);
    // NAS + 配了 AI：走 RAG（带引用）；否则用本地规则检索（不联网）
    if (ai) {
      try {
        const r = await fetch(apiUrl('/api/ai/ask'), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({question: q})});
        const j = await r.json();
        setRes([{title: 'AI 回答', en: 'AI answer', tone: 'info', text: j.answer || '（空）', refs: j.refs || []}]);
      } catch (e2) {
        setRes([{title: 'AI 暂时不可用，本地检索结果', en: 'AI offline, local results', tone: 'warn', text: '', items: [], local: askGraph(graph, q, node.id)}]);
      }
    } else {
      setRes(askGraph(graph, q, node.id).map(c => ({...c, local: true})));
    }
    setBusy(false);
  };
  return <div className="an-ask">
    {res && <div className="an-ask-res">{res.map((c, i) => <div key={i} className={`ask-card mini tone-${c.tone}`}>
      <h4>{c.title} <em>{c.en}</em>{c.local && <small> · 本地 local</small>}</h4>
      {c.text && <p>{c.text}</p>}
      {c.refs?.length > 0 && <div className="chip-row">{c.refs.map(rf => <Chip key={rf.id} graph={graph} id={rf.id} onGo={onGo}/>)}</div>}
      {c.items?.length > 0 && <div className="chip-row">{c.items.slice(0, 6).map(id => <Chip key={id} graph={graph} id={id} onGo={onGo}/>)}</div>}
      {c.local?.map((lc, k) => <div key={k} className="local-card">
        <h5>{lc.title} <em>{lc.en}</em></h5><p>{lc.text}</p>
        {lc.items?.length > 0 && <div className="chip-row">{lc.items.slice(0, 6).map(id => <Chip key={id} graph={graph} id={id} onGo={onGo}/>)}</div>}
      </div>)}
    </div>)}</div>}
    <form onSubmit={submit}>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder={ai ? '问你的笔记库… Ask your notes (AI)' : '追问这条内容… Ask about this note'} aria-label="提问"/>
      <button aria-label="提交" disabled={busy}>{busy ? '…' : <Icon name="send" size={15}/>}</button>
    </form>
    {ai && <div className="an-ask-model"><ModelPicker models={models} value={model} onChange={choose}/></div>}
    <div className="an-ask-foot"><span><Icon name="agent" size={13}/>{ai ? 'AI 问答' : '我的图谱'} <em>{ai ? 'AI Q&A' : 'My graph'}</em></span><span><Icon name="spark" size={13}/>{ai ? 'RAG + 引用' : '本地分析'} <em>{ai ? 'with citations' : 'Local analysis'}</em></span></div>
  </div>;
}

function pollJob(id, tries = 120) {
  const tick = () => fetch(apiUrl('/api/ai/jobs/' + id)).then(r => r.json());
  return (async () => {
    for (let i = 0; i < tries; i++) {
      const j = await tick();
      if (j.status === 'done') return j;
      if (j.status === 'error') throw new Error(j.error || '任务失败');
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('任务超时');
  })();
}

const sharedConcepts = (a, b) => (a.shared || []).filter(x => (b.shared || []).includes(x));

function analyze(graph, node) {
  const C = graph.nodes.filter(n => CONTENT.has(n.kind));
  const nb = neighbors(graph, node.id);
  const d = {out: node.out - node.mutual, back: node.in - node.mutual, both: node.mutual};
  const top = [...nb.mutual].sort((a, b) => b.link.w - a.link.w)[0];
  const partner = top && graph.index.get(top.id);
  const resonance = partner ? [['双向共振最强', 'Strongest resonance', `与「${partner.short || partner.title}」互相呼应，共同提及：${sharedConcepts(node, partner).join('、') || LINK_KINDS[top.link.kind]}。`, 'gold']] : [];
  const connectivity = () => {
    const pct = 100 * C.filter(c => c.deg <= node.deg).length / C.length;
    const avg = C.reduce((s, c) => s + c.deg, 0) / C.length;
    const diff = node.deg - avg;
    return {label: '连接度', en: 'Connectivity', value: pct, decimals: 0, level: pct >= 80 ? ['枢纽', 'Hub', 'high'] : pct >= 50 ? ['活跃', 'Active', 'mid'] : ['边缘', 'Edge', 'low'],
      delta: `${diff >= 0 ? '+' : ''}${diff.toFixed(1)} 条`, deltaEn: diff >= 0 ? 'above average' : 'below average',
      bars: [...C].sort((a, b) => a.deg - b.deg).map(c => ({v: c.deg, on: c.id === node.id, label: c.short}))};
  };

  if (node.kind === 'post') {
    const P = C.filter(n => n.kind === 'post').sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const p = node.post, rate = x => x.post.views ? x.post.saves / x.post.views * 100 : null;
    const r = rate(node), others = P.filter(x => x !== node).map(rate).filter(x => x != null);
    const avg = others.reduce((s, x) => s + x, 0) / (others.length || 1);
    const rank = [...P].sort((a, b) => b.post.views - a.post.views).indexOf(node) + 1;
    const engage = p.views ? (p.likes + p.comments + p.saves + p.shares) / p.views * 100 : null;
    const ideas = latent(graph, node.id).filter(x => graph.index.get(x.id).kind === 'idea');
    const fromDraft = [...nb.out, ...nb.back, ...nb.mutual].filter(x => graph.index.get(x.id).kind === 'draft').map(x => graph.index.get(x.id));
    return {
      badge: p.platform ? [`已发布 · ${p.platform}`, p.url ? 'Published · linked' : 'Published'] : ['已发布', 'Published'],
      status: `首发 First published ${p.date} · ${node.tags.length} 个话题 topics`,
      action: ['查看作品', 'Open in Works', {type: 'page', page: 'library', id: p.id}],
      action2: p.url ? ['打开原文', 'Open post', {type: 'url', url: p.url}] : null,
      metric: {label: '收藏率', en: 'Save rate', value: r, level: r >= 6 ? ['高', 'High', 'high'] : r >= 3 ? ['中', 'Moderate', 'mid'] : ['低', 'Low', 'low'],
        delta: `${r - avg >= 0 ? '+' : ''}${(r - avg).toFixed(1)}%`, deltaEn: 'vs. other works', bars: P.map(x => ({v: rate(x), on: x === node, label: x.short}))},
      tiles: [['eye', p.views, '观看', 'Views'], ['save', p.saves, '收藏', 'Saves'], ['user', p.follows ?? '—', '涨粉', 'Follows'], ['link', d.both, '双向共振', 'Mutual']],
      all: [['曝光', 'Impressions', fmt(p.impressions)], ['封面点击率', 'CTR', p.ctr == null ? '—' : p.ctr + '%'], ['平均观看', 'Avg. watch', p.duration == null ? '—' : p.duration + 's'], ['点赞', 'Likes', fmt(p.likes)], ['评论', 'Comments', fmt(p.comments)], ['分享', 'Shares', fmt(p.shares)], ['互动率', 'Engagement', engage == null ? '—' : engage.toFixed(1) + '%'], ['涨粉转化', 'Follow rate', p.follows == null || !p.views ? '—' : (p.follows / p.views * 1000).toFixed(1) + '‰']],
      insights: [
        ['表现排名', 'Ranking', `观看第 ${rank}/${P.length} 名；收藏率${r >= avg ? '高于' : '低于'}其他作品均值 ${Math.abs(r - avg).toFixed(1)} 个百分点。`, r >= avg ? 'gold' : 'info'],
        ...(p.platform ? [['发布来源', 'Source', `${p.platform}${p.url ? ' · ' + String(p.url).replace(/^https?:\/\/(www\.)?/, '').slice(0, 48) : ''}${p.syncedAt ? `（指标 ${p.syncedAt}）` : ''}`, p.url ? 'gold' : 'info']] : []),
        ...(fromDraft.length ? [['来自草稿', 'From draft', `同名草稿「${fromDraft.slice(0, 3).map(x => x.short || x.title).join('、')}」已进入作品库。`, 'gold']] : []),
        ...resonance,
        ...(ideas.length ? [['可延伸选题', 'Next ideas', ideas.slice(0, 2).map(x => `「${graph.index.get(x.id).short}」（共享：${x.via.join('、')}）`).join('；'), 'info']] : []),
        ...(p.updated ? [['数据时点', 'Snapshot', p.updated, 'muted']] : [['数据时点', 'Snapshot', '读取时累计值，缺失项保留为「—」。', 'muted']])
      ]
    };
  }
  if (node.kind === 'note') {
    const ghosts = nb.out.filter(x => graph.index.get(x.id).kind === 'ghost');
    return {
      badge: ['知识笔记', 'Knowledge note'], status: node.path,
      action: ['阅读全文', 'Read note', {type: 'read', id: node.id}],
      metric: connectivity(),
      tiles: [['outlink', d.out, '出链', 'Outgoing'], ['back', d.back, '反链', 'Backlinks'], ['link', d.both, '双向共振', 'Mutual'], ['file', (node.body || '').length, '字数', 'Chars']],
      insights: [...resonance,
        ...(ghosts.length ? [['未创建的双链', 'Unresolved links', `${ghosts.length} 个 [[双链]] 指向尚未出现的笔记：${ghosts.slice(0, 3).map(x => graph.index.get(x.id).short).join('、')}${ghosts.length > 3 ? ' 等' : ''}。`, 'warn']] : []),
        ['提及概念', 'Concepts', node.shared.length ? node.shared.join('、') : '正文没有命中概念词。', 'info']]
    };
  }
  if (node.kind === 'idea') {
    const I = C.filter(n => n.kind === 'idea');
    const reach = x => 100 * latent(graph, x.id).length / Math.max(1, C.length - 1);
    const lat = latent(graph, node.id);
    const posts = lat.filter(x => graph.index.get(x.id).kind === 'post');
    const notes = lat.filter(x => graph.index.get(x.id).kind === 'note').length + nb.mutual.filter(x => graph.index.get(x.id).kind === 'note').length;
    const hasDraft = [...nb.out, ...nb.back, ...nb.mutual].some(x => graph.index.get(x.id).kind === 'draft');
    const news = [...nb.out, ...nb.back, ...nb.mutual].filter(x => graph.index.get(x.id).kind === 'news').map(x => graph.index.get(x.id));
    return {
      badge: [`优先级 ${node.idea.priority}`, 'Priority'], status: `${node.idea.status} · ${node.idea.platform}`,
      action: hasDraft ? ['打开草稿', 'Open draft', {type: 'ideaToDraft', idea: node.idea}] : ['转为草稿', 'To draft', {type: 'ideaToDraft', idea: node.idea}],
      action2: ['编辑选题', 'Edit', {type: 'editIdea', idea: node.idea}],
      metric: {label: '延伸潜力', en: 'Reach', value: reach(node), decimals: 0, level: posts.length >= 2 ? ['强', 'Strong', 'high'] : posts.length ? ['中', 'Fair', 'mid'] : ['弱', 'Weak', 'low'],
        delta: `${posts.length} 篇作品`, deltaEn: 'related works', bars: I.map(x => ({v: reach(x), on: x === node, label: x.short}))},
      tiles: [['concept', node.shared.length, '提及概念', 'Concepts'], ['works', posts.length, '关联作品', 'Works'], ['methods', notes, '关联笔记', 'Notes'], ['draft', hasDraft ? 1 : 0, '草稿', 'Drafts']],
      insights: [
        ['创作备注', 'Brief', node.idea.note || '还没有备注。', 'info'],
        ...(news.length ? [['热点依据', 'News source', news.map(x => `「${x.short || x.title}」`).join('、'), 'gold']] : []),
        ...(posts.length ? [['可以延伸的作品', 'Builds on', posts.slice(0, 3).map(x => `「${graph.index.get(x.id).short}」`).join('、') + ` · 共享：${[...new Set(posts.flatMap(x => x.via))].join('、')}`, 'gold']] : []),
        ...resonance
      ]
    };
  }
  if (node.kind === 'draft') {
    const src = [...nb.out, ...nb.mutual].find(x => graph.index.get(x.id).kind === 'idea');
    const published = [...nb.out, ...nb.back, ...nb.mutual].filter(x => graph.index.get(x.id).kind === 'post').map(x => graph.index.get(x.id));
    return {
      badge: ['正在写', 'Writing'], status: src ? `来自选题「${graph.index.get(src.id).short}」` : published.length ? `已发布为「${published[0].short || published[0].title}」` : '独立草稿 · Standalone',
      action: ['继续写作', 'Continue', {type: 'page', page: 'drafts', id: node.draft.id}],
      action2: ['发布此稿', 'Publish', {type: 'publish', draftId: node.draft.id}],
      metric: connectivity(),
      tiles: [['file', (node.body || '').length, '字数', 'Chars'], ['idea', src ? 1 : 0, '来源选题', 'Source'], ['concept', node.shared.length, '提及概念', 'Concepts'], ['link', graph.links.filter(l => l.kind === 'wiki' && l.s === node.id).length, '双链', 'Wikilinks']],
      insights: [
        ...(published.length ? [['已发布作品', 'Published', published.map(x => `「${x.short || x.title}」`).join('、'), 'gold']] : []),
        ...resonance,
        ['提及概念', 'Concepts', node.shared.length ? node.shared.join('、') : '正文还没有命中概念词，可以在创作台用 [[ ]] 链接笔记。', 'info']
      ]
    };
  }
  // news（AI 热点日报）：按内容型节点的通用面板展示
  if (node.kind === 'news') {
    const seeded = nb.back.filter(x => graph.index.get(x.id).kind === 'idea').map(x => graph.index.get(x.id));
    return {
      badge: ['AI 热点', 'AI news'], status: node.path,
      action: ['阅读日报', 'Read digest', {type: 'read', id: node.id}],
      metric: connectivity(),
      tiles: [['outlink', d.out, '出链', 'Outgoing'], ['back', d.back, '反链', 'Backlinks'], ['link', d.both, '双向共振', 'Mutual'], ['file', (node.body || '').length, '字数', 'Chars']],
      insights: [
        ...(seeded.length ? [['已转化为选题', 'Ideas seeded', `${seeded.length} 个选题引用了这份日报：${seeded.slice(0, 3).map(x => `「${x.short || x.title}」`).join('、')}。`, 'gold']] : []),
        ...resonance,
        ['关于这份数据', 'About', '每天由 AI 从公开 AI 动态 RSS 汇总生成，存在偏差可能，引用前请核对原文。', 'info']
      ]
    };
  }
  // personal（个人知识库：灵感 / 制度 / 推文剪藏）
  if (node.kind === 'personal') {
    const p = node.personal || {};
    const isClip = !!p.url;
    const linkedIdeas = [...nb.back, ...nb.mutual, ...nb.out].filter(x => graph.index.get(x.id).kind === 'idea').map(x => graph.index.get(x.id));
    const linkedDrafts = [...nb.back, ...nb.mutual, ...nb.out].filter(x => graph.index.get(x.id).kind === 'draft').map(x => graph.index.get(x.id));
    return {
      badge: [p.category || '个人收藏', p.category === '推文' ? 'Web clip' : p.category === '制度' ? 'Policy' : 'Spark'], status: `${p.domain || (isClip ? '网页剪藏' : '本地笔记')}${p.author ? ' · @' + p.author : ''} · ${node.path}`,
      action: isClip ? ['打开原网页', 'Open source', {type: 'url', url: p.url}] : ['阅读全文', 'Read note', {type: 'read', id: node.id}],
      action2: isClip && p.snapshot ? ['查看快照', 'Snapshot', {type: 'snapshot', path: p.snapshot}] : null,
      metric: connectivity(),
      tiles: [['outlink', d.out, '出链', 'Outgoing'], ['back', d.back, '反链', 'Backlinks'], ['link', d.both, '双向共振', 'Mutual'], ['file', (node.body || '').length, '字数', 'Chars']],
      insights: [
        ...(p.summary ? [['AI 摘要', 'AI summary', p.summary, 'gold']] : []),
        ...((p.keyPoints || []).length ? [['要点', 'Key points', p.keyPoints.slice(0, 4).join('；'), 'info']] : []),
        ...(linkedIdeas.length ? [['已转为选题', 'Seeded ideas', linkedIdeas.map(x => `「${x.short || x.title}」`).join('、'), 'gold']] : []),
        ...(linkedDrafts.length ? [['已用于草稿', 'Used in drafts', linkedDrafts.map(x => `「${x.short || x.title}」`).join('、'), 'gold']] : []),
        ...resonance,
        ...(isClip ? [['关于这条剪藏', 'About', '网页由服务端抓取并保存快照；AI 摘要可能存在偏差，引用前请核对原文。', 'muted']] : [])
      ]
    };
  }
  // concept：概念按分区各有一份（同名两条），面板里按名字合并报数
  const groups = new Map();
  for (const n of graph.nodes) if (n.kind === 'concept') {
    const g = groups.get(n.title) || {title: n.title, in: 0, ids: []};
    g.in += n.in; g.ids.push(n.id); groups.set(n.title, g);
  }
  const K = [...groups.values()];
  const who = nb.back.map(x => graph.index.get(x.id));
  const count = k => who.filter(n => n.kind === k).length;
  const ids = new Set(who.map(n => n.id));
  const inner = graph.links.filter(l => l.kind === 'resonance' && ids.has(l.a) && ids.has(l.b)).length;
  const co = K.filter(k => !k.ids.includes(node.id)).map(k => [k, graph.links.filter(l => l.kind === 'mention' && k.ids.includes(l.t) && ids.has(l.s)).length]).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return {
    badge: ['概念', 'Concept'], status: `被 ${who.length} 条内容提及 · mentioned by ${who.length}`,
    metric: {label: '覆盖率', en: 'Coverage', value: 100 * who.length / C.length, decimals: 0, level: who.length >= 5 ? ['核心', 'Core', 'high'] : who.length >= 3 ? ['常用', 'Common', 'mid'] : ['少见', 'Rare', 'low'],
      delta: `${who.length}/${C.length}`, deltaEn: 'notes', bars: [...K].sort((a, b) => a.in - b.in).map(k => ({v: k.in, on: k.ids.includes(node.id), label: k.title}))},
    tiles: [['works', count('post'), '作品', 'Works'], ['methods', count('note'), '知识笔记', 'Notes'], ['idea', count('idea'), '选题', 'Ideas'], ['draft', count('draft'), '草稿', 'Drafts']],
    insights: [
      ['邻域共振', 'Inner resonance', `提及「${node.title}」的内容之间形成 ${inner} 组双向共振。`, inner ? 'gold' : 'info'],
      ['常一起出现', 'Co-occurs with', co.filter(x => x[1]).map(([k, n]) => `${k.title}（${n}）`).join('、') || '暂无', 'info']
    ]
  };
}

// 环系剖面（星系仪）：读数不是装饰 —— 曲线就是主视图里那几圈环带的径向密度，
// 由 profileFor() 用**同一个函数**算出来，所以面板上读到的「作品 29 / 知识 82」和画面上的环带宽度是同一份数据。
function Transect({graph}) {
  const t = useMemo(() => profileFor(bandsOf(graph), outerCountOf(graph), 120), [graph]);
  const W = 300, H = 44, x0 = 10, x1 = W - 10, span = t.r1 - t.r0;
  const XR = r => x0 + (x1 - x0) * (r - t.r0) / span;
  const Y = d => H - 2 - Math.min(1, d) * (H - 7);
  const area = t.samples.map((v, i) => `${i ? 'L' : 'M'}${(x0 + (x1 - x0) * i / (t.samples.length - 1)).toFixed(1)},${Y(v).toFixed(1)}`).join(' ') + ` L${x1},${H - 1} L${x0},${H - 1} Z`;
  return <section className="an-transect" aria-label="环系剖面">
    <header><span>环系剖面 <em>Ring transect</em></span><small>环带宽度 = 节点数 <em>band width = count</em></small></header>
    <svg viewBox={`0 0 ${W} ${H + 24}`} role="img" aria-label="四圈环带的径向密度剖面">
      <defs><linearGradient id="tr-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#fff2cd" stopOpacity=".34"/><stop offset="1" stopColor="#b98f3c" stopOpacity=".04"/>
      </linearGradient></defs>
      <path d={area} fill="url(#tr-fill)" stroke="#fff2cd" strokeOpacity=".66" strokeWidth="1"/>
      <line x1={x0} y1={H - 1} x2={x1} y2={H - 1} stroke="#e8c884" strokeOpacity=".22"/>
      {/* 每个环带的引线 + 读数，落在它自己的环带上（窄带错行，避免叠字） */}
      {t.bands.map((b, i) => {
        const c = XR((b.r0 + b.r1) / 2), edge = XR(b.r1), dy = i % 2 ? 11 : 0;
        return <g key={b.id}>
          <line x1={edge.toFixed(1)} y1={H - 1} x2={edge.toFixed(1)} y2={H + 2 + dy} stroke="#e8c884" strokeOpacity=".16"/>
          <text x={c.toFixed(1)} y={H + 12 + dy} className="tr-n">{b.n}</text>
          <text x={c.toFixed(1)} y={H + 21 + dy} className="tr-l">{b.label}</text>
        </g>;
      })}
      <text x={x0} y={9} className="tr-end">核侧 Nucleus</text>
      <text x={x1} y={9} className="tr-end" textAnchor="end">外缘 {outerCountOf(graph)} 颗尘 · Rim</text>
    </svg>
  </section>;
}

// 作品指标手动补填：平台数据接口个人号拿不到（仅公众号可自动拉），这里手动写回 frontmatter。
function MetricsEditor({node}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [values, setValues] = useState(() => Object.fromEntries(['views', 'likes', 'comments', 'saves', 'shares', 'follows', 'impressions', 'ctr', 'duration'].map(k => [k, node.post[k] ?? ''])));
  if (!isLive() || !getFiles()?.['post:' + node.post.id]) return null;
  const fields = [['views', '观看', 'Views'], ['likes', '点赞', 'Likes'], ['comments', '评论', 'Comments'], ['saves', '收藏', 'Saves'], ['shares', '分享', 'Shares'], ['follows', '涨粉', 'Follows'], ['impressions', '曝光', 'Impr.'], ['ctr', '点击率%', 'CTR'], ['duration', '时长s', 'Dur.']];
  const save = async () => {
    setBusy(true); setMsg('');
    try {
      // 先拉原文拿 mtime 做乐观锁；正文不动，只写 frontmatter
      const rel = getFiles()['post:' + node.post.id];
      const cur = await fetch(apiUrl('/api/note?path=' + encodeURIComponent(rel))).then(r => r.json());
      const fm = {syncedAt: `手动 ${new Date().toISOString().slice(0, 10)}`};
      for (const [k] of fields) {
        const v = String(values[k]).trim();
        if (v === '') continue;
        const n = Number(v.replace(/[,，%]/g, ''));
        if (isNaN(n)) { setMsg(`「${k}」不是数字，已跳过`); continue; }
        fm[k] = n;
      }
      const res = await fetch(apiUrl('/api/note'), {
        method: 'PUT', headers: {'content-type': 'application/json'},
        body: JSON.stringify({path: rel, fm, mtime: cur.mtime})
      });
      if (res.status === 409) { setMsg('文件已被其他编辑器改动，未覆盖 · Conflict'); setBusy(false); return; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      setMsg('已写入，刷新数据…');
      setTimeout(() => location.reload(), 800);
    } catch (e) { setMsg('保存失败：' + e.message); setBusy(false); }
  };
  return <section className="an-section metrics-edit">
    <h3><Icon name="save" size={14}/>平台指标 <em>Platform metrics</em></h3>
    {!open
      ? <button className="pill ghost" onClick={() => setOpen(true)}><Icon name="user" size={13}/>补填指标 <em>Edit metrics</em></button>
      : <div className="me-grid">
          {fields.map(([k, zh, en]) => <label key={k}>{zh} <em>{en}</em>
            <input value={values[k] ?? ''} onChange={e => setValues(v => ({...v, [k]: e.target.value}))} inputMode="decimal" aria-label={zh}/>
          </label>)}
          <div className="form-actions">
            <button className="pill ghost" onClick={() => { setOpen(false); setMsg(''); }} disabled={busy}>取消 <em>Cancel</em></button>
            <button className="pill primary" onClick={save} disabled={busy}>{busy ? '保存中…' : '写回笔记' } <em>Save</em></button>
          </div>
          {msg && <p className="quiet" role="status">{msg}</p>}
        </div>}
  </section>;
}

export function Analysis({graph, node, module, onGo, onAction, onClose, aiEnabled, embedEnabled}) {
  const a = useMemo(() => analyze(graph, node), [graph, node]);
  const color = KINDS[node.kind].color;
  return <div className="analysis glass" style={{'--kc': color}} role="region" aria-label={`${node.title} 的分析`}>
    <div className="an-instrument" aria-hidden="true"/>
    <p className="an-float">分析概览 <em>Analysis overview</em> · {module?.title} {module?.en}</p>
    <div className="an-scroll">
      {module && <Transect graph={graph}/>}
      <header className="an-head">
        <span className="an-cat"><span className="an-cat-icon"><Icon name={module?.icon || 'file'} size={15}/></span>{module?.title}<em>{module?.en}</em></span>
        <button className="icon-btn" onClick={onClose} aria-label="关闭分析"><Icon name="close" size={15}/></button>
      </header>
      <div className="an-title-row">
        <div>
          <h2>{node.short || node.title}</h2>
          {node.short && node.short !== node.title && <p className="an-full">{node.title}</p>}
        </div>
        {node.cover && <img className="an-cover" src={node.cover} alt=""/>}
      </div>
      <div className="an-status">
        <span className="badge">{a.badge[0]} <em>{a.badge[1]}</em></span>
        <p>{a.status}</p>
        <div className="an-actions">
          {a.action2 && <button className="an-explore ghost" onClick={() => onAction(a.action2[2])}>{a.action2[0]} <em>{a.action2[1]}</em></button>}
          {a.action && <button className="an-explore" onClick={() => onAction(a.action[2])}>{a.action[0]} <em>{a.action[1]}</em><Icon name="chevron" size={13}/></button>}
        </div>
      </div>
      <Metric {...a.metric}/>
      <Tiles tiles={a.tiles}/>
      {a.all && <section className="an-section"><h3>全部指标 <em>All metrics</em></h3><div className="an-all">{a.all.map(([zh, en, v]) => <div key={zh}><span>{zh}<em>{en}</em></span><b>{v}</b></div>)}</div></section>}
      <Insights items={a.insights}/>
      {node.tags?.length > 0 && <section className="an-section"><h3>话题标签 <em>Topics</em></h3><div className="chip-row">{node.tags.map(t => <span key={t} className="chip static" style={{'--kc': KINDS.tag.color}}>#{t}</span>)}</div></section>}
      {node.kind === 'post' && <MetricsEditor node={node}/>}
      {(node.kind === 'note' || node.kind === 'personal') && <AiPanel graph={graph} node={node} onGo={onGo} aiEnabled={aiEnabled} embedEnabled={embedEnabled}/>}
      <Links graph={graph} node={node} onGo={onGo}/>
    </div>
    <AskBox graph={graph} node={node} onGo={onGo} aiEnabled={aiEnabled}/>
  </div>;
}
