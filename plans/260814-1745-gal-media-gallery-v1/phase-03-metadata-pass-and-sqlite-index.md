---
phase: 3
title: "Metadata pass + SQLite index"
status: pending
priority: P1
effort: "4d"
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
- [ ] Mở lại root đã index → grid đầy đủ <500ms, **không chạy lại pha B** (chứng minh mtime khớp)
- [ ] Thêm 1 file mới vào thư mục rồi mở lại → file mới xuất hiện
- [ ] **Id ổn định:** ghi lại id của một ảnh, thêm 100 file vào giữa cây, mở lại → id đó không đổi
- [ ] Xoá file rồi mở lại → biến khỏi grid (cột `seen`), id các file khác không dịch
- [ ] Chạy hai tiến trình `gal` cùng root → tiến trình thứ hai không crash, vào chế độ chỉ đọc
- [ ] Tải lại trang giữa lúc scan → không sinh walker thứ hai (một scan mỗi root)
- [ ] Fuzz test box-walker: 1000 file méo ngẫu nhiên → không treo, không lỗi chưa bắt, không OOM
- [ ] File `.mp4` thực chất là text/JPEG → parser từ chối sạch, không crash

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
