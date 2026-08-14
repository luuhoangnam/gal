---
phase: 3
title: "Metadata pass + SQLite index"
status: pending
priority: P1
effort: "2d"
dependencies: [2]
---

# Phase 3: Metadata pass + SQLite index

## Overview

Pha B: đọc kích thước và **ngày chụp thật** của từng file, stream patch về client trong khi grid
đã hiển thị. Lưu index vào SQLite để lần mở sau tức thì.

Đây là phase kỹ thuật khó nhất ở backend, và là nơi research đã bác bỏ hai giả định phổ biến.

## Requirements

**Functional**
- Ảnh: width, height, `DateTimeOriginal`, orientation
- Video: width, height, `creation_time`, duration
- Không có EXIF → rơi về `mtime`, đánh dấu `dateSource` để UI có thể phân biệt
- Stream patch NDJSON theo lô trong khi pha B chạy
- Lưu vào SQLite; mở lại cùng root → nạp từ cache, chạy pha A nền để phát hiện thay đổi

**Non-functional**
- 70k file dưới 3 phút (nếu vượt, kiến trúc sai — xem Risk)
- Không giữ toàn bộ metadata trong RAM

## Architecture

### Ảnh — `exifreader`, tuyệt đối không `exifr`

`exifr` hard-code `if (ftyp_box_size > 50) return false`. HEIC iPhone hiện đại có 9 compatible
brand = box size 52 → **luôn fail**. Đã xác nhận bằng đọc source `full.umd.js` class `ze.canHandle`
và issue #138. Đây không phải lỗi cấu hình, là lỗi thư viện.

`exifreader` 4.42.0 (cập nhật 2026-08-05, còn sống) đọc đúng HEIC/JPEG/PNG, pure JS.

**Đọc progressive, không đọc cả file:** thử 64KB trước; nếu thiếu field cần thì đọc 128KB.
Đo thật: HEIC iPhone cần ≥131072 byte vì `meta` box nằm sau `hdlr`/`iloc`/`iinf`/`iref`/`iprp`.
Không có hằng số cố định cho mọi file — retry rẻ vì đọc từ đĩa local.

Dimension: `image-size` v2 (đo thật: HEIC 0,3-0,4ms kể cả file 228 tile, JPEG 0,12ms).
Nó đọc `ispe` box nên không bị ảnh hưởng bởi số tile — khác hẳn ffprobe.

### Video — tự viết box-walker, **không** ffprobe

ffprobe tốn ~25ms mỗi lần spawn (đo thật, 10 lần liên tiếp). 70k file = **29 phút tuần tự**.
Chi phí nằm ở spawn process, không ở việc đọc file.

`.mov` iPhone đặt `moov` ở **cuối file** (đo thật: offset 2.981.647 trên file 2,99MB) — nên
"đọc N KB đầu" không dùng được. Phải quét top-level box: đọc 8-16 byte header, `seek` qua
`mdat` mà không đọc nội dung, tới khi gặp `moov` rồi đọc riêng box đó (~13KB).

Đường đi trong box: `moov` → `mvhd` (creation_time, timescale, duration) và
`moov/trak/mdia/minf/stbl/stsd` (width/height) hoặc `trak/tkhd` (kích thước hiển thị, có matrix xoay).
Lưu ý `tkhd` matrix quyết định video quay dọc — bỏ qua sẽ hiển thị sai tỉ lệ toàn bộ video iPhone.

Thời gian trong ISO-BMFF tính từ **1904-01-01**, không phải Unix epoch. Lệch 2.082.844.800 giây.

### Index — `node:sqlite` builtin

Đo thật: 70k insert trong transaction = 31ms; query khoảng ngày có index = 1ms.
Không cần `better-sqlite3` (native module sẽ phá vỡ "không cài đặt thủ công").

```sql
CREATE TABLE media(
  id INTEGER PRIMARY KEY, rel TEXT NOT NULL, size INTEGER, mtime INTEGER,
  kind INTEGER,              -- 0 ảnh, 1 video
  w INTEGER, h INTEGER, orient INTEGER,
  taken INTEGER,             -- epoch ms, ngày chụp
  date_src INTEGER,          -- 0 exif, 1 mtime
  dur REAL, dir TEXT
);
CREATE INDEX ix_taken ON media(taken);
CREATE INDEX ix_dir   ON media(dir);
```

DB đặt tại `~/.cache/gal/index/<sha1(realpath(root))>.db`.

**Invalidation khi mở lại:** nạp cache render ngay, rồi chạy pha A nền so sánh.
File mới → chạy pha B cho riêng chúng. File mất → xoá khỏi grid. Không cần FSEvents/watchman
cho v1 vì walk chỉ tốn <1s.

## Related Code Files

- Create: `src/metadata.js` (điều phối), `src/exif-image.js`, `src/box-walker.js`, `src/index-db.js`
- Modify: `src/server.js` (pha B stream tiếp trên `/api/scan`)
- Create: `test/box-walker.test.js`, `test/exif-image.test.js`, `test/index-db.test.js`
- Create: `scripts/bench-metadata.js` (đo throughput trên mẫu 1000 file thật)

## Implementation Steps

1. **Viết `box-walker.js` trước và benchmark ngay** — đây là phần chưa ai đo, đừng để cuối.
   Parse: `ftyp`, quét top-level tìm `moov`, đọc `mvhd` (version 0/1 khác độ rộng field),
   duyệt `trak` lấy `tkhd` (matrix + width/height fixed-point 16.16).
2. `exif-image.js`: `readChunk(path, 0, 65536)` → `ExifReader.load` → thiếu thì thử 131072.
   Kết hợp `image-size` cho dims. Áp orientation vào tỉ lệ (orientation 5-8 đảo w/h).
3. `index-db.js`: schema trên, prepared statement, insert theo transaction lô 1000.
4. `metadata.js`: pool đồng thời (`os.cpus().length`), phát patch theo lô.
5. Format patch NDJSON: `{"t":"b","items":[{"i":0,"w":4032,"h":3024,"taken":1699,"ds":0},...]}`
6. `scripts/bench-metadata.js` chạy trên 1000 file thật từ `~/Pictures`, in throughput —
   **chạy trước khi cam kết con số 3 phút.**

## Success Criteria

- [ ] `box-walker` lấy đúng width/height/creation_time/duration từ `.mov` iPhone gốc và `.mp4` faststart
- [ ] Video quay dọc hiển thị đúng tỉ lệ (matrix `tkhd` được áp)
- [ ] Thời gian ISO-BMFF quy đổi đúng (kiểm bằng file có ngày biết trước)
- [ ] HEIC iPhone lấy được `DateTimeOriginal` (chứng minh exifreader hoạt động ở chỗ exifr hỏng)
- [ ] Ảnh có orientation 6 → tỉ lệ đảo đúng
- [ ] Benchmark 1000 file thật: ghi lại throughput, ngoại suy 70k, **so với ngân sách 3 phút**
- [ ] Ảnh hỏng / 0 byte → trả metadata rỗng, không ném lỗi làm dừng pool
- [ ] Mở lại root đã index → grid đầy đủ <500ms, không chạy lại pha B
- [ ] Thêm 1 file mới vào thư mục rồi mở lại → file mới xuất hiện

## Risk Assessment

**Rủi ro cao nhất: box-walker chưa từng được viết và đo.** Research chỉ xác nhận vị trí `moov`.
Parse `stsd`/`tkhd` có nhiều biến thể (version 0/1, matrix xoay, track không phải video).
*Tín hiệu:* video sai tỉ lệ, sai ngày, hoặc ném lỗi trên file thật.
*Phản ứng:* nếu box-walker tốn hơn 1 ngày, tạm dùng ffprobe **chỉ cho video** (video là thiểu số
— 9% mẫu, 70k×9% = 6300 file × 25ms ≈ 2,6 phút, chấp nhận được tạm thời) rồi thay sau.
Đây là fallback đã tính trước, không phải sửa vội.

**Rủi ro: ngưỡng 128KB cho HEIC dựa trên 1 file mẫu.**
*Tín hiệu:* nhiều ảnh rơi về `date_src=mtime` dù là ảnh máy ảnh.
*Phản ứng:* nâng lần thử thứ ba lên 256KB; đo tỉ lệ hit từng ngưỡng để chọn số đúng.

**Rủi ro: pha B vượt ngân sách 3 phút.**
*Tín hiệu:* benchmark 1000 file cho ra >2,5ms/file.
*Phản ứng:* ưu tiên theo viewport như pha C (đọc metadata vùng đang xem trước), thay vì
tuần tự từ đầu. Kiến trúc stream đã sẵn sàng cho việc này.
