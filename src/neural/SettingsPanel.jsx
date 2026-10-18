// 设置面板：右上角齿轮打开的弹窗内容。
//
// 板块：
//   AI     —— 服务端 AI 状态（只读展示）+ 默认模型选择（写 NAS settings.aiModel）
//   平台   —— 公众号凭据（写 settings.platforms.公众号，secret 只存不回显）+ 同步时间 + 立即同步
//   目标   —— 月目标（并入设置；首页的 goal 弹窗保留）
//
// 数据规矩（与 AGENTS.md 一致）：全部经 /api/settings 写 NAS 的 vault/.dashboard/settings.json，
// 浏览器不持久化；secret 永不回传前端（服务端 GET 时抹掉，只报 configured）。
import React, {useEffect, useState} from 'react';
import {Icon} from './icons';
import {aiModels} from './sync.js';
import {saveSettings, apiUrl, saveGoal} from './persist';

function useModels() {
  const [models, setModels] = useState([]);
  useEffect(() => {
    let on = true;
    aiModels().then(m => { if (on) setModels(m); }).catch(() => {});
    return () => { on = false; };
  }, []);
  return models;
}

function AiSection({ai, model, onModel, readOnly}) {
  const models = useModels();
  return <section className="set-section" aria-label="AI 配置">
    <h3><Icon name="agent" size={14}/>AI <em>AI</em></h3>
    {ai?.enabled
      ? <p className="quiet">已启用 · 协议 {ai.protocol} · 服务端默认模型 {ai.model}；key 只在服务端环境变量里 <em>Enabled · key stays server-side</em></p>
      : <p className="quiet">未启用：服务端未配 AI_API_KEY，问答与分析走本地规则 <em>Disabled — AI_API_KEY not set</em></p>}
    {ai?.enabled && <>
      <label>默认模型 <em>Default model</em>
        <select value={model || ''} onChange={e => onModel(e.target.value)} disabled={readOnly} aria-label="默认 AI 模型">
          <option value="">服务端默认模型</option>
          {models.map(m => <option key={m} value={m}>{m}</option>)}
          {model && !models.includes(model) && <option value={model}>{model}（当前）</option>}
        </select>
      </label>
      <p className="quiet">选择会写入 NAS 设置文件，问答 / 分析 / 选题请求都用它 <em>Saved to NAS settings</em></p>
    </>}
    {ai?.embed?.enabled && <p className="quiet">语义边：已启用 embedding（{ai.embed.model}） <em>Semantic edges on</em></p>}
  </section>;
}

function PlatformSection({settings, onSaved, readOnly}) {
  const wx = settings?.platforms?.公众号;
  const [appid, setAppid] = useState(wx?.appid || '');
  const [secret, setSecret] = useState('');
  const [syncHour, setSyncHour] = useState(settings?.syncHour ?? 21);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  // 设置刷新时把服务端状态同步进表单（secret 永远是空的，只显示占位提示）
  useEffect(() => {
    setAppid(wx?.appid || '');
    setSyncHour(settings?.syncHour ?? 21);
  }, [settings]);

  const save = async () => {
    setBusy(true); setMsg('');
    try {
      const patch = {platforms: {公众号: {appid: appid.trim(), secret: secret.trim()}}};
      if (Number(syncHour) !== (settings?.syncHour ?? 21)) patch.syncHour = Number(syncHour);
      const next = await saveSettings(patch);
      setSecret('');
      setMsg('已保存到 NAS 设置文件 · Saved to NAS settings');
      onSaved?.(next);
    } catch (e) { setMsg('保存失败：' + e.message); }
    finally { setBusy(false); }
  };

  const pullNow = async () => {
    setBusy(true); setMsg('');
    try {
      const res = await fetch(apiUrl('/api/platforms/pull'), {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'});
      const j = await res.json().catch(() => ({}));
      const results = j.results || [];
      const ok = results.filter(r => r.updated).length;
      setMsg(results.length
        ? `同步完成：${results.length} 篇带平台来源，${ok} 篇更新了指标`
        : '没有可同步的作品：发布回填过链接的才会自动拉取指标');
      onSaved?.();
    } catch (e) { setMsg('同步失败：' + e.message); }
    finally { setBusy(false); }
  };

  const configured = !!wx?.configured;
  return <section className="set-section" aria-label="发布平台">
    <h3><Icon name="send" size={14}/>发布平台 <em>Publish platforms</em></h3>
    <p className="quiet">公众号可自动回拉阅读数据；小红书 / 抖音 / B站个人号没有数据接口，指标在作品页手动补填 <em>WeChat OA auto-pulls; others manual</em></p>
    <div className="form-row">
      <label>公众号 AppID <em>AppID</em><input value={appid} onChange={e => setAppid(e.target.value)} placeholder="wx…" disabled={readOnly} aria-label="公众号 AppID"/></label>
      <label>Secret <em>Secret</em><input type="password" value={secret} onChange={e => setSecret(e.target.value)} placeholder={configured ? '已配置，留空不改动' : 'mp.weixin.qq.com 后台获取'} disabled={readOnly} aria-label="公众号 Secret"/></label>
    </div>
    <div className="form-row">
      <label>每日同步时间 <em>Daily sync hour</em>
        <select value={syncHour} onChange={e => setSyncHour(Number(e.target.value))} disabled={readOnly} aria-label="每日同步时间">
          {Array.from({length: 24}, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00 后</option>)}
        </select>
      </label>
      <div className="set-status">
        <span className={configured ? 'set-ok' : 'set-off'}>{configured ? '已配置 · Ready' : '未配置 · Not configured'}</span>
        <button type="button" className="pill ghost" onClick={pullNow} disabled={busy || readOnly}>立即同步 <em>Pull now</em></button>
      </div>
    </div>
    {msg && <p className="quiet" role="status">{msg}</p>}
    <div className="form-actions">
      <button className="pill primary" onClick={save} disabled={busy || readOnly || (!appid.trim() && !secret.trim())}>保存平台设置 <em>Save</em></button>
    </div>
    <p className="quiet">Secret 只写入 NAS（vault/.dashboard/settings.json），保存后不回显；服务端环境变量 WECHAT_APPID / WECHAT_SECRET 优先于这里的配置 <em>Stored on NAS, never echoed back</em></p>
  </section>;
}

function GoalSection({goal, monthCount, onGoal}) {
  const [v, setV] = useState(String(goal));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => setV(String(goal)), [goal]);

  const save = async () => {
    const n = Number(v);
    if (!(Number.isInteger(n) && n >= 1 && n <= 100)) { setMsg('目标必须是 1–100 的整数'); return; }
    setBusy(true); setMsg('');
    try {
      await onGoal(n);
      setMsg(`已保存：本月已发布 ${monthCount} 篇，目标 ${n} 篇 · Saved`);
    } catch (e) { setMsg('保存失败：' + e.message); }
    finally { setBusy(false); }
  };

  return <section className="set-section" aria-label="月目标">
    <h3><Icon name="save" size={14}/>月目标 <em>Monthly goal</em></h3>
    <div className="form-row">
      <label>目标篇数 <em>Target</em>
        <input type="number" min="1" max="100" step="1" value={v} onChange={e => setV(e.target.value)} disabled={busy} aria-label="目标篇数"/>
      </label>
      <div className="set-status"><span className="set-ok">本月已发布 {monthCount} 篇</span>
        <button type="button" className="pill primary" onClick={save} disabled={busy}>保存目标 <em>Save</em></button>
      </div>
    </div>
    {msg && <p className="quiet" role="status">{msg}</p>}
  </section>;
}

// 弹窗主体。settings 用 /api/settings 的脱敏视图；ai 是 /api/data 的 ai 信息。
export function SettingsPanel({settings, ai, goal, monthCount, readOnly, onClose}) {
  const [model, setModel] = useState(settings?.aiModel || '');
  const [tab, setTab] = useState('ai');

  const tabs = [
    ['ai', 'AI 配置', 'AI'],
    ['platform', '发布平台', 'Platforms'],
    ['goal', '月目标', 'Goal']
  ];

  const saveModel = async id => {
    setModel(id);
    try { await saveSettings({aiModel: id || null}); } catch {} // 失败静默：下拉选择本身可重试
  };

  return <div className="settings-panel">
    <nav className="set-tabs" role="tablist" aria-label="设置分类">
      {tabs.map(([id, zh, en]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{zh}<em>{en}</em></button>)}
    </nav>
    {tab === 'ai' && <AiSection ai={ai} model={model} onModel={saveModel} readOnly={readOnly}/>}
    {tab === 'platform' && <PlatformSection settings={settings} onSaved={() => {}} readOnly={readOnly}/>}
    {tab === 'goal' && <GoalSection goal={goal} monthCount={monthCount} readOnly={readOnly} onGoal={async n => {
      await saveGoal(n);
      onClose?.();
    }}/>}
    {readOnly && <p className="quiet">未连接 NAS：设置只读，连接 note-api 后可编辑 <em>Read-only — connect note-api to edit</em></p>}
  </div>;
}
