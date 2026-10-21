// 上传文档的文本提取：md/txt 直读，docx 零依赖手写 zip 解析，PDF 用 pdfjs-dist（纯 JS，无原生编译）。
// 提取出的纯文本写入个人知识库（kind: personal），随 notes 表进 FTS / embedding / RAG。
import {inflateRawSync} from 'node:zlib';
import {extname} from 'node:path';

export class ParseError extends Error {}

// —— docx：docx = zip，正文在 word/document.xml ——
// 手写最小 zip 读取：EOCD → central directory → local header → inflateRaw。
// 只支持标准 deflate/store，不支持 zip64（文档类文件足够）。
function u16(b, i) { return b[i] | (b[i + 1] << 8); }
function u32(b, i) { return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0; }

// 单个成员解压上限：zip 是「几十 KB 解出几个 GB」的经典炸弹载体，而 docx 正文
// （document.xml）正常也就几百 KB。没有上限时一个 2 MB 的上传就能把进程内存吃光。
const MAX_MEMBER = 8 * 1024 * 1024;
// 解压总量上限：只限单成员是不够的——EOCD 的成员数上限是 65535，258 个成员各解 8 MB
// 就是 2 GB。而 parseDocx 真正只用到 word/document.xml，其余成员根本没被读过。
const MAX_TOTAL = 32 * 1024 * 1024;

// 只解压需要的成员（wanted 为 null 时全部解压），并累计总量。
function zipEntries(buf, wanted = null) {
  // 从尾部向前找 EOCD 签名 PK\x05\x06（注释最长 65535）
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (u32(buf, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ParseError('不是有效的 docx（找不到 zip 目录）');
  const count = u16(buf, eocd + 10);
  let off = u32(buf, eocd + 16);
  const out = new Map();
  let total = 0;
  for (let k = 0; k < count; k++) {
    if (off + 46 > buf.length) throw new ParseError('docx 目录损坏');
    if (u32(buf, off) !== 0x02014b50) throw new ParseError('docx 目录损坏');
    const method = u16(buf, off + 10);
    const csize = u32(buf, off + 20);
    const nameLen = u16(buf, off + 28);
    const extraLen = u16(buf, off + 30);
    const commentLen = u16(buf, off + 32);
    const lho = u32(buf, off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    off += 46 + nameLen + extraLen + commentLen;
    if (wanted && !wanted.has(name)) continue; // 不读的成员连 local header 都不用管
    // local header 里的名字/extra 长度可能与 central directory 不同，必须读 local 的
    if (lho + 30 > buf.length) throw new ParseError('docx 目录损坏');
    const lnLen = u16(buf, lho + 26), leLen = u16(buf, lho + 28);
    const start = lho + 30 + lnLen + leLen;
    if (start < 0 || start > buf.length) throw new ParseError('docx 目录损坏');
    const data = buf.slice(start, Math.min(start + csize, buf.length));
    // 只支持 store(0) 与 deflate(8)：其它压缩法（bzip2/lzma/zip64）喂给 inflateRaw 只会解出垃圾
    if (method === 0) out.set(name, data);
    else if (method === 8) {
      try { out.set(name, inflateRawSync(data, {maxOutputLength: MAX_MEMBER})); }
      catch { throw new ParseError('docx 内容无法解压（文件可能损坏或过大）'); }
    } else throw new ParseError('docx 使用了不支持的压缩方式（' + method + '）');
    total += out.get(name).length;
    if (total > MAX_TOTAL) throw new ParseError('docx 内容过大（解压后超过 32 MB）');
  }
  return out;
}

const stripXml = s => s
  .replace(/<\/w:p>/g, '\n')
  .replace(/<w:br\s*\/>/g, '\n')
  .replace(/<w:tab\s*\/>/g, '\t')
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

export function parseDocx(buf) {
  // 只解压正文与内容类型两份：其余成员（图片、样式、嵌入对象）一个都不读，
  // 这样即使有人塞 258 个成员也占不了内存。
  const zip = zipEntries(buf, new Set(['word/document.xml', '[Content_Types].xml']));
  const doc = zip.get('word/document.xml');
  if (!doc) throw new ParseError('docx 里没有 word/document.xml');
  const text = stripXml(doc.toString('utf8'));
  if (!text) throw new ParseError('docx 正文为空（可能是纯图片文档）');
  return text;
}

// —— PDF：pdfjs-dist legacy build（纯 JS）——
let pdfjsLib = null;
async function getPdfjs() {
  if (!pdfjsLib) {
    try {
      pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    } catch (e) {
      // 不要把 e.message 回给客户端：里面有容器内绝对路径与依赖是否存在的信息。
      console.error('[docparse] 加载 pdfjs-dist 失败：', e.message);
      throw new ParseError('PDF 解析模块未安装（服务端缺少 pdfjs-dist）');
    }
  }
  return pdfjsLib;
}

// 页数与总字数上限：几百页的 PDF 逐页 getTextContent 会把请求挂成分钟级，
// 期间还占着上传体与内存。超上限按「已提取的部分」返回，并在结尾注明被截断。
const MAX_PAGES = 300;
const MAX_PDF_TEXT = 50000;

// 单次解析的墙钟上限：pdfjs 是同步跑在事件循环里的，畸形 PDF（坏 xref / 巨量对象）
// 能让 getTextContent 卡住好几分钟，期间 /api/health 与登录全部超时。
const PDF_BUDGET_MS = 25_000;

export async function parsePdf(buf) {
  const started = Date.now();
  const pdfjs = await getPdfjs();
  const doc = await pdfjs.getDocument({data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true}).promise;
  // destroy 必须放 finally：中途 getTextContent 抛错时原来直接 return 出去，
  // pdfjs 的 worker 与文档句柄留在内存里，传几次坏 PDF 就把进程堆满。
  try {
    const pages = [];
    let chars = 0;
    const total = Math.min(doc.numPages, MAX_PAGES);
    for (let i = 1; i <= total; i++) {
      if (Date.now() - started > PDF_BUDGET_MS) throw new ParseError('PDF 解析超时（文档结构可能有问题，请另存后重试）');
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      // 按 y 坐标分组拼行：同一行内的 item 用空格连，行间换行
      const rows = new Map();
      for (const item of tc.items) {
        const y = Math.round(item.transform[5] / 4) * 4;
        rows.set(y, [...(rows.get(y) || []), item.str]);
      }
      const pageText = [...rows.entries()].sort((a, b) => b[0] - a[0]).map(([, parts]) => parts.join(' ').trim()).filter(Boolean).join('\n');
      pages.push(pageText);
      chars += pageText.length;
      if (chars >= MAX_PDF_TEXT) break;
    }
    const text = pages.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) throw new ParseError('PDF 没有可提取的文本（可能是扫描件/纯图片 PDF）');
    return doc.numPages > MAX_PAGES ? text + `\n\n（原文档共 ${doc.numPages} 页，只提取了前 ${MAX_PAGES} 页）` : text;
  } finally {
    try { await doc.destroy(); } catch {}
  }
}

// —— 按扩展名分发。返回 {title, text} ——
const TEXT_EXT = new Set(['.md', '.txt', '.markdown']);
// Windows 保留设备名（con / prn / aux / nul / com1-9 / lpt1-9）做文件名会 EINVAL：
// 上传 con.docx 时标题是 con，createNote 写 con.md 直接 500。加下划线躲开。
const WIN_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
function safeFileStem(name) {
  const s = String(name || '').trim();
  if (!s) return '未命名文档';
  return WIN_DEVICE.test(s) ? s + '_' : s;
}
const MAX_TEXT = 50000;

export async function parseUpload(filename, buf) {
  const base = String(filename || '').replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  const ext = extname(base).toLowerCase();
  // 标题会变成笔记文件名：超长文件名在 Obsidian / Syncthing / Windows 上都会出问题
  const title = (base.slice(0, base.length - ext.length).trim() || '未命名文档').slice(0, 80).trim() || '未命名文档';
  let text;
  if (TEXT_EXT.has(ext)) {
    text = buf.toString('utf8');
  } else if (ext === '.docx') {
    text = parseDocx(buf);
  } else if (ext === '.pdf') {
    text = await parsePdf(buf);
  } else if (ext === '.doc') {
    throw new ParseError('不支持旧版 .doc，请另存为 .docx 后再上传');
  } else {
    throw new ParseError(`不支持的文件类型：${ext || '（无扩展名）'}（支持 md / txt / docx / pdf）`);
  }
  text = text.replace(/\r\n/g, '\n').trim().slice(0, MAX_TEXT);
  if (!text) throw new ParseError('文件里没有提取到文本');
  return {title: safeFileStem(title), text};
}

