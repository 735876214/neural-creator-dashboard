// 最小侵入地改写 Markdown 笔记：只动被指定的 frontmatter 键和正文，其余原样保留。
//
// 为什么不用 YAML 库整体反序列化再重新序列化：那会丢掉字段顺序、行内注释、
// 以及 Obsidian 对属性类型的推断（日期、列表、布尔），用户下次打开笔记会发现
// 属性被重排或改类型。这里全程按行做字符串替换，只碰需要改的那几行。
//
// 只处理 frontmatter 的简单子集（key: value、key: [a, b]、以及块状「- 项」列表），
// 复杂 YAML（嵌套对象、多行字符串）不改写、原样保留。

// 文件用的换行风格：Windows 下的 Obsidian 可能写 CRLF，统一成 LF 会让整个文件 diff 全变。
export const eolOf = text => (text.includes('\r\n') ? '\r\n' : '\n');

const FM = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 拆出 frontmatter 的原始行与正文；两者都不做任何规范化。
export function split(text) {
  const eol = eolOf(text);
  const m = text.match(FM);
  if (!m) return {eol, hasFm: false, lines: [], body: text};
  return {eol, hasFm: true, lines: m[1].split(/\r?\n/), body: text.slice(m[0].length)};
}

// 一个值要不要加引号：含 YAML 里有特殊含义的字符就加双引号。
function yamlString(v) {
  const s = String(v);
  if (s === '') return "''";
  // 布尔 / 数字 / 日期这类裸标量原样写，让 Obsidian 推断成它该有的类型
  if (/^(true|false|null|~|\d+(?:\.\d+)?|\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)$/i.test(s)) return s;
  if (/^[A-Za-z一-龥][^:#\[\]{}&*!|>'"%@`,]*$/.test(s) && s.trim() === s) return s;
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// 把 key + 值渲染成一行或多行。value 为 null / undefined / 空数组 / 空字符串时返回 []，表示删除这个键。
function render(key, value, blockStyle) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    const items = value.map(v => String(v).trim()).filter(Boolean);
    if (!items.length) return [];
    return blockStyle
      ? [key + ':', ...items.map(v => '  - ' + yamlString(v))]
      : [key + ': [' + items.map(yamlString).join(', ') + ']'];
  }
  const s = String(value);
  if (s === '') return [];
  return [key + ': ' + yamlString(s)];
}

// 改写 frontmatter 里的若干键，保留其余所有行（含注释与空行）的位置和内容。
export function patchKeys(text, patch) {
  const {eol, hasFm, lines, body} = split(text);
  const out = [...lines];

  for (const [key, value] of Object.entries(patch)) {
    const re = new RegExp('^' + escapeRe(key) + '\\s*:');
    const i = out.findIndex(l => re.test(l));
    let end = i, blockStyle = false;
    if (i >= 0) {
      // 这个键后面跟着块状列表（缩进的「- 项」）时，连同那些行一起替换
      let j = i + 1;
      while (j < out.length && /^\s+-\s/.test(out[j])) j++;
      end = j - 1;
      blockStyle = j > i + 1;
    }
    const rendered = render(key, value, blockStyle);
    if (i < 0) out.push(...rendered);
    else out.splice(i, end - i + 1, ...rendered);
  }

  if (!out.length && !hasFm) return text;
  const head = out.length ? `---${eol}${out.join(eol)}${eol}---${eol}` : '';
  return head + body;
}

// 替换正文，保留 frontmatter 与文件原有的换行风格、结尾换行习惯。
export function setBody(text, newBody) {
  const {eol, hasFm, lines, body} = split(text);
  const head = hasFm ? `---${eol}${lines.join(eol)}${eol}---${eol}` : '';
  const endsWithEol = /\r?\n$/.test(body);
  const b = String(newBody == null ? '' : newBody).replace(/\r\n/g, '\n').split('\n').join(eol);
  return head + b + (endsWithEol && b && !b.endsWith(eol) ? eol : '');
}

// frontmatter 里是否已经有某个键。Obsidian 的约定是「文件名即标题」，
// 所以只有在用户已经在属性里写了 title 时，改标题才需要同时改这一行。
export const hasKey = (text, key) => split(text).lines.some(l => new RegExp('^' + escapeRe(key) + '\\s*:').test(l));

// 一次写入里同时改 frontmatter 和正文。
export function writeDoc(text, {fm = null, body = undefined} = {}) {
  let out = text;
  if (fm && Object.keys(fm).length) out = patchKeys(out, fm);
  if (body !== undefined) out = setBody(out, body);
  return out;
}

// 正文里引用的附件（Obsidian 的 ![[图.png]] 与 ![alt](路径)），用于在看板上显示「N 张图」角标。
export function attachmentsOf(body) {
  const out = new Set();
  for (const m of String(body || '').matchAll(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) out.add(m[1].trim());
  for (const m of String(body || '').matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) {
    if (!/^https?:/i.test(m[1])) out.add(decodeURIComponent(m[1].trim()));
  }
  return [...out].filter(f => /\.(png|jpe?g|gif|webp|avif|svg|bmp|pdf|mp4|mov|m4a|mp3|wav)$/i.test(f) || !/\./.test(f.split('/').pop()));
}
