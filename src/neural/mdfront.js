// 笔记文本的纯函数工具：不依赖浏览器 / Vite，前端与 scripts/test-api.mjs 共用同一份实现。
// 之所以单独拆一个文件：如果测试里自己内联一份正则，就永远测不到前端真正用的那段逻辑。
export const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

// 去掉开头的 --- frontmatter 块，只留正文。
// /api/note 的 GET 返回整篇原文，写回时 PUT 的 body 只接受正文（服务端 setBody 会保留原 frontmatter），
// 少了这一步每保存一次就会把 frontmatter 复制一份。
export const stripFrontmatter = text => String(text || '').replace(FM_RE, '');
