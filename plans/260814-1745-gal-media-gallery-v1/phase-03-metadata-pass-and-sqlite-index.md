---
phase: 3
title: "Metadata pass + SQLite index"
status: completed
priority: P1
effort: "2d"
dependencies: [2]
---

# Phase 3: Metadata pass + SQLite index

## Overview

Pha B: đọc kích thước và **ngày chụp thật** của từng file, stream patch về client trong khi grid
đã hiển thị. Lưu index vào SQLite để lần mở sau tức thì.

Nơi research đã bác bỏ hai giả định phổ biến (`exifr` hỏng với HEIC, shortcut thumbnail nhúng
không đáng làm).

**Phạm vi v1:** ảnh đi đường thuần JS (`exifreader` + `image-size`), video đi ffprobe.
Box-walker tự viết đã hoãn sang sau v1 — đặc tả giữ trong file này để không phải nghiên cứu lại.

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

### Video — v1 dùng ffprobe, box-walker hoãn sang sau

**Quyết định (validation 2026-08-15):** v1 dùng ffprobe **chỉ cho video**. Box-walker tự viết
hoãn lại thành việc sau v1.

Lý do: video chỉ chiếm ~9% mẫu → 6.300 file × 25ms ≈ **2,6 phút**, chấp nhận được, và có app
chạy được sớm hơn nhiều. Khi thay bằng box-walker sau này sẽ có dữ liệu ffprobe thật để đối
chiếu đúng/sai — viết parser nhị phân mà không có nguồn tham chiếu là cách chắc chắn để sai âm thầm.

Ràng buộc giữ nguyên: **ffprobe không bao giờ được dùng cho ảnh.** 70k file × 25ms = 29 phút
tuần tự; chi phí nằm ở spawn process. Ảnh đi đường `exifreader` + `image-size` thuần JS.

Toàn bộ phần dưới đây (đường đi box, hardening, fuzz test) là đặc tả cho **bản thay thế sau v1**,
giữ lại để không phải nghiên cứu lại. Không nằm trong phạm vi v1.

`.mov` iPhone đặt `moov` ở **cuối file** (đo thật: offset 2.981.647 trên file 2,99MB) — nên
"đọc N KB đầu" không dùng được. Phải quét top-level box: đọc 8-16 byte header, `seek` qua
`mdat` mà không đọc nội dung, tới khi gặp `moov` rồi đọc riêng box đó (~13KB).

Đường đi trong box: `moov` → `mvhd` (creation_time, timescale, duration) và
`moov/trak/mdia/minf/stbl/stsd` (width/height) hoặc `trak/tkhd` (kích thước hiển thị, có matrix xoay).
Lưu ý `tkhd` matrix quyết định video quay dọc — bỏ qua sẽ hiển thị sai tỉ lệ toàn bộ video iPhone.

Thời gian trong ISO-BMFF tính từ **1904-01-01**, không phải Unix epoch. Lệch 2.082.844.800 giây.

#### Hardening bắt buộc — đây là parser nhị phân chạy trên file không tin cậy

File được chọn **chỉ theo đuôi tên**, nên bất cứ thứ gì tên `.mp4` đều đi qua parser này, trên
70.000 file. Không hardening thì một file hỏng đủ để treo hoặc giết tiến trình:

| Đầu vào độc hại | Hậu quả nếu không xử lý | Bắt buộc |
|---|---|---|
| Box `size == 0` | Vòng lặp vô hạn (offset không tiến) | size < 8 → dừng parse file đó |
| `largesize` 64-bit | Vượt `Number.MAX_SAFE_INTEGER` | Đọc bằng `BigInt`, từ chối nếu > kích thước file |
| `moov` khai báo 4GB | `Buffer.alloc` OOM giết tiến trình | Kẹp trần đọc box ở 16MB |
| Box lồng sâu vô hạn | Tràn stack | Giới hạn độ sâu 16 |
| `stsd` khai `entry_count` khổng lồ | Vòng lặp cấp phát | Kẹp trần theo số byte còn lại của box |
| Offset vượt kích thước file | Đọc ngoài vùng | Kiểm mọi offset so với `st.size` trước khi `read` |

**Bắt buộc có fuzz test:** sinh file `.mp4` méo mó ngẫu nhiên (cắt cụt, size sai, byte ngẫu nhiên)
và khẳng định parser luôn trả về trong thời gian hữu hạn, không ném lỗi chưa bắt, không cấp phát
quá trần. Không có test này thì coi như box-walker chưa xong.

### Index — `node:sqlite` builtin

Đo thật: 70k insert trong transaction = 31ms; query khoảng ngày có index = 1ms.
Không cần `better-sqlite3` (native module sẽ phá vỡ "không cài đặt thủ công").

```sql
CREATE TABLE media(
  id INTEGER PRIMARY KEY,        -- rowid ỔN ĐỊNH, gắn với rel, KHÔNG phải thứ tự phát hiện
  rel TEXT NOT NULL UNIQUE,      -- khoá tự nhiên
  size INTEGER, mtime INTEGER,   -- mtime = Math.floor(mtimeMs), xem bên dưới
  kind INTEGER,                  -- 0 ảnh, 1 video
  w INTEGER, h INTEGER, orient INTEGER,
  taken INTEGER,                 -- epoch ms, ngày chụp
  date_src INTEGER,              -- 0 exif, 1 mtime
  dur REAL, dir TEXT,
  seen INTEGER                   -- generation của lần scan gần nhất, để phát hiện file mất
);
CREATE UNIQUE INDEX ix_rel ON media(rel);
CREATE INDEX ix_taken ON media(taken);
CREATE INDEX ix_dir   ON media(dir);
```

DB đặt tại `~/.cache/gal/index/<sha1(realpath(root))>.db`.

#### Id phải ổn định — sửa lỗi thiết kế do red team tìm ra

Bản đầu của plan dùng `i` = **thứ tự phát hiện** làm id. Sai: mở lại sau khi thêm/xoá một file
thì mọi id dịch, và `/api/thumb?i=N` trả **nhầm ảnh**. Id giờ là `rowid` SQLite gắn với `rel`
qua `INSERT ... ON CONFLICT(rel) DO UPDATE`, nên id của một file không đổi qua các lần chạy.

Hệ quả: pha A phải ghi vào DB để lấy id **trước khi** stream về client, thay vì đánh số đếm
trong bộ nhớ. Insert 70k mất 31ms nên chi phí không đáng kể.

#### mtime là số thực, không phải số nguyên

Đo thật: `fs.statSync().mtimeMs` = `1780647792984.1538`. Lưu thẳng vào cột INTEGER rồi so sánh
sẽ lệch, khiến **toàn bộ pha B chạy lại mỗi lần mở** — mất trắng lợi ích cache.
Chuẩn hoá một chỗ duy nhất: `const mtime = Math.floor(st.mtimeMs)`, dùng cùng công thức đó
cho cả khoá cache thumbnail ở Phase 4.

#### Hai tiến trình `gal` cùng root

Đo thật: `node:sqlite` mặc định `journal_mode=delete`, writer thứ hai **ném `ERR_SQLITE_ERROR`
ngay lập tức** (không chờ). Người dùng mở hai cửa sổ terminal là gặp.

Sửa: `PRAGMA journal_mode=WAL` (đã xác nhận bật được) + `PRAGMA busy_timeout=5000`.
Thêm lockfile khuyến nghị `~/.cache/gal/index/<hash>.lock` chứa pid: tiến trình thứ hai
phát hiện tiến trình thứ nhất còn sống thì **chỉ đọc**, không chạy pha B, và nói rõ trong UI.

#### Một scan tại một thời điểm cho mỗi root

Tải lại trang hoặc mở tab thứ hai sẽ khởi động walker thứ hai ghi vào cùng không gian id.
`/api/scan` phải dùng chung một scan đang chạy (multiplex), không sinh scan mới.

**Invalidation khi mở lại:** nạp cache render ngay, rồi chạy pha A nền so sánh.
Dùng cột `seen` tăng theo generation: sau scan, hàng nào `seen` cũ hơn generation hiện tại là
file đã mất. File mới → chạy pha B cho riêng chúng. Không cần FSEvents/watchman
cho v1 vì walk chỉ tốn <1s.

## Related Code Files

- Create: `src/metadata.js` (điều phối), `src/exif-image.js`, `src/video-meta.js` (ffprobe), `src/index-db.js`
- Modify: `src/server.js` (pha B stream tiếp trên `/api/scan`)
- Create: `test/exif-image.test.js`, `test/video-meta.test.js`, `test/index-db.test.js`
- Create: `scripts/bench-metadata.js` (đo throughput trên mẫu 1000 file thật)
- Sau v1, không thuộc phase này: `src/box-walker.js` + `test/box-walker.test.js` (fuzz)

## Implementation Steps

1. `video-meta.js`: gọi `ffprobe -v quiet -print_format json -show_streams -show_format`,
   lấy width/height (kèm `side_data` rotation cho video quay dọc), `creation_time`, `duration`.
   Pool đồng thời `os.cpus().length` để 6.300 video xong trong ~1 phút thay vì 2,6.
2. `exif-image.js`: `readChunk(path, 0, 65536)` → `ExifReader.load` → thiếu thì thử 131072.
   Kết hợp `image-size` cho dims. Áp orientation vào tỉ lệ (orientation 5-8 đảo w/h).
3. `index-db.js`: schema trên, prepared statement, insert theo transaction lô 1000.
4. `metadata.js`: pool đồng thời (`os.cpus().length`), phát patch theo lô.
5. Format patch NDJSON: `{"t":"b","items":[{"i":0,"w":4032,"h":3024,"taken":1699,"ds":0},...]}`
6. `scripts/bench-metadata.js` chạy trên 1000 file thật từ `~/Pictures`, in throughput —
   **chạy trước khi cam kết con số 3 phút.**

## Success Criteria

- [x] ffprobe lấy đúng width/height/creation_time/duration từ `.mov` iPhone gốc và `.mp4`
- [x] Video quay dọc hiển thị đúng tỉ lệ — 14/15 video iPhone thật có `rotation: -90`,
      stream 1920×1440 → hiển thị 1440×1920. ffmpeg **không** dựng được fixture có side_data
      (mọi cách đều xoay khung hình thật), nên test kiểm hàm chuẩn hoá góc trên đúng hình dạng đó
- [x] Pha B 70.822 file xong trong **8,3 giây** (ngân sách 3 phút)
- [x] HEIC iPhone lấy được `DateTimeOriginal` — chỗ exifr hỏng
- [x] Ảnh có orientation 6 → tỉ lệ đảo đúng (test dựng JPEG + APP1 EXIF tự viết)
- [x] Benchmark mẫu ngẫu nhiên 1000 file: 0,15ms/file → ngoại suy 0,2 phút
- [x] Ảnh hỏng / 0 byte / không tồn tại → metadata rỗng, không ném
- [x] Mở lại root đã index → **70.822 mục đầy đủ ở 126ms**, `done_b` với 0 item = pha B không chạy lại
- [x] Thêm file mới → chỉ file mới vào `pending`, chạy pha B riêng chúng
- [x] **Id ổn định:** thêm file xếp trước trong thứ tự duyệt, id cũ không đổi
- [x] Xoá file → biến khỏi cache theo cột `seen`, id file khác không dịch
- [x] Hai tiến trình `gal` cùng root → tiến trình thứ hai `readonly:true`, không crash;
      lock của pid đã chết được thu hồi ở lần chạy sau
- [x] Tải lại trang giữa lúc scan → gắn vào scan đang chạy, không sinh walker thứ hai
- [x] File `.mp4` thực chất là text → ffprobe fail sạch, pipeline không dừng

## Ghi chú thực hiện

### Số đo trên thư viện thật (70.822 file, 2026-08-15)

| Mốc | Lần đầu | Lần mở lại |
|---|---|---|
| Item đầu tiên | 2ms | 84ms (từ cache) |
| Grid đầy đủ | — | **126ms** |
| `done_a` | 1.375ms | 1.048ms |
| `done_b` | **8.292ms** | 1.048ms (0 item — không chạy lại) |

### Ba chỗ số đo bác bỏ giả định của plan

1. **Pha A giờ là 1,4s, không phải <1s.** Tiêu chí <1s của Phase 2 đo walker trần (620ms).
   Id ổn định bắt buộc ghi DB trước khi stream, và upsert 70k tốn **~380ms** — đo riêng, không
   đổi theo kích thước lô (500/2000/10000 đều 350-380ms). Con số 31ms trong plan là INSERT trần,
   không có `UNIQUE(rel)` + `ON CONFLICT ... RETURNING`. Đây là cái giá thật của id ổn định.
   Lời hứa "không màn hình chờ" vẫn giữ: ảnh đầu tiên ở 2ms.
2. **Video chiếm 0,1% thư viện này, không phải 9%.** Ước tính 2,6 phút cho pha B do đó lệch
   rất xa — thực tế 8,3 giây. Ngân sách 3 phút còn nguyên chỗ trống; áp lực thay ffprobe bằng
   box-walker gần như biến mất trên máy này.
3. **64KB đủ cho mọi ảnh CÓ EXIF.** Đo 400 ảnh ngẫu nhiên: 64KB bắt 166 hit, 128KB/256KB/đọc cả
   file thêm **0 hit**. 234 file còn lại là `.jpeg` phái sinh của Photos, đọc hết file cũng không
   có EXIF. Nên escalate chỉ áp dụng cho HEIC/HEIF/AVIF (lý do gốc của ngưỡng 128KB là bố cục box
   ISO-BMFF); JPEG đặt APP1 ngay đầu file nên đọc thêm là phí. Tỉ lệ EXIF toàn thư viện: 43%.

### Quyết định thiết kế

- **`src/scan.js` giữ log message của scan đang chạy**, client vào sau phát lại lịch sử rồi bám
  tiếp. Đơn giản hơn multiplex từng chunk, và message pha A chỉ là id + đường dẫn.
- **`date_src IS NULL` = chưa chạy pha B.** Không thêm cột `meta_done`: sau pha B `date_src` luôn
  có giá trị (0 exif / 1 mtime), nên NULL đã là dấu hiệu đủ. `mtime` đổi thì upsert tự set lại NULL.
- **Lockfile chứa pid, kiểm bằng `process.kill(pid, 0)`.** Crash không khoá vĩnh viễn thư viện.
- Ngày EXIF parse thủ công như **giờ địa phương**: `"2025:03:14 09:26:01"` không có timezone và
  `Date.parse` hỏng với dấu hai chấm ở phần ngày. `creation_time` của video thì là ISO-8601 có `Z`.

## Risk Assessment

**Rủi ro: ffprobe chậm hơn ước tính trên thư viện nhiều video.** Ước tính 2,6 phút dựa trên
giả định video chiếm 9%; thư mục toàn video thì con số khác hẳn.
*Tín hiệu:* pha B trên thư mục video vượt 5 phút.
*Phản ứng:* ưu tiên metadata theo viewport (kiến trúc stream đã sẵn sàng), và đẩy nhanh việc
thay bằng box-walker — đặc tả đã có sẵn trong phase này.

**Rủi ro: ngưỡng 128KB cho HEIC dựa trên 1 file mẫu.**
*Tín hiệu:* nhiều ảnh rơi về `date_src=mtime` dù là ảnh máy ảnh.
*Phản ứng:* nâng lần thử thứ ba lên 256KB; đo tỉ lệ hit từng ngưỡng để chọn số đúng.

**Rủi ro: pha B vượt ngân sách 3 phút.**
*Tín hiệu:* benchmark 1000 file cho ra >2,5ms/file.
*Phản ứng:* ưu tiên theo viewport như pha C (đọc metadata vùng đang xem trước), thay vì
tuần tự từ đầu. Kiến trúc stream đã sẵn sàng cho việc này.
