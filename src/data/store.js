// 运行时的数据仓。
//
// 为什么要有这一层：src/neural/works.js 在模块顶层就执行 posts.map()，graph.js 的 buildGraph()
// 也是同步的 —— 数据必须在任何模块被 import 之前就准备好，不能把整条链路改成 async。
// 所以由 src/neural/boot.js 在挂载 React 之前把数据填进这个仓，src/data/index.js 再同步地导出它，
// 图谱、星核、五星座那些代码一行都不用改。
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

// note-api 的 /api/data 返回的就是这份数据的形状，外加 files / figures / mtimes / settings / meta。
export function setApiData(payload) {
  const {files: f, figures: g, mtimes: t, settings: s, meta: m, ...rest} = payload || {};
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
}

export function setError(e) {
  error = e ? String(e.message || e) : null;
  for (const fn of listeners) fn();
}

// 保存后刷新用：订阅变化重新推导图谱。
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const isLive = () => source === 'api';
