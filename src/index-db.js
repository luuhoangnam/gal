import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS media(
  id INTEGER PRIMARY KEY,
  rel TEXT NOT NULL UNIQUE,
  size INTEGER, mtime INTEGER,
  kind INTEGER,
  w INTEGER, h INTEGER, orient INTEGER,
  taken INTEGER,
  date_src INTEGER,
  dur REAL, dir TEXT,
  seen INTEGER
);
CREATE INDEX IF NOT EXISTS ix_taken ON media(taken);
CREATE INDEX IF NOT EXISTS ix_dir   ON media(dir);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v INTEGER);
`;

/** cacheDir đã là duy nhất theo root (xem cache-dir.js), nên tên file cố định. */
export function dbPathFor(cacheDir) {
  return path.join(cacheDir, 'index.db');
}

/**
 * Lockfile khuyến nghị: tiến trình thứ hai trên cùng root chỉ đọc, không chạy pha B.
 * Chứa pid; pid chết thì lock coi như bỏ (crash không khoá vĩnh viễn thư viện).
 */
function tryLock(lockPath) {
  try {
    const pid = Number(readFileSync(lockPath, 'utf8'));
    process.kill(pid, 0); // ném nếu tiến trình đã chết
    return false;
  } catch (err) {
    if (err?.code === 'EPERM') return false; // pid của user khác, còn sống
  }
  writeFileSync(lockPath, String(process.pid));
  return true;
}

export function openIndex(cacheDir) {
  const file = dbPathFor(cacheDir);
  mkdirSync(path.dirname(file), { recursive: true });

  const db = new DatabaseSync(file);
  // Mặc định là journal_mode=delete: writer thứ hai ném ERR_SQLITE_ERROR NGAY,
  // không chờ. Mở hai cửa sổ terminal cùng root là gặp.
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA busy_timeout=5000');
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec(SCHEMA);

  const lockPath = file.replace(/\.db$/, '.lock');
  const writable = tryLock(lockPath);

  const q = {
    upsert: db.prepare(`
      INSERT INTO media(rel, size, mtime, kind, dir, seen)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(rel) DO UPDATE SET size=excluded.size, mtime=excluded.mtime,
        kind=excluded.kind, seen=excluded.seen,
        -- mtime đổi = file khác: xoá metadata cũ để pha B chạy lại đúng file này
        date_src=CASE WHEN media.mtime = excluded.mtime THEN media.date_src ELSE NULL END
      RETURNING id, taken, w, h, orient, dur, date_src`),
    setMeta: db.prepare(
      `UPDATE media SET w=?, h=?, orient=?, taken=?, date_src=?, dur=? WHERE id=?`,
    ),
    pending: db.prepare(
      `SELECT id, rel, kind, mtime FROM media WHERE seen=? AND date_src IS NULL`,
    ),
    all: db.prepare(
      `SELECT id, rel AS p, size AS s, mtime AS m, kind AS v, w, h, orient, taken, date_src AS ds, dur
       FROM media WHERE seen=? ORDER BY taken DESC, id DESC`),
    sweep: db.prepare(`DELETE FROM media WHERE seen < ?`),
    getGen: db.prepare(`SELECT v FROM meta WHERE k='gen'`),
    setGen: db.prepare(`INSERT INTO meta(k,v) VALUES('gen',?)
                        ON CONFLICT(k) DO UPDATE SET v=excluded.v`),
    count: db.prepare(`SELECT COUNT(*) n FROM media WHERE seen=?`),
  };

  let gen = q.getGen.get()?.v ?? 0;

  return {
    file,
    writable,
    /** Generation của lần scan trước — dùng để nạp cache render ngay. */
    get lastGen() {
      return gen;
    },
    cachedCount: () => q.count.get(gen)?.n ?? 0,
    cached: () => q.all.all(gen),

    /** Bắt đầu một scan mới; hàng nào không được `seen` là file đã mất. */
    beginScan() {
      if (!writable) return gen; // chỉ đọc: giữ nguyên generation đang có
      gen += 1;
      return gen;
    },

    /**
     * Ghi lô pha A và trả id ỔN ĐỊNH cho từng item. Id là rowid gắn với `rel`,
     * không phải thứ tự phát hiện — thêm/xoá file không làm id dịch.
     */
    upsertBatch(items, scanGen) {
      const out = [];
      db.exec('BEGIN');
      try {
        for (const it of items) {
          const r = q.upsert.get(
            it.p,
            it.s,
            it.m,
            it.v,
            path.dirname(it.p) === '.' ? '' : path.dirname(it.p),
            scanGen,
          );
          out.push({ ...it, i: r.id, cached: r.date_src !== null ? r : null });
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return out;
    },

    /** File chưa có metadata (mới, hoặc mtime đã đổi). */
    pending: (scanGen) => q.pending.all(scanGen),

    writeMeta(rows) {
      db.exec('BEGIN');
      try {
        for (const r of rows) {
          q.setMeta.run(r.w, r.h, r.orient, r.taken, r.ds, r.dur, r.i);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    /** Kết thúc scan: xoá hàng của generation cũ (file đã bị xoá khỏi đĩa). */
    endScan(scanGen) {
      if (!writable) return;
      q.sweep.run(scanGen);
      q.setGen.run(scanGen);
      gen = scanGen;
    },

    close() {
      try {
        db.close();
      } finally {
        if (writable) {
          try {
            unlinkSync(lockPath);
          } catch {
            /* đã bị dọn */
          }
        }
      }
    },
  };
}
