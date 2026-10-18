#!/usr/bin/env node
// 把一个 Markdown 笔记文件夹（例如 Obsidian 仓库）转换成看板数据 src/data/my-data.local.js，看板会自动改读它。
// 只用 Node 自带模块，不联网，不修改你的笔记。
//
// 生成的文件写在 .gitignore 里，不会被提交、也不会进发布包；代码里不动任何被跟踪的文件。
//
// 用法：
//   node scripts/import-notes.mjs --vault <笔记文件夹> [选项]
//   node scripts/import-notes.mjs --reset            # 删掉本机数据，切回示例数据
//
// 选项：
//   --works <文件夹>     作品所在文件夹（相对 vault，可多次传）；不传时按文件夹名自动识别
//   --methods <文件夹>   方法笔记所在文件夹
//   --ideas <文件夹>     选题所在文件夹
//   --drafts <文件夹>    草稿所在文件夹
//   --all-as-notes       没被识别的笔记也作为方法笔记导入
//   --account <名字>     账号名（默认「我的账号」）
//   --followers <数字>   粉丝数
//   --max-works <数字>   最多导入多少篇作品（默认 30，按日期取最新）
//   --max-notes <数字>   最多导入多少篇方法笔记（默认 40）
//   --out <文件>         输出到指定文件，且不切换看板数据（用于测试）
import {readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync} from 'node:fs';
import {join, relative, resolve, dirname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readVault} from '../server/vault.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'src/data');
const LOCAL = join(DATA, 'my-data.local.js');

// —— 参数 ——
const args = process.argv.slice(2);
const opt = {works: [], methods: [], ideas: [], drafts: []};
for (let i = 0; i < args.length; i++) {
  const a = args[i], next = () => args[++i];
  if (a === '--vault') opt.vault = next();
  else if (['--works', '--methods', '--ideas', '--drafts'].includes(a)) opt[a.slice(2)].push(next());
  else if (a === '--all-as-notes') opt.allAsNotes = true;
  else if (a === '--account') opt.account = next();
  else if (a === '--followers') opt.followers = Number(next());
  else if (a === '--max-works') opt.maxWorks = Number(next());
  else if (a === '--max-notes') opt.maxNotes = Number(next());
  else if (a === '--out') opt.out = next();
  else if (a === '--reset') opt.reset = true;
  else if (a === '-h' || a === '--help') opt.help = true;
  else { console.error(`未知参数：${a}（用 --help 查看用法）`); process.exit(1); }
}
if (opt.help) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 20).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
if (opt.reset) { rmSync(LOCAL, {force: true}); console.log('已删除 src/data/my-data.local.js，看板回到虚构示例数据（src/data/sample.js）。'); process.exit(0); }
if (!opt.vault || !existsSync(opt.vault) || !statSync(opt.vault).isDirectory()) { console.error('请用 --vault 指定一个存在的笔记文件夹。'); process.exit(1); }
const VAULT = resolve(opt.vault);

// —— 解析与分类都在 server/vault.mjs 里，读盘逻辑只有那一份 ——
const {works, notes, ideas, drafts, concepts, snapshot, counts} = readVault({
  vault: VAULT, works: opt.works, methods: opt.methods, ideas: opt.ideas, drafts: opt.drafts,
  allAsNotes: opt.allAsNotes, account: opt.account, followers: opt.followers,
  maxWorks: opt.maxWorks, maxNotes: opt.maxNotes
});

if (!works.length) {
  console.warn(`提示：没有找到作品笔记，作品库会是空的。作品笔记请放在名字包含「作品 / works」的文件夹里，或用 --works <文件夹> 指定。\n识别到：方法笔记 ${counts.notes}、选题 ${counts.ideas}、草稿 ${counts.drafts}。`);
}

const J = v => JSON.stringify(v, null, 1);
const out = `// 由 scripts/import-notes.mjs 从「${basename(VAULT)}」生成。包含你的个人笔记内容，默认不提交到 git（见 .gitignore）。
// 重新导入：npm run import -- --vault <笔记文件夹>；切回示例数据：npm run import -- --reset

export const snapshot = ${J(snapshot)};

export const posts = ${J(works.map(w => w.post))};

export const postContent = ${J(works.map(w => w.content))};

export const notes = ${J(notes.map(({rel, ...n}) => n))};

export const seedIdeas = ${J(ideas.map(({rel, ...i}) => i))};

export const seedDrafts = ${J(drafts.map(({rel, ...d}) => d))};

export const concepts = ${J(concepts)};
`;
const target = opt.out ? resolve(opt.out) : LOCAL;
mkdirSync(dirname(target), {recursive: true});
writeFileSync(target, out);

console.log(`导入完成：作品 ${works.length}、方法笔记 ${notes.length}、选题 ${ideas.length}、草稿 ${drafts.length}、概念词 ${concepts.length}`);
console.log(`输出：${relative(process.cwd(), target) || target}${opt.out ? '' : '（看板下次启动会优先读这份数据）'}`);
if (!concepts.length) console.log('提示：没有生成概念词（需要同一个话题标签出现在至少两条笔记里），可以手动编辑输出文件末尾的 concepts。');
if (counts.worksTotal > works.length) console.log(`提示：作品共 ${counts.worksTotal} 篇，只取了最新的 ${works.length} 篇（--max-works 可调整）。`);
