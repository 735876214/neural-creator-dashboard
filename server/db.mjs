// 索引：SQLite（Node 24 内置的 node:sqlite，零依赖、免原生编译）。
//
// .md 文件是唯一真相 —— 这个库随时可以删掉重建，里面没有任何不可再生的东西：
// 全文索引、embedding 缓存、AI 产物暂存、任务进度，全部是派生物。
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';

export const hashOf = text => createHash('sha256').update(String(text)).digest('hex').slice(0, 16);

export function openIndex(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), {recursive: true});
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  // 全文索引用 trigram 分词器：中文不需要 jieba 之类的原生依赖就能做子串检索。
  // 代价是查询词至少 3 个字符，短词由 search() 退回 LIKE。
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes(
      id TEXT PRIMARY KEY, path TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL,
      body TEXT NOT NULL, hash TEXT NOT NULL, mtime TEXT NOT NULL, indexed_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      title, body, content='notes', content_rowid='rowid', tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
      INSERT INTO notes_fts(rowid, title, body) VALUES(new.rowid, new.title, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
    END;
    CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
      INSERT INTO notes_fts(rowid, title, body) VALUES(new.rowid, new.title, new.body);
    END;
    CREATE TABLE IF NOT EXISTS embeddings(
      note_id TEXT PRIMARY KEY, model TEXT NOT NULL, dim INTEGER NOT NULL, vec BLOB NOT NULL, hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_cache(
      note_id TEXT PRIMARY KEY, hash TEXT NOT NULL, tags TEXT, summary TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs(
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
      total INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0,
      message TEXT, error TEXT, result TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  return new Index(db);
}

const now = () => new Date().toISOString();

class Index {
  constructor(db) { this.db = db; }

  close() { try { this.db.close(); } catch {} }

  // 把当前笔记库同步进索引：新增、改动的写入，消失的删掉。返回变更条数。
  syncNotes(rows) {
    const existing = new Map(this.db.prepare('SELECT id, hash FROM notes').all().map(r => [r.id, r.hash]));
    const ins = this.db.prepare('INSERT INTO notes(id,path,title,kind,body,hash,mtime,indexed_at) VALUES(?,?,?,?,?,?,?,?)');
    const upd = this.db.prepare('UPDATE notes SET path=?,title=?,kind=?,body=?,hash=?,mtime=?,indexed_at=? WHERE id=?');
    const del = this.db.prepare('DELETE FROM notes WHERE id=?');
    const seen = new Set();
    let changed = 0;
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        seen.add(r.id);
        if (!existing.has(r.id)) { ins.run(r.id, r.path, r.title, r.kind, r.body, r.hash, r.mtime, now()); changed++; }
        else if (existing.get(r.id) !== r.hash) { upd.run(r.path, r.title, r.kind, r.body, r.hash, r.mtime, now(), r.id); changed++; }
      }
      for (const id of existing.keys()) if (!seen.has(id)) { del.run(id); changed++; }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return changed;
  }

  // 全文检索。trigram 索引要 3 个字符以上才命中，更短的查询（常见的中文两字词）退回 LIKE。
  search(q, limit = 20) {
    const term = String(q || '').trim();
    if (!term) return [];
    if ([...term].length >= 3) {
      try {
        const rows = this.db.prepare(`SELECT n.id, n.title, n.kind, n.path,
            snippet(notes_fts, 1, '', '', '…', 16) AS snip
          FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
          WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?`)
          .all('"' + term.replace(/"/g, '""') + '"', limit);
        if (rows.length) return rows;
      } catch { /* 查询串里有 FTS 语法时退回 LIKE */ }
    }
    return this.db.prepare(`SELECT id, title, kind, path, substr(body, 1, 120) AS snip
      FROM notes WHERE title LIKE ? OR body LIKE ? LIMIT ?`)
      .all('%' + term + '%', '%' + term + '%', limit);
  }

  note(id) { return this.db.prepare('SELECT id, path, title, kind, body, hash, mtime FROM notes WHERE id = ?').get(id) || null; }
  allNotes(withBody = false) {
    return this.db.prepare(`SELECT id, path, title, kind, hash, mtime${withBody ? ', body' : ''} FROM notes ORDER BY kind, path`).all();
  }
  count() { return this.db.prepare('SELECT COUNT(*) AS n FROM notes').get().n; }

  // —— AI 产物缓存：按内容 hash 判断是否要重算，避免每次全量烧 token ——
  aiCache() { return new Map(this.db.prepare('SELECT note_id, hash, tags, summary FROM ai_cache').all().map(r => [r.note_id, {...r, tags: r.tags ? JSON.parse(r.tags) : null}])); }
  putAi(noteId, hash, tags, summary) {
    this.db.prepare(`INSERT INTO ai_cache(note_id, hash, tags, summary, updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(note_id) DO UPDATE SET hash=excluded.hash, tags=excluded.tags, summary=excluded.summary, updated_at=excluded.updated_at`)
      .run(noteId, hash, tags ? JSON.stringify(tags) : null, summary || null, now());
  }

  // —— embedding：存 Float32Array 的 BLOB，个人笔记库规模直接暴力算余弦，不需要向量数据库 ——
  putEmbedding(noteId, model, vec, hash) {
    const buf = Buffer.from(new Float32Array(vec).buffer);
    this.db.prepare(`INSERT INTO embeddings(note_id, model, dim, vec, hash) VALUES(?,?,?,?,?)
      ON CONFLICT(note_id) DO UPDATE SET model=excluded.model, dim=excluded.dim, vec=excluded.vec, hash=excluded.hash`)
      .run(noteId, model, vec.length, buf, hash);
  }
  embeddings(model) {
    const out = [];
    for (const r of this.db.prepare('SELECT note_id, dim, vec, hash FROM embeddings WHERE model = ?').all(model)) {
      out.push({id: r.note_id, hash: r.hash, vec: new Float32Array(r.vec.buffer, r.vec.byteOffset, r.dim)});
    }
    return out;
  }

  // —— 任务进度：AI 调用是秒级到几十秒级，不能同步阻塞 HTTP ——
  createJob(id, kind, total) {
    this.db.prepare('INSERT INTO jobs(id, kind, status, total, done, created_at, updated_at) VALUES(?,?,?,?,0,?,?)')
      .run(id, kind, 'running', total, now(), now());
  }
  updateJob(id, patch) {
    const j = this.job(id);
    if (!j) return;
    this.db.prepare('UPDATE jobs SET status=?, done=?, message=?, error=?, result=?, updated_at=? WHERE id=?')
      .run(patch.status ?? j.status, patch.done ?? j.done, patch.message ?? j.message, patch.error ?? j.error,
        patch.result !== undefined ? (patch.result == null ? null : JSON.stringify(patch.result)) : j.result, now(), id);
  }
  job(id) {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    if (!r) return null;
    return {...r, result: r.result ? JSON.parse(r.result) : null};
  }
}

// 余弦相似度。向量都已归一化时等同于点积，这里仍然按定义算，免得依赖调用方。
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
