// 作品库数据：复用 src/data/index.js 的活绑定（note-api / 本机快照 / 示例三种来源由 store 决定）。
// 必须是 re-export 而不是 const 拷贝，否则 refreshData() 之后作品列表和图谱还是旧的。
export {posts, postContent as workContent} from '../data';

// 「本月」以最新一篇作品所在月份为准
export const monthPostsOf = list => {
  const arr = Array.isArray(list) ? list : [];
  const latest = arr.reduce((m, p) => p.date > m ? p.date : m, '');
  return latest ? arr.filter(p => p.date.slice(0, 7) === latest.slice(0, 7)) : [];
};
