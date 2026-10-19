// 看板读取的数据入口。
//
// 数据的实际内容由 src/data/store.js 提供：boot.js 在挂载 React 之前把 note-api 的数据填进去，
// 没起后端时就沿用 my-data.local.js（npm run import 生成的）或 src/data/sample.js。
//
// 注意：这些导出必须是「活绑定」（export let + 订阅同步），不能写成 const 快照。
// works.js / graph.js / pages.jsx 在模块顶层就把这些名字解构走了，而 refreshData() 换掉的是
// store 里的整个对象；用 const 快照会让剪藏、新建、删除、外部改动之后图谱和列表都停在旧数据。
import {getData, getFiles, getFigures, getMeta, getSource, getError, isLive, getSettings, getMtimes, subscribe} from './store.js';

export let snapshot;
export let posts;
export let postContent;
export let notes;
export let seedIdeas;
export let seedDrafts;
export let concepts;
// AI 语义边初始快照（运行中的更新走 store.setSemantic；graph.js 直接读运行时仓）
export let semantic;

// —— 只有部署模式（连着 note-api）才有的一层；纯静态构建时都是空的 ——
// files：图谱节点 id → 文件相对路径，写回笔记时用它定位文件
// figures：节点 id → 这篇笔记引用的附件，用于显示「N 张图」角标
export let files;
export let figures;
export let mtimes;
export let settings;
export let meta;
export let dataSource;
export let dataError;

// store 每次 setApiData / setSemantic / setError 都会通知；重新赋值才会让上面的活绑定生效。
export function syncFromStore() {
  const d = getData();
  snapshot = d.snapshot;
  posts = d.posts;
  postContent = d.postContent;
  notes = d.notes;
  seedIdeas = d.seedIdeas;
  seedDrafts = d.seedDrafts;
  concepts = d.concepts;
  semantic = d.semantic || [];
  files = getFiles();
  figures = getFigures();
  mtimes = getMtimes();
  settings = getSettings();
  meta = getMeta();
  dataSource = getSource();
  dataError = getError();
}

syncFromStore();
subscribe(syncFromStore);

export {isLive};
