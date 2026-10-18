import React, {useEffect, useRef, useState} from 'react';
import {askGraph} from './graph';
import {Icon} from './icons';
import {isLive} from '../data/store';
import {apiUrl, refreshData} from './persist';

// —— AI 助手（创作台 / 知识库右下角的浮动抽屉）——
// 两个能力：① 上传文件（md/txt/docx/pdf）提取文本存进个人知识库；② 对整个笔记库提问
// （部署模式 + 配了 AI key 走 /api/ai/ask 的 RAG 带引用；否则回退本地 askGraph 规则检索）。
const CATS = ['灵感', '制度', '推文'];

export function Assistant({graph, readOnly, showToast, defaultCategory = '制度', goNote, aiEnabled: aiProp}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('ask'); // ask | upload
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [thread, setThread] = useState([]); // {role:'q'|'a', text, refs?, local?}
  const [cat, setCat] = useState(defaultCategory);
  const [upBusy, setUpBusy] = useState(false);
  const [note, setNote] = useState('');
  // AI 启用状态单一事实源：由调用方（App）传入——设置面板保存后 onRefresh 已让它即时刷新，
  // 这里不再各自订阅 store（三份来源会各自陈旧）。
  const ai = isLive() && !!aiProp;
  const scrollRef = useRef(null);
  useEffect(() => { scrollRef.current?.scrollTo({top: 1e9}); }, [thread, open]);

  const ask = async e => {
    e.preventDefault();
    if (!q.trim() || busy) return;
    const question = q.trim();
    setQ(''); setBusy(true);
    setThread(t => [...t, {role: 'q', text: question}]);
    if (ai) {
      try {
        const res = await fetch(apiUrl('/api/ai/ask'), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({question})});
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status);
        setThread(t => [...t, {role: 'a', text: j.answer || '（空）', refs: j.refs || []}]);
      } catch (err) {
        setThread(t => [...t, {role: 'a', text: 'AI 暂时不可用，下面是本地检索结果。', local: askGraph(graph, question)}]);
      }
    } else {
      setThread(t => [...t, {role: 'a', text: '未连接 AI（需要部署模式并配置 AI_API_KEY），这是本地规则检索结果。', local: askGraph(graph, question)}]);
    }
    setBusy(false);
  };

  const upload = async files => {
    if (readOnly || !files?.length) return;
    setUpBusy(true); setNote('');
    for (const file of files) {
      try {
        const res = await fetch(apiUrl('/api/knowledge/upload'), {
          method: 'POST',
          headers: {'x-filename': encodeURIComponent(file.name), 'x-category': encodeURIComponent(cat), 'content-type': 'application/octet-stream'},
          body: file
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status);
        setNote(n => (n ? n + '\n' : '') + `✓ ${file.name} → ${j.path}（${j.chars} 字）`);
      } catch (err) {
        setNote(n => (n ? n + '\n' : '') + `✗ ${file.name}：${err.message}`);
      }
    }
    setUpBusy(false);
    await refreshData().catch(() => {});
    showToast?.('上传完成，已写入个人知识库');
  };

  return <>
    {!open && <button className="as-fab glass" onClick={() => setOpen(true)} aria-label="打开 AI 助手">
      <Icon name="agent" size={18}/><span>AI 助手</span>
    </button>}
    {open && <section className="as-drawer glass" role="dialog" aria-label="AI 助手">
      <header>
        <span className="as-title"><Icon name="agent" size={15}/>AI 助手 <em>Assistant</em></span>
        <div className="as-tabs">
          <button className={tab === 'ask' ? 'on' : ''} onClick={() => setTab('ask')}>提问 <em>Ask</em></button>
          <button className={tab === 'upload' ? 'on' : ''} onClick={() => setTab('upload')} disabled={readOnly}>上传 <em>Upload</em></button>
        </div>
        <button className="icon-btn" onClick={() => setOpen(false)} aria-label="关闭助手"><Icon name="close" size={15}/></button>
      </header>

      {tab === 'ask' && <>
        <div className="as-thread" ref={scrollRef}>
          {!thread.length && <p className="as-hint">{ai
            ? '问任何和笔记库有关的问题：制度、检查结果、灵感、剪藏都可以检索。'
            : '当前未启用 AI，本地规则检索中。到右上角 ⚙ 设置 → AI 配置里填接口地址与 Key，保存后这里自动切换为整库问答带引用。'}</p>}
          {thread.map((m, i) => m.role === 'q'
            ? <p key={i} className="as-q">{m.text}</p>
            : <div key={i} className="as-a">
                <p>{m.text}</p>
                {m.refs?.length > 0 && <div className="chip-row">{m.refs.slice(0, 6).map(rf => {
                  const n = rf.id && graph.index.get(rf.id);
                  return n
                    ? <button key={rf.id} className="chip" style={{'--kc': '#e8c884'}} onClick={() => goNote?.(rf.id)}>{rf.title || n.short || n.title}</button>
                    : <span key={rf.id} className="chip static">{rf.title}</span>;
                })}</div>}
                {m.local?.map((lc, k) => <div key={k} className="as-local">
                  <h5>{lc.title} <em>{lc.en}</em></h5><p>{lc.text}</p>
                  {lc.items?.length > 0 && <div className="chip-row">{lc.items.slice(0, 6).map(id => {
                    const n = graph.index.get(id);
                    return n ? <button key={id} className="chip" style={{'--kc': '#e8c884'}} onClick={() => goNote?.(id)}>{n.short || n.title}</button> : null;
                  })}</div>}
                </div>)}
              </div>)}
          {busy && <p className="as-busy">检索中…</p>}
        </div>
        <form className="as-ask" onSubmit={ask}>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="问你的笔记库…" aria-label="向 AI 助手提问"/>
          <button className="send" aria-label="发送" disabled={busy}>{busy ? '…' : <Icon name="send" size={15}/>}</button>
        </form>
      </>}

      {tab === 'upload' && <div className="as-upload">
        <p className="as-hint">支持 md / txt / docx / pdf（≤{Math.round(4)} MB），提取文本后存进个人知识库，自动进搜索与 AI 问答。</p>
        <div className="as-cats" role="group" aria-label="上传分类">
          {CATS.map(c => <button key={c} className={cat === c ? 'on' : ''} onClick={() => setCat(c)}>{c}</button>)}
        </div>
        <label className={`as-drop ${upBusy ? 'busy' : ''}`}>
          <input type="file" multiple accept=".md,.markdown,.txt,.docx,.pdf" disabled={readOnly || upBusy}
            onChange={e => { upload([...e.target.files]); e.target.value = ''; }}/>
          <Icon name="save" size={22}/>
          <span>{upBusy ? '解析并写入中…' : '点击选择文件，或拖拽到这里'}</span>
        </label>
        {note && <pre className="as-uplog">{note}</pre>}
      </div>}
    </section>}
  </>;
}
