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

function zipEntries(buf) {
  // 从尾部向前找 EOCD 签名 PK\x05\x06（注释最长 65535）
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (u32(buf, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ParseError('不是有效的 docx（找不到 zip 目录）');
  const count = u16(buf, eocd + 10);
  let off = u32(buf, eocd + 16);
  const out = new Map();
  for (let k = 0; k < count; k++) {
    if (u32(buf, off) !== 0x02014b50) throw new ParseError('docx 目录损坏');
    const method = u16(buf, off + 10);
    const csize = u32(buf, off + 20);
    const nameLen = u16(buf, off + 28);
    const extraLen = u16(buf, off + 30);
    const commentLen = u16(buf, off + 32);
    const lho = u32(buf, off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    // local header 里的名字/extra 长度可能与 central directory 不同，必须读 local 的
    const lnLen = u16(buf, lho + 26), leLen = u16(buf, lho + 28);
    const data = buf.slice(lho + 30 + lnLen + leLen, lho + 30 + lnLen + leLen + csize);
    out.set(name, method === 0 ? data : inflateRawSync(data));
    off += 46 + nameLen + extraLen + commentLen;
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
  const zip = zipEntries(buf);
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
      throw new ParseError('PDF 解析模块未安装（服务端缺少 pdfjs-dist）：' + e.message);
    }
  }
  return pdfjsLib;
}

export async function parsePdf(buf) {
  const pdfjs = await getPdfjs();
  const doc = await pdfjs.getDocument({data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true}).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    // 按 y 坐标分组拼行：同一行内的 item 用空格连，行间换行
    const rows = new Map();
    for (const item of tc.items) {
      const y = Math.round(item.transform[5] / 4) * 4;
      rows.set(y, [...(rows.get(y) || []), item.str]);
    }
    pages.push([...rows.entries()].sort((a, b) => b[0] - a[0]).map(([, parts]) => parts.join(' ').trim()).filter(Boolean).join('\n'));
  }
  await doc.destroy();
  const text = pages.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw new ParseError('PDF 没有可提取的文本（可能是扫描件/纯图片 PDF）');
  return text;
}

// —— 按扩展名分发。返回 {title, text} ——
const TEXT_EXT = new Set(['.md', '.txt', '.markdown']);
const MAX_TEXT = 50000;

export async function parseUpload(filename, buf) {
  const base = String(filename || '').replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  const ext = extname(base).toLowerCase();
  const title = base.slice(0, base.length - ext.length).trim() || '未命名文档';
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
  return {title, text};
}
