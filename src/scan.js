import { walk, newStats } from './walk.js';
import { metaBatches } from './metadata.js';

/**
 * Một scan cho mỗi root, dùng chung cho mọi client.
 *
 * Tải lại trang hay mở tab thứ hai KHÔNG được sinh walker thứ hai ghi vào cùng
 * không gian id. Scan giữ lại toàn bộ message đã phát; client vào sau nhận lại
 * lịch sử rồi bám theo tiếp — đơn giản hơn nhiều so với multiplex từng chunk,
 * và message pha A chỉ là id + đường dẫn nên chi phí bộ nhớ nhỏ.
 */
export function createScanner(root, db, scanOpts = {}) {
  let run = null;

  function start() {
    const log = [];
    const waiters = new Set();
    let done = false;

    const emit = (msg) => {
      log.push(msg);
      for (const w of waiters) w();
      waiters.clear();
    };

    const promise = (async () => {
      const gen = db.beginScan();
      const stats = newStats();

      // Pha A phải ghi DB TRƯỚC khi stream: id là rowid gắn với rel, nên chỉ có
      // sau khi upsert. Đánh số đếm trong RAM là lỗi id-dịch mà plan đã bác.
      let batch = [];
      const flushA = () => {
        if (batch.length === 0) return;
        const rows = db.writable ? db.upsertBatch(batch, gen) : batch.map((b, k) => ({ ...b, i: -k }));
        emit({ t: 'a', items: rows.map(({ p, s, m, v, i }) => ({ i, p, s, m, v })) });
        batch = [];
      };

      for await (const it of walk(root, { ...scanOpts, stats })) {
        batch.push(it);
        if (batch.length >= 500) flushA();
      }
      flushA();
      emit({
        t: 'done_a',
        n: stats.files,
        skipped: stats.skippedDirs,
        bundles: stats.skippedBundles,
        dirs: stats.dirs,
        readonly: !db.writable,
      });

      if (db.writable) {
        // Chỉ chạy pha B cho file mới hoặc mtime đã đổi — đây là chỗ cache trả công
        const pending = db.pending(gen);
        for await (const rows of metaBatches(root, pending)) {
          db.writeMeta(rows);
          emit({ t: 'b', items: rows });
        }
        db.endScan(gen);
        emit({ t: 'done_b', n: pending.length });
      } else {
        emit({ t: 'done_b', n: 0, readonly: true });
      }

      done = true;
      for (const w of waiters) w();
      waiters.clear();
    })();

    promise.catch(() => {
      done = true;
      for (const w of waiters) w();
      waiters.clear();
    });

    return {
      log,
      get done() {
        return done;
      },
      wait: () => new Promise((r) => waiters.add(r)),
    };
  }

  return {
    /** Gắn vào scan đang chạy, hoặc bắt đầu scan mới nếu chưa có. */
    async *stream() {
      if (run === null || (run.done && run.log.length === 0)) run = start();
      const r = run;
      let i = 0;
      for (;;) {
        while (i < r.log.length) yield r.log[i++];
        if (r.done) return;
        await r.wait();
      }
    },
    /** Cho phép quét lại sau khi scan trước đã xong (mở lại trang, F5 muộn). */
    reset() {
      if (run?.done) run = null;
    },
  };
}
