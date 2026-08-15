#!/usr/bin/env node
// Đo throughput pha B trên file thật rồi ngoại suy 70k — chạy TRƯỚC khi cam kết
// bất kỳ con số nào. Dùng: node scripts/bench-metadata.js ~/Pictures [số file]
import os from 'node:os';
import path from 'node:path';
import { walk } from '../src/walk.js';
import { metaBatches } from '../src/metadata.js';

const root = path.resolve(process.argv[2] ?? path.join(os.homedir(), 'Pictures'));
const limit = Number(process.argv[3] ?? 1000);

// Lấy mẫu ngẫu nhiên toàn cây (reservoir), KHÔNG lấy N file đầu: các thư mục
// đầu của Photos Library toàn thumbnail nội bộ không có EXIF → số đo lệch hẳn.
const rows = [];
let total = 0;
for await (const it of walk(root, { includeBundles: true })) {
  const row = { id: total, rel: it.p, kind: it.v, mtime: it.m };
  if (rows.length < limit) rows.push(row);
  else {
    const j = Math.floor(Math.random() * (total + 1));
    if (j < limit) rows[j] = row;
  }
  total++;
}
const videos = rows.filter((r) => r.kind === 1).length;
const images = rows.length - videos;

const t0 = performance.now();
let done = 0;
let withExif = 0;
for await (const b of metaBatches(root, rows)) {
  done += b.length;
  withExif += b.filter((r) => r.ds === 0).length;
}
const ms = performance.now() - t0;

const perFile = ms / done;
console.log(
  JSON.stringify(
    {
      sampledFrom: total,
      files: done,
      images,
      videos,
      videoShare: +(videos / rows.length).toFixed(3),
      concurrency: os.cpus().length,
      totalMs: Math.round(ms),
      msPerFile: +perFile.toFixed(2),
      exifHitRate: +(withExif / done).toFixed(3),
      extrapolated70k: `${((perFile * 70000) / 1000 / 60).toFixed(1)} phút`,
      budget: '3 phút',
    },
    null,
    2,
  ),
);
