// 看板读取的数据入口。
//
// 数据的实际内容由 src/data/store.js 提供：boot.js 在挂载 React 之前把 note-api 的数据填进去，
// 没起后端时就沿用 my-data.local.js（npm run import 生成的）或 src/data/sample.js。
// 导出名字保持不变，works.js / graph.js / Analysis.jsx 一行都不用改。
import {getData, getFiles, getFigures, getMeta, getSource, getError, isLive} from './store.js';

const data = getData();

export const snapshot = data.snapshot;
export const posts = data.posts;
export const postContent = data.postContent;
export const notes = data.notes;
export const seedIdeas = data.seedIdeas;
export const seedDrafts = data.seedDrafts;
export const concepts = data.concepts;

// —— 只有部署模式（连着 note-api）才有的一层；纯静态构建时都是空的 ——
// files：图谱节点 id → 文件相对路径，写回笔记时用它定位文件
// figures：节点 id → 这篇笔记引用的附件，用于显示「N 张图」角标
export const files = getFiles();
export const figures = getFigures();
export const meta = getMeta();
export const dataSource = getSource();
export const dataError = getError();
export {isLive};
