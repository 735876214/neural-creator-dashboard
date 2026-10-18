// 设置面板：右上角齿轮打开的弹窗内容。
//
// 板块：
//   AI     —— 服务端 AI 状态（只读展示）+ 默认模型选择（写 NAS settings.aiModel）
//   平台   —— 公众号凭据（写 settings.platforms.公众号，secret 只存不回显）+ 同步时间 + 立即同步
//   目标   —— 月目标（并入设置；首页的 goal 弹窗保留）
//
// 数据规矩（与 AGENTS.md 一致）：全部经 /api/settings 写 NAS 的 vault/.dashboard/settings.json，
// 浏览器不持久化；secret 永不回传前端（服务端 GET 时抹掉，只报 configured）。
import React, {useEffect, useRef, useState} from 'react';
import {Icon} from './icons';
import {aiModels} from './sync.js';
import {saveSettings, apiUrl, saveGoal} from './persist';

function AiSection({ai, settings, model, modelMsg, onModel, readOnly, onRefresh}) {
  const keyConfigured = !!settings?.aiKeyConfigured;
  const [baseUrl, setBaseUrl] = useState(settings?.aiBaseUrl || '');
  const [key, setKey] = useState('');
  const [models, setModels] = useState([]);
  const [modelsErr, setModelsErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => setBaseUrl(settings?.aiBaseUrl || ''), [settings]);

  const loadModels = async () => {
    setModelsErr('');
    try {
      const j = await aiModels();
      setModels(j.map(m => m.id || m).filter(Boolean));
      return j;
    } catch { setModelsErr('拉不到模型列表：请检查接口地址与 key'); setModels([]); return []; }
  };
  // 连接刚保存时 connect 自己拉列表并提示；effect 只在连接参数真正变化时补拉
  // （记录上一次的参数，重复保存相同连接不会触发，也不会卡住后续的真实变化）。
  const lastConnRef = useRef(null);
  useEffect(() => {
    if (!ai?.enabled) return;
    const key = `${settings?.aiBaseUrl || ''}|${!!settings?.aiKeyConfigured}`;
    if (lastConnRef.current === key) return;
    lastConnRef.current = key;
    loadModels();
  }, [ai?.enabled, settings?.aiBaseUrl, settings?.aiKeyConfigured]);

  // 第一段：保存接口地址 + key（key 留空 = 不改动）
  const connect = async () => {
    setBusy(true); setMsg('');
    try {
      const patch = {aiBaseUrl: baseUrl.trim()};
      if (key.trim()) patch.aiApiKey = key.trim();
      const next = await saveSettings(patch);
      setKey('');
      onRefresh?.(next);
      // 当场重拉模型列表并按结果提示；effect 侧用 lastConnRef 去重，不会并发重复拉
      const j = await loadModels();
      if (j.length) setMsg('已连接，模型列表已拉到——选一个作为全局默认模型 · Connected');
      else setMsg('已保存连接，但拉不到模型列表');
    } catch (e) { setMsg('保存失败：' + e.message); }
    finally { setBusy(false); }
  };

  return <section className="set-section" aria-label="AI 配置">
    <h3><Icon name="agent" size={14}/>AI <em>AI</em></h3>
    <p className="quiet">{ai?.enabled
      ? `已启用 · 全局模型 ${ai.model || '（各任务默认）'}`
      : '未启用：在下面填接口地址与 key，保存后即时生效（不用重启）'} <em>{ai?.enabled ? 'Enabled' : 'Disabled — configure below'}</em></p>
    <label>AI 接口地址 <em>Base URL</em>
      <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com/v1（留空用环境变量）" disabled={readOnly || busy} aria-label="AI 接口地址"/>
    </label>
    <label>AI API Key <em>API Key</em>
      <input type="password" value={key} onChange={e => setKey(e.target.value)} placeholder={keyConfigured ? '已配置，留空不改动' : 'sk-…'} disabled={readOnly || busy} aria-label="AI API Key" autoComplete="new-password"/>
    </label>
    <div className="form-actions">
      <button className="pill primary" onClick={connect} disabled={busy || readOnly}>保存连接 <em>Connect</em></button>
    </div>
    <p className="quiet">Key 只存 NAS 数据目录（不进笔记库、不回显）；接口地址存设置文件 <em>Key stays in NAS data dir, never echoed</em></p>

    <label>全局模型 <em>Default model</em>
      {models.length
        ? <select value={model || ''} onChange={e => onModel(e.target.value)} disabled={readOnly} aria-label="全局 AI 模型">
            <option value="">跟随服务端默认模型</option>
            {models.map(m => <option key={m} value={m}>{m}</option>)}
            {model && !models.includes(model) && <option value={model}>{model}（当前）</option>}
          </select>
        : <input value={model} onChange={e => onModel(e.target.value)} placeholder={modelsErr || '先保存连接以拉取模型列表'} disabled={readOnly} aria-label="全局 AI 模型（手动输入）"/>}
    </label>
    {modelsErr && <p className="quiet" role="status">{modelsErr}——也可以在上方直接手动输入模型 id</p>}
    {model && <div className="form-actions"><button className="pill ghost" onClick={() => onModel('')} disabled={readOnly}>清除全局模型 <em>Clear</em></button></div>}
    {modelMsg && <p className="quiet" role="alert">{modelMsg}</p>}
    <p className="quiet">全局模型对所有 AI 任务生效（问答 / 分析 / 剪藏 / 日报）；选择写入 NAS 设置 <em>Applies to all AI tasks</em></p>
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
export function SettingsPanel({settings, ai, goal, monthCount, readOnly, onClose, onRefresh}) {
  const [model, setModel] = useState(settings?.aiModel || '');
  const [modelMsg, setModelMsg] = useState('');
  const [tab, setTab] = useState('ai');
  // settings 是异步拉取的（打开弹窗时可能还没回来）：回值到位后同步全局模型下拉，
  // 否则下拉显示为空、动一下就会把 null 存回去覆盖 NAS 上已配置的模型。
  // savedModelRef 只在「保存请求在途」期间钉住本地值（防回流打回旧值），
  // 保存完成即解除——外部后续对 aiModel 的修改仍能正常同步进来。
  const savedModelRef = useRef(undefined);
  useEffect(() => {
    const sv = settings?.aiModel || '';
    if (savedModelRef.current === undefined) setModel(sv);
  }, [settings?.aiModel]);

  const tabs = [
    ['ai', 'AI 配置', 'AI'],
    ['platform', '发布平台', 'Platforms'],
    ['goal', '月目标', 'Goal']
  ];

  const saveModel = async id => {
    const prev = model;
    setModel(id); setModelMsg('');
    savedModelRef.current = id; // 在途保护：回流到达前别把下拉打回旧值
    try {
      await saveSettings({aiModel: id || null});
      savedModelRef.current = undefined; // 保存落定，恢复跟随外部变化
    }
    catch (e) { setModel(prev); savedModelRef.current = undefined; setModelMsg('模型保存失败：' + e.message); } // 回滚 UI 并展示错误
  };

  return <div className="settings-panel">
    <nav className="set-tabs" role="tablist" aria-label="设置分类">
      {tabs.map(([id, zh, en]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{zh}<em>{en}</em></button>)}
    </nav>
    {tab === 'ai' && <AiSection ai={ai} settings={settings} model={model} modelMsg={modelMsg} onModel={saveModel} readOnly={readOnly} onRefresh={onRefresh}/>}
    {tab === 'platform' && <PlatformSection settings={settings} onSaved={() => {}} readOnly={readOnly}/>}
    {tab === 'goal' && <GoalSection goal={goal} monthCount={monthCount} readOnly={readOnly} onGoal={async n => {
      await saveGoal(n);
      onClose?.();
    }}/>}
    {readOnly && <p className="quiet">未连接 NAS：设置只读，连接 note-api 后可编辑 <em>Read-only — connect note-api to edit</em></p>}
  </div>;
}
