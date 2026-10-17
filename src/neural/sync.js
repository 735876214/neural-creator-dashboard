// 部署模式的同步钩子：把看板里的选题、草稿、目标写回 note-api，落到 vault 里的 .md 文件。
//
// 连着后端（/api/data 可达）时：写操作进队列按序落盘，localStorage 降级为离线草稿缓存，
// 恢复后下次进入页面把离线改动补传上去。连不上时行为与原来的 useSaved 完全一样。
//
// 写入用 path 定位文件（不用 n1 / w1 这类位置 id——笔记增删后 id 会整体位移），
// mtime 做乐观锁，409 时提示而不是静默覆盖。
import {useEffect, useRef, useState} from 'react';
import {getMeta} from '../data/store.js';

export const isLive = () => !!getMeta();

export function useSynced(key, fallback) {
  const [v, set] = useState(() => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } });
  const flush = useRef(null);
  const busy = useRef(false);
  const queue = useRef([]);

  // 把一组 {path, fm, body, mtime} 写回 note-api，逐条串行，一条失败不影响后面的。
  flush.current = async items => {
    for (const it of items) {
      busy.current = true;
      try {
        const res = await fetch('/api/note', {
          method: 'PUT', headers: {'content-type': 'application/json'},
          body: JSON.stringify(it)
        });
        if (res.status === 409) {
          // 别处改过：留一份冲突副本，不覆盖
          const {body: current} = await res.json().catch(() => ({}));
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          try { localStorage.setItem(`${key}-conflict-${stamp}`, JSON.stringify({mine: it, current})); } catch {}
          console.warn('[sync] 409 冲突，已留副本：', it.path);
        }
      } catch { /* 离线：留在 localStorage，下次再补传 */ }
    }
    busy.current = false;
  };

  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }, [key, v]);

  // 离线期间的改动补传：进页面时跑一次
  useEffect(() => {
    if (!isLive()) return;
    const stamp = localStorage.getItem(key + '-pending');
    if (!stamp) return;
    try {
      const items = JSON.parse(stamp);
      if (Array.isArray(items) && items.length) flush.current(items).then(() => localStorage.removeItem(key + '-pending'));
    } catch { localStorage.removeItem(key + '-pending'); }
  }, [key]);

  const setValue = value => {
    set(value);
    if (!isLive()) return;
    // 记下离线补传的队列（最新的覆盖旧的），有网时落盘
    try { localStorage.setItem(key + '-pending', JSON.stringify([{key, savedAt: Date.now()}])); } catch {}
  };

  return [v, setValue];
}

// 把看板的 ideas / drafts 状态同步成 vault 文件的辅助函数：
// 每个条目都能拿到自己的 rel 路径与 mtime（来自 /api/data 的 files 与单篇 GET）。
export async function saveNote({path, fm, body, mtime}) {
  const res = await fetch('/api/note', {
    method: 'PUT', headers: {'content-type': 'application/json'},
    body: JSON.stringify({path, fm, body, mtime})
  });
  if (res.status === 409) {
    const e = new Error('conflict');
    e.code = 409;
    e.current = await res.json().catch(() => ({}));
    throw e;
  }
  if (!res.ok) throw new Error(`保存失败：HTTP ${res.status}`);
  return res.json();
}

export async function loadNote({path, id}) {
  const q = path ? 'path=' + encodeURIComponent(path) : 'id=' + encodeURIComponent(id);
  const res = await fetch('/api/note?' + q);
  if (!res.ok) throw new Error(`读取失败：HTTP ${res.status}`);
  return res.json();
}

export async function createEntry(kind, {title, body, fm}) {
  const res = await fetch('/api/' + (kind === 'idea' ? 'idea' : 'draft'), {
    method: 'PUT', headers: {'content-type': 'application/json'},
    body: JSON.stringify({title, body, fm})
  });
  if (!res.ok) throw new Error(`创建失败：HTTP ${res.status}`);
  return res.json();
}

// —— AI 封装：返回原始 JSON，调用方负责轮询任务 ——

// 用户在前端选的模型（localStorage 记住；AskBox 与 AI 面板共用）。
export function pickedModel() {
  try { return localStorage.getItem('ai-model') || null; } catch { return null; }
}
export function setPickedModel(id) {
  try { id ? localStorage.setItem('ai-model', id) : localStorage.removeItem('ai-model'); } catch {}
}

// 可用模型列表（服务端从网关 /v1/models 拉的快照）。失败返回空数组，UI 据此隐藏下拉。
export async function aiModels() {
  try {
    const res = await fetch('/api/ai/models');
    if (!res.ok) return [];
    const j = await res.json();
    return j.models || [];
  } catch { return []; }
}

export async function aiAnalyze(paths, dryRun = false) {
  const res = await fetch('/api/ai/analyze', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({paths, dryRun, model: pickedModel()})
  });
  if (!res.ok) throw new Error(`AI analyze：HTTP ${res.status}`);
  return res.json();
}

export async function aiRelate(threshold = 0.82) {
  const res = await fetch('/api/ai/relate', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({threshold})
  });
  if (!res.ok) throw new Error(`AI relate：HTTP ${res.status}`);
  return res.json();
}

export async function aiIdeas(paths) {
  const res = await fetch('/api/ai/ideas', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({paths, model: pickedModel()})
  });
  if (!res.ok) throw new Error(`AI ideas：HTTP ${res.status}`);
  return res.json();
}
