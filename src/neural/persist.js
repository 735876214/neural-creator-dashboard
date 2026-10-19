// 看板业务数据的 NAS 持久化层。
//
// 部署模式（/api/data 可达）：选题、草稿、月目标、AI 模型选择全部写回 note-api，
// 浏览器 localStorage 不参与存储。每个条目维护 {path, mtime}：
//   * 写回一律用相对路径，不用 idea:1 / draft:draft-1 这类会随文件增删位移的位置 id；
//   * 每次写都带 mtime 做乐观锁，409 不覆盖，交给用户决定；
//   * 新建成功后立刻记住服务端返回的 path/mtime，同一会话后续编辑直接落盘。
//
// 写入调度：1.2s 防抖、同一 key 串行、失败进内存 outbox 并按指数退避重试。
// 按「数据不保存在浏览器」的要求，outbox 只在内存里；刷新/关闭页面前会提示。
import {useSyncExternalStore} from 'react';
import {getMeta, getFiles, getMtimes, getSettings, setApiData} from '../data/store.js';
import {FM_RE, stripFrontmatter} from './mdfront.js';

// 兼容既有调用方（main.jsx 用 persist.stripFrontmatter）。
export {stripFrontmatter};

export const isLive = () => !!getMeta();

const API = import.meta.env.VITE_API_BASE ?? '';
const DELAY = 1200;

export const apiUrl = path => API + path;

const REF_KINDS = new Set(['idea', 'draft']);

// key -> {path, mtime}
const refs = new Map();
// key -> SaveState
const states = new Map();
const listeners = new Set();
// key -> Promise（同一文件串行写）
const chains = new Map();
// key -> 防抖计时器
const timers = new Map();
// key -> {op:'create'|'update', kind:'idea'|'draft'|'settings', payload, sig}
const outbox = new Map();
// key -> 重试计时器 / 连续失败次数
const retryTimers = new Map();
const attempts = new Map();
// key -> 最近一次成功写入的 payload 签名，避免无变化的重复写
const savedSigs = new Map();

// 全局状态版本：给 usePendingSaves 提供稳定快照
let version = 0;
let overviewVersion = -1;
let overviewCache = [];
const EMPTY = [];
const UNRESOLVED = new Set(['pending', 'error', 'conflict']);

const DEFAULT_STATE = {state: 'idle', at: 0};

export const ideaKey = id => 'idea:' + id;
export const draftKey = id => 'draft:' + id;

// —— refs ——

export function seedRefs({files, mtimes} = {}) {
  for (const [key, path] of Object.entries(files || {})) {
    if (!REF_KINDS.has(key.split(':')[0])) continue;
    refs.set(key, {path, mtime: mtimes?.[key] ?? null});
  }
}

// 某条记录当前在 vault 里的路径：内存 refs（本页刚写入的）优先，其次 /api/data 的 files。
// 新建草稿后 /api/data 尚未刷新，发布按钮靠它反查路径，否则必须先刷新页面才能发布。
export function refPath(key) {
  const r = refs.get(key);
  if (r?.path) return r.path;
  return getFiles()[key] || null;
}

function refFor(key) {
  if (refs.has(key)) return refs.get(key);
  const path = getFiles()[key];
  if (!path) return null;
  const r = {path, mtime: getMtimes()[key] ?? null};
  refs.set(key, r);
  return r;
}

// —— 保存状态订阅 ——

export const getSaveState = key => states.get(key) || DEFAULT_STATE;

function emit() { version++; for (const fn of listeners) fn(); }

function setState(key, patch) {
  states.set(key, {...(states.get(key) || DEFAULT_STATE), ...patch, at: Date.now()});
  emit();
}

function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function useSaveState(key) {
  return useSyncExternalStore(subscribe, () => getSaveState(key), () => DEFAULT_STATE);
}

// 顶部同步横幅用：所有未落盘/失败/冲突的条目。
function pendingSnapshot() {
  if (overviewVersion === version) return overviewCache;
  overviewVersion = version;
  overviewCache = [...outbox.keys()]
    .map(key => ({key, state: getSaveState(key)}))
    .filter(x => UNRESOLVED.has(x.state.state));
  return overviewCache;
}

export function usePendingSaves() {
  return useSyncExternalStore(subscribe, pendingSnapshot, () => EMPTY);
}

// —— payload ——

const draftPayload = (draft, sourceTitle) => {
  const fm = {};
  // 选题关联：稳定 id 优先（sourceIdeaId，改名不断链）；标题仅作为老读取端的兼容回退。
  // 只固化「稳定 id」：老数据里 readVault 按目录顺序生成的数字序号会随文件增删位移，
  // 固化成 sourceIdeaId 后会在序号位移时错关联；数字 source 保持标题回退，不写 sourceIdeaId。
  if (draft.source != null && draft.source !== '' && typeof draft.source !== 'number') fm.sourceIdeaId = String(draft.source);
  if (sourceTitle) fm.source = sourceTitle;
  // 发布来源（半自动发布回填）：非空才写，避免把空键刷进文件
  for (const k of ['platform', 'url', 'platformId', 'syncedAt']) {
    const v = String(draft[k] ?? '').trim();
    if (v) fm[k] = v;
  }
  return {title: String(draft.title || '').trim() || '未命名草稿', body: draft.body || '', fm};
};

const ideaPayload = idea => ({
  title: String(idea.title || '').trim() || '未命名选题',
  fm: {platform: idea.platform, priority: idea.priority, status: idea.status, note: idea.note || ''}
});

const sigOf = payload => JSON.stringify(payload);

// —— 调度 ——

function nextEntry(key, kind, payload) {
  const prev = outbox.get(key);
  return {op: prev?.op === 'create' ? 'create' : 'update', kind, payload, sig: sigOf(payload)};
}

function queue(key, kind, payload, delay = DELAY) {
  if (!isLive()) return;
  const sig = sigOf(payload);
  if (!outbox.has(key) && savedSigs.get(key) === sig) return;
  outbox.set(key, nextEntry(key, kind, payload));
  clearTimeout(timers.get(key));
  if (delay > 0) {
    timers.set(key, setTimeout(() => { timers.delete(key); flushKey(key); }, delay));
  } else {
    timers.delete(key);
    flushKey(key);
  }
  if (getSaveState(key).state !== 'conflict') setState(key, {state: 'saving', message: undefined});
}

function queueNow(key, kind, payload) {
  clearTimeout(timers.get(key));
  timers.delete(key);
  if (!isLive()) return Promise.resolve(null);
  outbox.set(key, nextEntry(key, kind, payload));
  if (getSaveState(key).state !== 'conflict') setState(key, {state: 'saving', message: undefined});
  return flushKey(key);
}

export function scheduleDraft(draft, sourceTitle) {
  queue(draftKey(draft.id), 'draft', draftPayload(draft, sourceTitle));
}

export function scheduleIdea(idea) {
  queue(ideaKey(idea.id), 'idea', ideaPayload(idea));
}

export function saveIdeaNow(idea) {
  return queueNow(ideaKey(idea.id), 'idea', ideaPayload(idea));
}

export function createDraft({id, title, body, sourceTitle}) {
  const key = draftKey(id);
  if (!isLive()) return Promise.resolve(null);
  clearTimeout(timers.get(key));
  timers.delete(key);
  const payload = draftPayload({title, body}, sourceTitle);
  outbox.set(key, {op: 'create', kind: 'draft', payload, sig: sigOf(payload)});
  setState(key, {state: 'saving', message: undefined});
  return flushKey(key).then(() => refs.get(key) || null);
}

export function saveGoal(goal) {
  return queueNow('goal', 'settings', {goal});
}

export function saveAiModel(id) {
  if (!isLive()) return Promise.resolve(null);
  return queueNow('aiModel', 'settings', {aiModel: id || null});
}

// 设置面板专用：一次写多个设置项（goal / aiModel / platforms / syncHour 的任意组合）。
// 平台凭据带 secret 时必须立即落盘（不走防抖 outbox 的重试语义也没有害处，这里直接串行 PUT）。
export async function saveSettings(patch) {
  if (!isLive()) return Promise.reject(new Error('未连接 NAS：只读演示'));
  const res = await fetch(API + '/api/settings', {
    method: 'PUT', headers: {'content-type': 'application/json'},
    body: JSON.stringify(patch)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status);
  return j;
}

// —— 串行执行与重试 ——

function enqueue(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(fn, fn).catch(e => {
    setState(key, {state: 'error', message: e?.message || '保存失败'});
  });
  chains.set(key, next);
  next.finally(() => { if (chains.get(key) === next) chains.delete(key); });
  return next;
}

function retryLater(key) {
  const n = (attempts.get(key) || 0) + 1;
  attempts.set(key, n);
  const delay = Math.min(30000, 2000 * 2 ** (n - 1));
  clearTimeout(retryTimers.get(key));
  retryTimers.set(key, setTimeout(() => { retryTimers.delete(key); flushKey(key); }, delay));
  setState(key, {state: 'pending', message: '离线，改动暂存在本页内存 · Offline — kept in this tab'});
}

async function send(key, item) {
  if (item.kind === 'settings') {
    return fetch(API + '/api/settings', {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(item.payload)
    });
  }
  const ref = refFor(key);
  // 只要已经拿到 path，就按「更新」写；只有从未落盘过才新建。
  // （新建请求在途时用户又编辑，会排在同一条 chain 后面，等拿到 path 再更新，避免重复建文件。）
  const body = ref
    ? {path: ref.path, title: item.payload.title, body: item.payload.body, fm: item.payload.fm, mtime: ref.mtime}
    : {title: item.payload.title, body: item.payload.body, fm: item.payload.fm};
  return fetch(API + '/api/' + item.kind, {
    method: 'PUT',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body)
  });
}

export function flushKey(key) {
  return enqueue(key, async () => {
    const item = outbox.get(key);
    if (!item) return;
    const state = getSaveState(key);
    if (state.state === 'conflict' || state.state === 'error') return;

    let res;
    try {
      res = await send(key, item);
    } catch {
      retryLater(key);
      return;
    }

    if (res.status === 409) {
      const j = await res.json().catch(() => ({}));
      const ref = refFor(key);
      if (ref && j.mtime != null) refs.set(key, {path: j.path || ref.path, mtime: j.mtime});
      setState(key, {
        state: 'conflict',
        message: 'NAS 文件已被其他编辑器改动，未覆盖 · Conflict — not overwritten',
        serverMtime: j.mtime,
        serverContent: j.content, // NAS 当前完整文本：冲突 diff 对比用
        path: j.path || ref?.path
      });
      return;
    }

    if (res.status === 404) {
      setState(key, {state: 'error', message: 'NAS 上找不到这个文件，请刷新页面 · File not found on NAS — refresh'});
      return;
    }

    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      if (res.status >= 500 || res.status === 429) { retryLater(key); return; }
      setState(key, {state: 'error', message: (j.error || '保存失败') + ` · HTTP ${res.status}`});
      return;
    }

    const j = await res.json().catch(() => ({}));
    savedSigs.set(key, item.sig);
    markSelfWrite(); // 登记「这次写盘是本页写的」：自动刷新轮询据此不再弹假的外部改动提示
    attempts.delete(key);
    clearTimeout(retryTimers.get(key)); retryTimers.delete(key);

    if (item.kind === 'settings') {
      setState(key, {state: 'saved', message: undefined, serverMtime: undefined});
    } else if (j.path) {
      refs.set(key, {path: j.path, mtime: j.mtime});
    }

    const current = outbox.get(key);
    if (current && current.sig === item.sig) outbox.delete(key);

    if (outbox.has(key)) {
      setState(key, {state: 'saving', message: undefined});
      flushKey(key);
    } else {
      setState(key, {state: 'saved', message: undefined, path: j.path, serverMtime: j.mtime});
    }
  });
}

export function retry(key) {
  attempts.delete(key);
  setState(key, {state: 'saving', message: undefined});
  return flushKey(key);
}

export function flushNow() {
  attempts.clear();
  for (const [key, t] of timers) { clearTimeout(t); timers.delete(key); }
  return Promise.all([...outbox.keys()].map(key => {
    if (getSaveState(key).state === 'conflict') return null;
    setState(key, {state: 'saving', message: undefined});
    return flushKey(key);
  }));
}

// 最近一次本页写盘成功的时间戳（0 = 没有）；外部改动自动刷新用它区分「自己写的」与「外部改的」。
let lastSelfWriteAt = 0;
export const lastSelfWrite = () => lastSelfWriteAt;
// 最近一次本页写盘后 /api/version 返回的指纹（0 = 未知）。轮询拿它判定「这次变化就是自己写的」。
let selfVersion = 0;
let selfVersionSeq = 0; // 多次写盘并行时只认最后发起的那次，避免旧指纹盖掉新指纹
export const lastSelfVersion = () => selfVersion;
// 任何一条写盘成功路径（persist.flushKey 与阅读弹窗的直连 PUT）都要调它登记，
// 否则下一次轮询会把这次写入当成外部改动，弹一条假的「笔记库有外部改动」。
// 故意不 await：这是给轮询用的附加信息，不该阻塞保存状态，也不该让 /api/version 卡住保存链。
export function markSelfWrite() {
  lastSelfWriteAt = Date.now();
  const seq = ++selfVersionSeq;
  try {
    // 老浏览器没有 AbortSignal.timeout 时退化成不超时；这里绝不能往抛异常，
    // 它在保存成功路径上，抛出去会把一次已经落盘的保存变成「保存失败」。
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(4000) : undefined;
    fetch(API + '/api/version', signal ? {signal} : undefined)
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (seq === selfVersionSeq && j && typeof j.v === 'number') selfVersion = j.v; })
      .catch(() => { /* 拿不到就退化成时间窗判断 */ });
  } catch { /* 同上：探测失败不影响保存 */ }
}
// 有在途/未落盘的写入（outbox 有 key，或状态 pending/error/conflict）——自动刷新不覆盖这些条目。
export const isPending = key => outbox.has(key) || UNRESOLVED.has(getSaveState(key).state);

export function pendingCount() {
  return [...outbox.keys()].filter(key => ['pending', 'error', 'conflict'].includes(getSaveState(key).state)).length;
}

// 冲突详情：NAS 版本（完整文本）+ 本地待写内容（outbox payload），供 diff 对话框展示。
export function conflictInfo(key) {
  const st = getSaveState(key);
  if (st.state !== 'conflict') return null;
  const item = outbox.get(key);
  return {
    key,
    path: st.path,
    serverMtime: st.serverMtime,
    serverContent: st.serverContent ?? '',
    localTitle: item?.payload?.title,
    localBody: item?.payload?.body,
    localFm: item?.payload?.fm
  };
}

// 放弃本地改动、采用 NAS 版本：清掉 outbox 与状态；refs 保留（mtime 已在 409 时更新为服务端值）。
export function discardLocal(key) {
  outbox.delete(key);
  attempts.delete(key);
  savedSigs.delete(key);
  clearTimeout(timers.get(key)); timers.delete(key);
  clearTimeout(retryTimers.get(key)); retryTimers.delete(key);
  states.delete(key);
  emit();
}

export function overwriteConflict(key) {
  const st = getSaveState(key);
  const ref = refFor(key);
  if (ref && st.serverMtime != null) refs.set(key, {path: st.path || ref.path, mtime: st.serverMtime});
  attempts.delete(key);
  if (!outbox.has(key)) { setState(key, {state: 'saved', message: undefined}); return Promise.resolve(); }
  setState(key, {state: 'saving', message: undefined});
  return flushKey(key);
}

// —— 删除 ——

export async function deleteDraft(id) {
  const key = draftKey(id);
  clearTimeout(timers.get(key)); timers.delete(key);
  clearTimeout(retryTimers.get(key)); retryTimers.delete(key);
  const pending = outbox.get(key);

  // 还没在 NAS 上创建过、也没有在途创建：取消排队中的创建即可。
  if (pending?.op === 'create' && !refFor(key) && !chains.has(key)) {
    outbox.delete(key); attempts.delete(key); states.delete(key); emit();
    return {ok: true, gone: false};
  }

  // 有在途请求（尤其是刚发出的创建）时先等它结束，再按最终 path 删除。
  await (chains.get(key) || Promise.resolve());
  const current = refFor(key);
  if (!current) {
    outbox.delete(key); attempts.delete(key); states.delete(key); emit();
    return {ok: true, gone: false};
  }

  outbox.delete(key);
  try {
    const res = await fetch(API + '/api/note?path=' + encodeURIComponent(current.path), {method: 'DELETE'});
    if (res.ok || res.status === 404) {
      markSelfWrite(); // 删除也是一次写盘，不登记就会在下一轮轮询里变成假的「外部改动」
      refs.delete(key); savedSigs.delete(key); attempts.delete(key); states.delete(key); emit();
      return {ok: true, gone: true};
    }
    const j = await res.json().catch(() => ({}));
    setState(key, {state: 'error', message: (j.error || '删除失败') + ` · HTTP ${res.status}`});
    return {ok: false, gone: false, error: j.error || `删除失败：HTTP ${res.status}`};
  } catch {
    setState(key, {state: 'pending', message: '离线，删除尚未同步到 NAS · Offline — delete not synced'});
    return {ok: false, gone: false, error: '离线，删除尚未同步到 NAS'};
  }
}

// —— 完整正文读取（/api/data 的正文被 clean() 截断到 6000 字）——

// 重新拉全量数据（知识库新增剪藏 / 删除后调用）：setApiData 触发订阅者，图谱与列表即时重建。
export async function refreshData() {
  const res = await fetch(API + '/api/data?fresh');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  setApiData(await res.json());
}

function fmValue(text, keys) {
  const m = String(text || '').match(FM_RE);
  if (!m) return undefined;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([^:#][^:]*):\s*(.*)$/);
    if (!kv) continue;
    if (keys.some(k => k.toLowerCase() === kv[1].trim().toLowerCase())) {
      return kv[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return undefined;
}

async function readFull(key) {
  const ref = refFor(key);
  if (!isLive() || !ref?.path) return null;
  const res = await fetch(API + '/api/note?path=' + encodeURIComponent(ref.path));
  if (!res.ok) return null;
  const j = await res.json();
  refs.set(key, {path: j.path || ref.path, mtime: j.mtime});
  return j;
}

export async function hydrateDraft(id) {
  const key = draftKey(id);
  const j = await readFull(key);
  if (!j) return null;
  return {body: stripFrontmatter(j.text), mtime: j.mtime, path: j.path};
}

export async function hydrateIdea(id) {
  const key = ideaKey(id);
  const j = await readFull(key);
  if (!j) return null;
  const note = fmValue(j.text, ['note', '备注', 'description', '简介']);
  return {note: note ?? stripFrontmatter(j.text).trim(), mtime: j.mtime, path: j.path};
}

// —— AI 模型选择：跟着设置一起存 NAS，不写 localStorage ——

let pickedAiModel = getSettings()?.aiModel ?? null;

export function pickedModel() { return pickedAiModel; }

export function setPickedModel(id) {
  pickedAiModel = id || null;
  saveAiModel(pickedAiModel);
}

// —— 启动：用 /api/data 的 files + mtimes 建立基线 ——

seedRefs({files: getFiles(), mtimes: getMtimes()});

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { attempts.clear(); flushNow(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && pendingCount()) { attempts.clear(); flushNow(); }
  });
  window.addEventListener('beforeunload', e => {
    if (outbox.size || timers.size) { e.preventDefault(); e.returnValue = ''; }
  });
}

// 供调试/状态栏使用
export const pendingKeys = () => [...outbox.keys()];
