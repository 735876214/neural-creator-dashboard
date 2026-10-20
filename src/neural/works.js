// 作品库数据：复用 src/data/index.js 的活绑定（note-api / 本机快照 / 示例三种来源由 store 决定）。
// 必须是 re-export 而不是 const 拷贝，否则 refreshData() 之后作品列表和图谱还是旧的。
export {posts, postContent as workContent} from '../data';

// 月目标看的是「这个月」：优先取当前自然月；只有当数据整体是旧快照（最新一篇也在过去月份，
// 比如示例数据或很久没同步的库）时才退回到最新一篇所在月份，免得月目标永远显示 0/xx 或永远停在旧月份。
export const monthPostsOf = (list, today = new Date()) => {
  const arr = (Array.isArray(list) ? list : []).filter(p => p && p.date);
  if (!arr.length) return [];
  const cur = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const inMonth = arr.filter(p => String(p.date).slice(0, 7) === cur);
  if (inMonth.length) return inMonth;
  const latest = arr.reduce((m, p) => (p.date > m ? p.date : m), '');
  const latestMonth = String(latest).slice(0, 7);
  return latestMonth && latestMonth < cur ? arr.filter(p => String(p.date).slice(0, 7) === latestMonth) : [];
};
