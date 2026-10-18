// 作品库数据来自 src/data/sample.js（虚构示例）。
import {posts as samplePosts, postContent} from '../data';

export const posts = samplePosts;
export const workContent = postContent;
// 「本月」以最新一篇作品所在月份为准
const latest = posts.map(p => p.date).sort().pop();
export const monthPosts = posts.filter(p => p.date.slice(0, 7) === latest.slice(0, 7));

// 部署模式下数据会被 refreshData 整体替换（store.data.posts 变化），所以「本月已发布」
// 必须每次从运行时仓现算，不能沿用模块顶层这份冻结的 monthPosts。
export const monthPostsOf = list => {
  const arr = Array.isArray(list) ? list : [];
  const latest = arr.map(p => p.date).sort().pop();
  return latest ? arr.filter(p => p.date.slice(0, 7) === latest.slice(0, 7)) : arr.filter(p => {
    const now = new Date().toISOString().slice(0, 7);
    return p.date.slice(0, 7) === now;
  });
};
