// 页面入口：先取数据，再挂载 React。
//
// 顺序很关键：数据必须在 src/neural/main.jsx（以及它牵连的 works.js / graph.js）被 import
// 之前就填进 store.js —— 那些模块在顶层就同步地把数据推导成图谱了。
//
// 取数策略分三种情况，避免静态部署时刷出一条没意义的报错：
//   * 设了 VITE_API_BASE  —— 明确是 NAS 模式，取不到就提示（本来就应该取到）
//   * 没设               —— 先安静地试一下同源的 /api/data（开发时的 vite 代理走这条），
//                          取不到就当纯静态站，直接用 my-data.local.js 或示例数据
import {setApiData, setError} from '../data/store.js';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';
const EXPECT_API = import.meta.env.VITE_API_BASE !== undefined;
const TIMEOUT = Number(import.meta.env.VITE_API_TIMEOUT || 8000);

// 取不到后端时给一条一眼能看懂、会自己消失的提示，而不是白屏
function notice(text) {
  const el = document.createElement('div');
  el.textContent = text;
  el.setAttribute('style',
    'position:fixed;left:50%;transform:translateX(-50%);bottom:14px;z-index:9999;max-width:92vw;' +
    'padding:9px 16px;border-radius:999px;font:13px/1.5 system-ui,-apple-system,"Noto Sans SC",sans-serif;' +
    'color:#e8e2d0;background:rgba(12,14,30,.94);border:1px solid rgba(214,183,110,.35);' +
    'box-shadow:0 6px 24px rgba(0,0,0,.45)');
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 10000);
}

async function fetchData() {
  const res = await fetch(`${API_BASE}/api/data`, {
    headers: {accept: 'application/json'},
    signal: AbortSignal.timeout(TIMEOUT)
  });
  if (!res.ok) throw new Error(`note-api 返回 HTTP ${res.status}`);
  const json = await res.json();
  if (!json || !Array.isArray(json.posts)) throw new Error('note-api 返回的数据形状不对');
  return json;
}

try {
  setApiData(await fetchData());
} catch (e) {
  setError(e);
  console.warn('[boot] 读不到 note-api，回退到本地数据：', e.message);
  if (EXPECT_API) notice('连不上笔记库，正在用本地数据 · Offline: using bundled data');
}

document.getElementById('boot-wait')?.remove();
await import('./main.jsx');
