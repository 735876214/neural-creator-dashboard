// 运行时的数据仓。
//
// 为什么要有这一层：src/neural/works.js 在模块顶层就执行 posts.map()，graph.js 的 buildGraph()
// 也是同步的 —— 数据必须在任何模块被 import 之前就准备好，不能把整条链路改成 async。
// 所以由 src/neural/boot.js 在挂载 React 之前把数据填进这个仓，src/data/index.js 再同步地导出它，
// 图谱、星核、六星座那些代码一行都不用改。
//
// 数据来源优先级：
//   1. note-api 的 /api/data  —— 部署模式，打开即最新（boot.js 负责取）
//   2. src/data/my-data.local.js —— npm run import 生成的本机快照
//   3. src/data/sample.js     —— 虚构示例
import * as sample from './sample.js';

const local = import.meta.glob('./my-data.local*.js', {eager: true})['./my-data.local.js'];

let data = {...sample, ...(local || {})};
let files = {};
let figures = {};
let mtimes = {};
let settings = null;
let meta = null;
let source = local ? 'local' : 'sample';
let error = null;
let loadedAt = 0;

const listeners = new Set();

export const getData = () => data;
export const getFiles = () => files;
export const getFigures = () => figures;
export const getMtimes = () => mtimes;
export const getSettings = () => settings;
export const getMeta = () => meta;
export const getSource = () => source;
export const getError = () => error;
export const getLoadedAt = () => loadedAt;

// 装载世代：每次发起 /api/data 就 +1，只有最近一次发起的响应才允许覆盖数据。
// 没有它的时候，上传/设置/阅读弹窗触发的 refresh 与 5s 轮询的 refresh 重叠、早发的响应后到时，
// 界面会停在这份旧快照上；而版本号已经被推到新值，之后不再触发刷新，看起来就是「改了没生效」。
let loadSeq = 0;
export const beginLoad = () => ++loadSeq;

// note-api 的 /api/data 返回的就是这份数据的形状，外加 files / figures / mtimes / settings / meta。
// 这几个数组字段是图谱推导的输入，形状不对时绝不能让它们进 data：
// ・缺字段时 `{...data, ...rest}` 会把 sample 的同名数组留在原位 —— 示例的概念词表会
//   继续参与真实笔记库的概念推导，图上凭空出现无来源的概念节点与共振边；
// ・字段显式是 null 时会覆盖成 null，graph.js 顶层 `for (const n of notes)` 在 import 期
//   抛错，boot 的 try/catch 兜不住 → 整站白屏。
// 所以先删掉非数组的键（保留 sample 的原值），再由 boot.js 决定要不要整体回退。
export const ARRAY_FIELDS = ['posts', 'postContent', 'notes', 'seedIdeas', 'seedDrafts', 'concepts', 'semantic'];

// /api/data 的形状校验。boot.js 与 persist.refreshData 两条装载路径都必须过这道门：
// 只挡启动那一次的话，写盘后 / 5s 轮询 / 放弃本地改动这些 refresh 仍会调 setApiData，
// 而 setApiData 只是删掉非数组键 —— sample 的 notes、concepts 会留在原位，
// source 却已经变成 'api'，于是界面进入可编辑态、图上是示例数据混着真笔记。
export function assertApiPayload(json) {
  const missing = ARRAY_FIELDS.filter(k => k !== 'semantic' && !Array.isArray(json?.[k]));
  if (missing.length) {
    const err = new Error(`note-api 返回的数据形状不对（缺少 ${missing.join('、')}）`);
    err.status = 502; // 语义上就是「后端给了不可用的响应」，boot 据此提示并后台自愈
    throw err;
  }
  return json;
}

export function setApiData(payload, seq) {
  if (seq != null && seq !== loadSeq) return false;
  const {files: f, figures: g, mtimes: t, settings: s, meta: m, ...rest} = payload || {};
  for (const k of ARRAY_FIELDS) if (!Array.isArray(rest[k])) delete rest[k];
  data = {...data, ...rest};
  files = f || {};
  figures = g || {};
  mtimes = t || {};
  settings = s || null;
  meta = m || null;
  source = 'api';
  error = null;
  loadedAt = Date.now();
  for (const fn of listeners) fn();
  return true;
}

export function setError(e) {
  error = e ? String(e.message || e) : null;
  for (const fn of listeners) fn();
}

// AI 语义关联任务完成后由前端写回运行时仓：主图谱立刻重建，不需要刷新页面。
// 真正的持久化在服务端 SQLite；这里只是当前会话的镜像。
export function setSemantic(edges) {
  data = {...data, semantic: Array.isArray(edges) ? edges : []};
  for (const fn of listeners) fn();
}

// 保存后刷新用：订阅变化重新推导图谱。
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const isLive = () => source === 'api';
