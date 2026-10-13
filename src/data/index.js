// 看板读取的数据入口。
// 默认使用虚构示例数据（src/data/sample.js）；如果本机存在 src/data/my-data.local.js，
// 就优先使用它——那份文件由 `npm run import` 生成，已在 .gitignore 里，不会被提交，也不会进发布包。
import * as sample from './sample.js';

const local = import.meta.glob('./my-data.local*.js', {eager: true})['./my-data.local.js'];

const data = {...sample, ...(local || {})};

export const snapshot = data.snapshot;
export const posts = data.posts;
export const postContent = data.postContent;
export const notes = data.notes;
export const seedIdeas = data.seedIdeas;
export const seedDrafts = data.seedDrafts;
export const concepts = data.concepts;
