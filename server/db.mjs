// 索引：SQLite（Node 24 内置的 node:sqlite，零依赖、免原生编译）。
//
// .md 文件是唯一真相 —— 这个库随时可以删掉重建，里面没有任何不可再生的东西：
// 全文索引、embedding 缓存、AI 产物暂存、任务进度，全部是派生物。
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {hostname} from 'node:os';

export const hashOf = text => createHash('sha256').update(String(text)).digest('hex').slice(0, 16);

export function openIndex(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), {recursive: true});
  const db = new DatabaseSync(file);
  // WAL 在 Docker Desktop 的 Windows/macOS 挂载卷（gRPC-FUSE/virtiofs）上会报 disk I/O error，
  // 逐条降级：容器卷挂载时全部用默认值；裸机（本机裸进程 / Linux NAS）用 WAL + NORMAL。
  let wal = true;
  try { db.exec('PRAGMA journal_mode = WAL'); } catch { wal = false; }
  if (wal) {
    try { db.exec('PRAGMA synchronous = NORMAL'); } catch {}
  } else {
    // rollback journal 模式下 NORMAL 掉电可能丢已提交事务（WAL 下不会），降级时改 FULL。
    // 这条降级原来完全静默，出问题时看不出走的是哪条路，排查极其费时。
    try { db.exec('PRAGMA journal_mode = DELETE'); } catch {}
    try { db.exec('PRAGMA synchronous = FULL'); } catch {}
    console.error('[note-api] 索引库不支持 WAL（挂载卷限制？）：改用 rollback journal + synchronous=FULL');
  }
  // 两个实例共用一个 DATA_DIR（本机调试指向 NAS 卷、或两份 compose 挂同一持久卷）时，
  // 没有 busy_timeout 的第二个连接会立刻报 database is locked（node:sqlite 是同步 API，
  // 等锁期间直接抛错），而 /api/data 就在写事务里 —— 一次抖动就把看板打成 500。
  try { db.exec('PRAGMA busy_timeout = 5000'); } catch {}
  db.exec('PRAGMA foreign_keys = ON');
  // notes_fts 是 external content 表：CREATE 出来时是空的，触发器只对之后发生的写入生效，
  // 老库里已有的 notes 行永远不会被回填，而 syncNotes 对 hash/path 没变的行不写，
  // 触发器也就永不触发 —— 结果是 FTS 永久为空，search() 静默退化成 LIKE 全表扫
  // （丢掉 rank 排序与 snippet 高亮，ask 的每个短语都变成两条 %…% 扫描）。
  const hadFts = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'notes_fts'").get();
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
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      pid INTEGER, host TEXT
    );
    CREATE TABLE IF NOT EXISTS news(
      date TEXT PRIMARY KEY, digest TEXT NOT NULL, topics TEXT NOT NULL,
      items TEXT NOT NULL, model TEXT, ideas_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS semantic_edges(
      a TEXT NOT NULL, b TEXT NOT NULL, sim REAL NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(a, b)
    );
  `);
  // 老库升级：jobs 表补「谁在跑」两列。CREATE TABLE IF NOT EXISTS 不会给已存在的表加列，
  // 只能逐条 ALTER；列已存在时 SQLite 报错，忽略即可。news.ideas_at 是后来才加的列，
  // 老库缺它会让 /api/news 与日报生成永久 500（no such column: ideas_at），重启也不复原。
  for (const sql of ['ALTER TABLE jobs ADD COLUMN pid INTEGER', 'ALTER TABLE jobs ADD COLUMN host TEXT', 'ALTER TABLE news ADD COLUMN ideas_at TEXT']) {
    try { db.exec(sql); } catch {}
  }
  if (!hadFts) { try { db.exec("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')"); } catch {} }
  return new Index(db);
}

const now = () => new Date().toISOString();

// JSON 列的统一读取口：一行坏数据不该把整个功能打成永久 500。
// 坏行返回空数组（列表类字段）或 null（对象字段），下次写入会覆盖它。
const parseArr = s => {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
};

class Index {
  constructor(db) { this.db = db; }

  close() { try { this.db.close(); } catch {} }

  // 把当前笔记库同步进索引：新增、改动的写入，消失的删掉。返回变更条数。
  //
  // prune=false 用于「这一轮有文件没读出来」的情况（SMB 抖动、被独占、权限）：少读到一篇
  // 不等于它被删了，这时只增只改、不做批量清扫，否则一次抖动就会把那一篇的向量、AI 摘要
  // 与全部语义边永久删掉（下次 relate 要全量重算 embedding、next analyze 要重烧 token）。
  syncNotes(rows, {prune = true} = {}) {
    const existing = new Map(this.db.prepare('SELECT id, hash, path, title, kind FROM notes').all().map(r => [r.id, r]));
    const ins = this.db.prepare('INSERT INTO notes(id,path,title,kind,body,hash,mtime,indexed_at) VALUES(?,?,?,?,?,?,?,?)');
    const upd = this.db.prepare('UPDATE notes SET path=?,title=?,kind=?,body=?,hash=?,mtime=?,indexed_at=? WHERE id=?');
    const del = this.db.prepare('DELETE FROM notes WHERE id=?');
    const seen = new Set();
    // id 不变但内容变了 / 这一篇没了：挂在它上面的边、向量、AI 摘要全部过期。
    // id 不变只是 path 或标题变了（位置 id 位移、改了 title frontmatter）：边必须作废
    // （边是纯 id 对，会连到别的节点上），但向量与 AI 摘要按内容 hash 校验，仍然有效 ——
    // 原来这两类混在一起清，插一篇笔记就把全库的 embeddings / ai_cache / 语义边清空。
    const dropped = [];
    const relocated = [];
    let changed = 0;
    // BEGIN 也放进 try：连接已经处于事务里（上一次异常没回滚干净）时，BEGIN 会抛
    // cannot start a transaction within a transaction，那时再 ROLLBACK 会把外层的
    // 事务一起掀掉 —— 索引从此永久不更新，而 /api/data 只打一行日志，没人会发现。
    let open = false;
    try {
      this.db.exec('BEGIN');
      open = true;
      for (const r of rows) {
        seen.add(r.id);
        const cur = existing.get(r.id);
        if (!cur) { ins.run(r.id, r.path, r.title, r.kind, r.body, r.hash, r.mtime, now()); changed++; }
        else if (cur.hash !== r.hash) {
          upd.run(r.path, r.title, r.kind, r.body, r.hash, r.mtime, now(), r.id);
          changed++;
          dropped.push(r.id);
        } else if (cur.path !== r.path || cur.title !== r.title || cur.kind !== r.kind) {
          // 只改 title（正文没动）时 hash 不变 —— 原来这一整类改动都被吞掉，
          // /api/search 的结果标题与 ask 喂给模型的标题长期是旧值。
          upd.run(r.path, r.title, r.kind, r.body, r.hash, r.mtime, now(), r.id);
          changed++;
          relocated.push(r.id);
        }
      }
      for (const id of existing.keys()) if (!seen.has(id)) { del.run(id); changed++; dropped.push(id); }
      const dropEdge = this.db.prepare('DELETE FROM semantic_edges WHERE a = ? OR b = ?');
      const dropVec = this.db.prepare('DELETE FROM embeddings WHERE note_id = ?');
      const dropCache = this.db.prepare('DELETE FROM ai_cache WHERE note_id = ?');
      for (const id of [...dropped, ...relocated]) dropEdge.run(id, id);
      for (const id of dropped) { dropVec.run(id); dropCache.run(id); }
      if (prune) {
        // 笔记删掉后，指向它的语义边也一起清掉，避免 /api/data 带着悬空 id。
        this.db.prepare('DELETE FROM semantic_edges WHERE a NOT IN (SELECT id FROM notes) OR b NOT IN (SELECT id FROM notes)').run();
        // embeddings / ai_cache 同理：已删笔记的向量还会参与 relate 的两两余弦，
        // 产出的悬空边挤占「最多 400 条」的预算，把真实边挤出去。
        this.db.prepare('DELETE FROM embeddings WHERE note_id NOT IN (SELECT id FROM notes)').run();
        this.db.prepare('DELETE FROM ai_cache WHERE note_id NOT IN (SELECT id FROM notes)').run();
      }
      this.db.exec('COMMIT');
      open = false;
    } catch (e) {
      if (open) { try { this.db.exec('ROLLBACK'); } catch {} }
      throw e;
    }
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
    // LIKE 兜底必须转义通配符：原来 search('%') / search('_%_') 直接返回全表
    // （用户搜「100%」这类词会把整个库当成命中）。
    const like = '%' + term.replace(/[\\%_]/g, '\\$&') + '%';
    return this.db.prepare(`SELECT id, title, kind, path, substr(body, 1, 120) AS snip
      FROM notes WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' LIMIT ?`)
      .all(like, like, limit);
  }

  note(id) { return this.db.prepare('SELECT id, path, title, kind, body, hash, mtime FROM notes WHERE id = ?').get(id) || null; }
  allNotes(withBody = false) {
    return this.db.prepare(`SELECT id, path, title, kind, hash, mtime${withBody ? ', body' : ''} FROM notes ORDER BY kind, path`).all();
  }
  count() { return this.db.prepare('SELECT COUNT(*) AS n FROM notes').get().n; }

  // —— AI 产物缓存：按内容 hash 判断是否要重算，避免每次全量烧 token ——
  // 这里的 JSON.parse 全部带兜底：一行坏数据（手工改库、旧版本写下的不兼容结构）原来会让
  // aiCache() 整体抛出，而它是 /api/ai/analyze 与 /api/ai/relate 进路由后的第一行，
  // 于是这两个接口永久 500 且不会自愈。坏行退化成 null，下次 putAi 会覆盖它。
  aiCache() {
    const out = new Map();
    for (const r of this.db.prepare('SELECT note_id, hash, tags, summary FROM ai_cache').all()) {
      let tags = null;
      try { tags = r.tags ? JSON.parse(r.tags) : null; } catch {}
      out.set(r.note_id, {...r, tags});
    }
    return out;
  }
  putAi(noteId, hash, tags, summary) {
    this.db.prepare(`INSERT INTO ai_cache(note_id, hash, tags, summary, updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(note_id) DO UPDATE SET hash=excluded.hash, tags=excluded.tags, summary=excluded.summary, updated_at=excluded.updated_at`)
      .run(noteId, hash, tags ? JSON.stringify(tags) : null, summary || null, now());
  }

  // —— embedding：存 Float32Array 的 BLOB，个人笔记库规模直接暴力算余弦，不需要向量数据库 ——
  putEmbedding(noteId, model, vec, hash) {
    const buf = Buffer.from(new Float32Array(vec).buffer);
    // 换 embedding 模型后旧向量永远不会被读到（embeddings() 按 model 过滤），但会一直占着
    // 1536×N×4 字节的 BLOB。同一篇只保留当前模型的向量。
    try { this.db.prepare('DELETE FROM embeddings WHERE note_id = ? AND model <> ?').run(noteId, model); } catch {}
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

  // —— AI 热点日报：date（YYYY-MM-DD）主键，一天一份 ——
  getNews(date) {
    const r = this.db.prepare('SELECT * FROM news WHERE date = ?').get(date);
    if (!r) return null;
    return {...r, topics: parseArr(r.topics), items: parseArr(r.items)};
  }
  putNews(date, {digest, topics, items, model, ideasAt, clearIdeasAt}) {
    this.db.prepare(`INSERT INTO news(date, digest, topics, items, model, ideas_at, created_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(date) DO UPDATE SET digest=excluded.digest, topics=excluded.topics, items=excluded.items, model=excluded.model, ideas_at=COALESCE(excluded.ideas_at, news.ideas_at), created_at=excluded.created_at`)
      .run(date, digest, JSON.stringify(topics), JSON.stringify(items), model || null, ideasAt || null, now());
    // COALESCE 保住了「未提供就别覆盖」，但也让 ideas_at 永远清不掉：日报被 forceRefresh
    // 整份重生成后，旧标记还在，新日报就永远轮不到自动筛选题。需要一个显式的清空通道。
    if (clearIdeasAt) this.db.prepare('UPDATE news SET ideas_at = NULL WHERE date = ?').run(date);
  }
  listNews(limit = 14, withItems = false) {
    return this.db.prepare(`SELECT date, digest, topics, model, ideas_at, created_at${withItems ? ', items' : ''} FROM news ORDER BY date DESC LIMIT ?`).all(limit)
      .map(r => ({...r, topics: parseArr(r.topics), ideasAt: r.ideas_at || null, items: r.items ? parseArr(r.items) : undefined}));
  }

  // —— 语义边：/api/ai/relate 的产物，持久化后刷新页面仍然有效 ——
  replaceSemantic(edges = []) {
    // BEGIN 也放进 try：连接已经处于事务里（上一次异常没回滚干净）时，BEGIN 会抛
    // cannot start a transaction within a transaction，那时再 ROLLBACK 会把外层的
    // 事务一起掀掉 —— 索引从此永久不更新，而 /api/data 只打一行日志，没人会发现。
    let open = false;
    try {
      this.db.exec('BEGIN');
      open = true;
      this.db.prepare('DELETE FROM semantic_edges').run();
      const ins = this.db.prepare('INSERT OR REPLACE INTO semantic_edges(a, b, sim, created_at) VALUES(?,?,?,?)');
      for (const e of edges) if (e?.a && e?.b) ins.run(e.a, e.b, Number(e.sim) || 0, now());
      this.db.exec('COMMIT');
      open = false;
    } catch (e) {
      if (open) { try { this.db.exec('ROLLBACK'); } catch {} }
      throw e;
    }
  }
  semanticEdges() {
    return this.db.prepare('SELECT a, b, sim FROM semantic_edges ORDER BY sim DESC').all();
  }

  // —— 任务进度：AI 调用是秒级到几十秒级，不能同步阻塞 HTTP ——
  createJob(id, kind, total) {
    this.db.prepare('INSERT INTO jobs(id, kind, status, total, done, created_at, updated_at, pid, host) VALUES(?,?,?,?,0,?,?,?,?)')
      .run(id, kind, 'running', total, now(), now(), process.pid, hostname());
  }
  updateJob(id, patch) {
    const j = this.job(id);
    if (!j) return;
    // 晚到的进度回调不能把已经结束的任务改回 running：原来 running 直接覆盖 done/error，
    // 前端轮询看到「又在跑」于是一直等不到终态（取消后尤其明显）。
    const settled = j.status === 'done' || j.status === 'error';
    const status = settled && patch.status === 'running' ? j.status : (patch.status ?? j.status);
    this.db.prepare('UPDATE jobs SET status=?, done=?, message=?, error=?, result=?, updated_at=? WHERE id=?')
      .run(status, patch.done ?? j.done, patch.message ?? j.message, patch.error ?? j.error,
        patch.result !== undefined ? (patch.result == null ? null : JSON.stringify(patch.result)) : j.result, now(), id);
  }
  // 任务结果只在轮询那几秒有用：一直留着会无限占 /data（relate 一次几百条边、analyze 是全量逐篇结果）
  pruneJobs(maxAgeMs = 24 * 3600 * 1000) {
    // 按 updated_at 而不是 created_at：一个跑了 40 分钟的大任务在「创建 24 小时后」才删是
    // 对的，但反过来，一行的 last write 才是有意义的时间戳（createJob 与 updateJob 都会刷新它）。
    try { this.db.prepare('DELETE FROM jobs WHERE updated_at < ?').run(new Date(Date.now() - maxAgeMs).toISOString()); }
    catch {}
  }
  job(id) {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    if (!r) return null;
    let result = null;
    try { result = r.result ? JSON.parse(r.result) : null; } catch {}
    return {...r, result};
  }
  // 进程被杀 / 容器重启时内存里的单任务闸消失，但表里那行还是 running：前端轮询会一直
  // 等到超时，既看不到失败原因也没法重试。启动时把「已经死掉的实例」留下的行收口成 error。
  //
  // 不能无条件 UPDATE 所有 running：两个 note-api 共用一个 DATA_DIR（本机调试指向 NAS 卷、
  // 或两份 compose 挂同一持久卷）时，后启动的实例会把另一个实例正在跑的任务标成失败，
  // 前端立刻显示失败，而那个任务几秒后又写回 done——UI 与真实状态来回抖。
  // 所以按创建时记下的 pid + host 判断：host 不同（另一台机器 / 另一个容器）不碰；
  // 同 host 上 pid 还活着说明那个进程仍在跑，也不碰；其余（pid 已退出、老库没有 pid）才收口。
  failRunningJobs(reason = '服务重启中断', staleMs = 15 * 60 * 1000) {
    const alive = pid => {
      if (!pid) return false;
      try { process.kill(pid, 0); return true; }
      catch (e) { return e.code === 'EPERM'; } // 进程存在但不归我们管
    };
    try {
      const me = hostname();
      const cutoff = new Date(Date.now() - staleMs).toISOString();
      const rows = this.db.prepare("SELECT id, pid, host, updated_at FROM jobs WHERE status='running'").all();
      const stmt = this.db.prepare("UPDATE jobs SET status='error', error=?, message=?, updated_at=? WHERE id=? AND status='running'");
      let n = 0;
      for (const r of rows) {
        // 心跳判据：pid/host 两个判据在容器里会失灵 —— compose 只设了 container_name、
        // 没设 hostname，重建后容器 hostname 是新的随机 ID，旧行的 host 永远对不上，
        // 那一行就永远不会被收口。updateJob 每次进度都会刷新 updated_at，
        // 而 AI_TIMEOUT 默认 60s，15 分钟没有进度就一定是死任务。
        const stale = !r.updated_at || r.updated_at < cutoff;
        if (!stale) {
          if (r.host && r.host !== me) continue;          // 另一台机器 / 容器上的实例，无从判断
          // 同机仍活着的进程（含本进程自己）在跑：不碰。原来的 `r.pid !== process.pid` 把
          // 本进程自己的长任务排除在「活着」之外，10 分钟一次的收口会把还在跑的 analyze/relate
          // 打成 error（前端判失败、用户重试还会重复烧 token）。pid 复用由上面的 stale 兜住。
          if (alive(r.pid)) continue;
        }
        n += stmt.run(reason, reason, now(), r.id).changes;
      }
      return n;
    } catch { return 0; }
  }
  // 进程退出前把自己正在跑的行落到终态：只动本进程建的行，不能碰共用 DATA_DIR 的另一个实例
  failMyJobs(reason = '服务停止中断') {
    try {
      return this.db.prepare("UPDATE jobs SET status='error', error=?, message=?, updated_at=? WHERE status='running' AND pid = ? AND host = ?")
        .run(reason, reason, now(), process.pid, hostname()).changes;
    } catch { return 0; }
  }
}

// 余弦相似度。向量都已归一化时等同于点积，这里仍然按定义算，免得依赖调用方。
export function cosine(a, b) {
  // 维度不同的两个向量没有可比性：按较短的那个循环只会得到「前 N 维的点积 / 各自模长」，
  // 于是一个 4 维向量能和 16 维向量算出 0.97 的假相似度（实测）。宁可当 0 处理。
  //
  // 注意：embeddings() 取出来的 vec 是 Float32Array（BLOB 直接映射，省一次拷贝），
  // 而 Array.isArray(Float32Array) 是 false —— 只认 Array 会让**每一对**都算成 0：
  // 语义关联任务「跑完了」但一条边都没有，问答的向量召回也永远静默降级成纯关键词。
  // 所以这里必须接受 ArrayBuffer 视图（Float32Array 等）。
  const isVec = v => Array.isArray(v) || (ArrayBuffer.isView(v) && !(v instanceof DataView));
  if (!isVec(a) || !isVec(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
