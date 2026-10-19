// AI 请求封装。数据持久化（选题/草稿/目标）在 persist.js，不再经过这里。
//
// AI key 只存在于服务端；前端只负责发请求与轮询任务。
// API 前缀统一用 VITE_API_BASE，部署到独立后端时也能工作。
const API = import.meta.env.VITE_API_BASE ?? '';

// 用户在前端选的模型记在 NAS 设置里（persist.js），这里重新导出给分析面板用。
export {pickedModel, setPickedModel} from './persist.js';
import {pickedModel} from './persist.js';

// 可用模型列表（服务端从网关 /v1/models 拉的快照）。失败返回空数组，UI 据此隐藏下拉。
export async function aiModels() {
  try {
    const res = await fetch(API + '/api/ai/models');
    if (!res.ok) return [];
    const j = await res.json();
    return j.models || [];
  } catch { return []; }
}

export async function aiAnalyze(paths, dryRun = false) {
  const res = await fetch(API + '/api/ai/analyze', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({paths, dryRun, model: pickedModel()})
  });
  if (!res.ok) throw new Error(`AI analyze：HTTP ${res.status}`);
  // 注意：这里只拿到 202 任务号，写 frontmatter 发生在服务端后台任务里，
  // 登记「本页写入」必须等 pollJob 结束之后（见 Analysis.jsx），放在这里会探到写盘前的指纹。
  return res.json();
}

export async function aiRelate(threshold = 0.82) {
  const res = await fetch(API + '/api/ai/relate', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({threshold})
  });
  if (!res.ok) throw new Error(`AI relate：HTTP ${res.status}`);
  return res.json();
}

export async function aiIdeas(paths) {
  const res = await fetch(API + '/api/ai/ideas', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({paths, model: pickedModel()})
  });
  if (!res.ok) throw new Error(`AI ideas：HTTP ${res.status}`);
  return res.json(); // 只返回候选选题，不写盘，不必登记本页写入
}
