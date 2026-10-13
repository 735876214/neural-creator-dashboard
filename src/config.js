// 个性化配置：换成你自己的品牌名、账号和头像，其余代码不用改。
// Personal settings: swap in your own brand, account and avatar; nothing else needs to change.
//
// 不想改这个被跟踪的文件时，也可以在本机放一份 `src/config.local.js`（已在 .gitignore），
// 导出同样形状的 `CONFIG` 覆盖下面这份中性默认值——这样仓库和发布包里永远只有默认值。
const defaults = {
  brand: {name: '你的品牌', sub: 'AI LAB', tagline: '知识与作品的星穹星座', taglineEn: 'Knowledge × works constellation'},
  // 图谱中心节点的名字
  workspace: '我的创作空间',
  // 头像放在 public/ 下，填相对路径
  avatar: 'avatar.svg',
  footer: {zh: '笔记与作品，都是星图里的一颗恒星。', en: 'Every note and every work is a star in the chart.'},
  // 选题、草稿、目标保存在浏览器 localStorage 里的键名前缀
  // 换成了自己的数据，就换一个前缀：否则浏览器里遗留的示例选题、草稿会盖住导入的真实数据
  storagePrefix: 'neural-dashboard'
};

const local = import.meta.glob('./config.local*.js', {eager: true})['./config.local.js'];

export const CONFIG = {...defaults, ...(local?.CONFIG || {})};

// public/ 下的素材路径（兼容部署在子路径，如 GitHub Pages）
export const asset = path => import.meta.env.BASE_URL + path;
