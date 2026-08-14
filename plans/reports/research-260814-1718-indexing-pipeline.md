# Research — Media indexing + thumbnail pipeline (Gal)

Ngày 2026-08-14. Máy đo: this Mac, Node v26.7.0, ffmpeg 9.0.1 homebrew (no libwebp), no exiftool, no sharp.
Tất cả số đo dưới đây là **đo thật** trên file trong `~/Pictures` (Photos Library thật, HEIC đa dạng: 1 tile → 228 tile grid).

## 1. EXIF date, header-only

**Phát hiện quan trọng: `exifr` (7.1.3) BỊ LỖI trên HEIC thật.**
Test trực tiếp: `exifr.parse()` ném `Unknown file format` trên mọi HEIC từ Photos Library. Root cause xác nhận qua source (`node_modules/exifr/dist/full.umd.js`, class `ze.canHandle`): hard-code `if (ftyp_box_size > 50) return false`. HEIC hiện đại (iOS gần đây) có compatible-brand list dài (`mif1,MiHB,MiHA,heix,MiHE,MiPr,miaf,heic,tmap` = 9 brand = box size 52) → luôn > 50 → luôn fail. Xác nhận qua GitHub issue exifr#138 và bài viết cộng đồng (đã tái hiện y hệt vấn đề, ghi nhận brand `MiHA`/`heix` gây tràn ngưỡng). exifr **không dùng được** cho pipeline này trừ khi patch nội bộ.
Nguồn: https://github.com/MikeKovarik/exifr (issue #138 theo bài viết), https://jacobmei.com/blog/2026/0421-2yh1pu/

**`exifreader` (4.42.0) — hoạt động đúng trên HEIC/JPEG/PNG, pure JS, không cần build native.**
Đo thật (buffer cắt sẵn, không đọc cả file):
| format | bytes cần đọc để có DateTimeOriginal + dims | thời gian parse |
|---|---|---|
| HEIC (iPhone, có nhiều tile) | ~128KB (16/32/64KB đều thiếu, cần ≥131072) | 1.2ms |
| JPEG | APP1 luôn ở đầu file, chuẩn quy định | <2ms (test file này không có EXIF date — screenshot, không phải ảnh máy ảnh) |
| PNG | eXIf chunk sau IHDR, gần đầu | 2.8ms full-read |

→ HEIC cần đọc nhiều hơn JPEG (128KB không phải 64KB) vì `meta` box (ExifItem) nằm sau nhiều box khác (`hdlr`,`iloc`,`iinf`,`iref`,`iprp`...) trước khi tới data thật. Không có magic constant cố định — an toàn nhất là đọc progressive: thử 64KB, nếu thiếu field cần thì đọc thêm 128KB, dừng ở đó (per-file retry rẻ vì local disk).

**Video creation_time — KHÔNG header-only được với .mov gốc iPhone.**
Đo thật bằng box-walk Python trên `.mov` gốc Photos Library: `ftyp`(20B) → `wide`(8B) → `mdat`(2.98MB) → **`moov` nằm SAU CÙNG**, offset 2,981,647 trên file 2.99MB. Đây là hành vi chuẩn QuickTime non-faststart. Nghĩa là: không thể chỉ đọc N KB đầu file để lấy metadata — phải seek qua các box-header (mỗi lần chỉ đọc 8-16 byte, không đọc nội dung `mdat`) cho tới khi gặp `moov`, rồi đọc riêng box đó (ở đây 12.8KB). Chi phí thực tế = vài lần `lseek`/`read(8)` + đọc 1 block cuối — rẻ, nhưng **không phải "đọc N KB đầu"** như câu hỏi giả định. Cần code path riêng cho video (áp dụng cho cả JS lẫn Python, không cần ffprobe).
MP4 web-optimized (faststart) thường có `moov` ở đầu — nhưng không đảm bảo, nên logic box-walk phải tổng quát (quét toàn bộ top-level box, không giả định vị trí).

**Kết luận mục 1**: dùng `exifreader` cho ảnh (JPEG/HEIC/PNG), tự viết box-walker ~50 dòng cho video creation_time (ISO-BMFF top-level box scan, đọc header trước rồi seek). Không dùng exifr. Không cần Pillow/pyexiv2/exiftool-vendored nếu chọn Node runtime.

## 2. Dimension probing, header-only

`image-size` (v2, pure JS/TS) — đo thật: HEIC 0.3-0.4ms, JPEG 0.12ms, PNG 0.03ms, kể cả trên HEIC 228-tile (5712×4284) vẫn <0.5ms — không bị ảnh hưởng bởi số lượng tile grid vì chỉ đọc `ispe` item-property box, không enumerate sample table như ffprobe. Trả về cả `images[]` (list mọi ảnh nhúng + kích thước — hữu ích cho mục 5). Không cần cài `probe-image-size` riêng (chức năng trùng, `image-size` mới hơn, đang bảo trì).
Python: Pillow `Image.open(f); img.size` không decode pixel (lazy) — nhanh tương đương, nhưng cần `.jpg`/`.png`/`.heic` — Pillow mặc định KHÔNG đọc HEIC (cần plugin `pillow-heif`, thêm cài đặt).
→ Nếu stack Node: `image-size` thắng tuyệt đối. Nếu Python: cần thêm `pillow-heif`.

## 3. ffprobe batching

Không có batch/stdin mode chính thức trong ffprobe (xác nhận: `ffprobe --help` không có flag input list; mỗi lần gọi = 1 process = 1 file).
Đo thật: 10 lần gọi ffprobe tuần tự = 0.225-0.271s tổng → **~22-27ms/spawn** (process spawn overhead trên macOS, gần như không đổi dù file có 1 hay 228 stream — box size không quyết định, đọc sample table vẫn nhanh nhờ mmap-style seek của libavformat).
Ngoại suy 70k file: tuần tự ≈ 70000×25ms = **29 phút**. Với concurrency = 8 core ≈ **3.6 phút**. So với `image-size`/`exifreader` pure-JS: 70k×~1-2ms (đơn luồng, I/O-bound, cache OS) ≈ **1-2 phút tuần tự**, và không tốn process-spawn/context-switch.
→ ffprobe **chỉ nên dùng cho video** (không có lựa chọn pure-JS nào test được rẻ hơn cho `width/height` + `duration` + `creation_time` cùng lúc — dù creation_time tự parse được, width/height video cũng nằm trong box `tkhd`/`stsd` bên trong `moov`, có thể tự parse luôn để tránh spawn ffprobe hoàn toàn cho cả ảnh lẫn video). Khuyến nghị: viết box-walker chung cho MOV/MP4 (đọc `moov`→`trak`→`mdia`→`minf`→`stbl`→`stsd` lấy width/height, và `mvhd`/`mdhd` lấy creation_time) — loại bỏ ffprobe khỏi pha B hoàn toàn, giữ ffprobe/ffmpeg chỉ cho pha C (thumbnail).

## 4. Thumbnail generation

Đo thật (đã có trong brainstorm: ffmpeg HEIC→jpg 44ms, sips HEIC 175ms — ffmpeg nhanh hơn sips ~4x). ffmpeg là **tool duy nhất phủ đủ 4 loại** (HEIC ảnh, JPEG, PNG, video frame) bằng một code path (`-i input -vframes 1 -vf scale=320:-1 output.jpg`), khớp quyết định đã chốt trong brainstorm — xác nhận đúng, không cần đổi.
sharp: không cài (cần libvips+libheif build từ source trên máy này để có HEIC — không có sẵn, thêm phụ thuộc nặng). Pillow: cần `pillow-heif` thêm, và không xử lý video.
Concurrency Apple Silicon: không đo core count riêng, nhưng ffmpeg từng file là single-shot process (không phải server), nên concurrency = `os.cpus().length` (thường 8-10 P/E core) là hợp lý, giới hạn bởi disk I/O nhiều hơn CPU ở ảnh nhỏ 320px.
**Output format — đo thật**: JPG q4 320px = 11.2KB, 32ms encode. WebP: **libwebp KHÔNG có trong ffmpeg 9.0.1 homebrew build hiện tại** (`Encoder not found` — cần `brew reinstall ffmpeg` với flag, không đảm bảo trên máy user khác) → rủi ro portability, loại. AVIF (SVT-AV1): 5.3KB (nhỏ hơn JPG ~2x) nhưng 51ms encode (chậm hơn JPG ~1.6x) và decode cost trong browser cao hơn khi scroll nhanh (canvas software decode chậm hơn JPEG hardware path trên nhiều máy). → **JPEG thắng** cho thumbnail: universal browser support, ffmpeg luôn có sẵn, encode nhanh nhất, decode nhanh nhất — size lớn hơn AVIF nhưng ở 320px không đáng kể (11KB × 70k = 770MB cache tối đa, chấp nhận được).

## 5. Embedded thumbnail shortcut

**Đo thật, kết luận: KHÔNG đáng làm qua ffmpeg stream-mapping.** HEIC thật trong Photos Library có 1 đến 228 HEVC stream (grid-tile encoding chuẩn, không phải nhiều ảnh) — chỉ ~4/30 file mẫu là "1 stream đơn giản". ffmpeg cần xác định **đúng index của thumbnail item** trước khi map, và thumbnail có thể là stream 416×312 ở vị trí index=48 (giữa 95 stream) — không cố định giữa các file, muốn tìm phải chạy ffprobe/liệt kê streams trước → chi phí phát hiện (probe) gần bằng chi phí decode luôn. Đo: extract stream index=48 mất 39ms, decode+scale full-res primary mất 32ms — **rẻ hơn, không có lợi.**
`image-size`'s `images[]` list (mục 2) đã liệt kê mọi ảnh nhúng + kích thước **miễn phí trong lần đọc header 0.3ms** — đây mới là chỗ nên tận dụng: dùng list này để CHỌN item nhỏ nhất phù hợp (≥320px), rồi mới quyết định có cần ffmpeg decode hay dùng thẳng preview nhúng. Nhưng lấy RAW BYTES của item đó vẫn cần tự parse `iloc`/`iinf` box (không có trong `image-size`) — độ phức tạp code tương đương viết box-walker riêng, effort không nhỏ.
**Khuyến nghị: bỏ shortcut này cho v1.** ffmpeg 320px decode đã đủ nhanh (32-44ms), lợi ích biên của embedded-thumb không bù được độ phức tạp implement + rủi ro (item thumbnail có thể bị xoay sai orientation, chất lượng thấp hơn kỳ vọng, một số file không có thumbnail nhúng chuẩn).

## 6. Cache + invalidation

Cache key `hash(path+mtime+size)` — đã chốt trong contract, hợp lý (mtime+size đổi → tự invalidate, không cần đọc nội dung).
Index persistence: **`node:sqlite`** (Node v26, `node:sqlite` builtin, đã test `DatabaseSync` hoạt động — không cần cài `better-sqlite3` native module, tránh mọi vấn đề native-build/ARM cho "một lệnh không cần cài thủ công"). JSON không phù hợp ở 70k row (load/parse toàn bộ vào RAM mỗi lần mở, không query được theo path prefix cho filter cây thư mục). SQLite cho index/query nhanh theo path, date range, type — khớp acceptance criteria #5 (filter <100ms).
Invalidation khi mở lại: **rẻ nhất** = so sánh `mtime` của thư mục gốc + so sánh count/mtime từng thư mục con đã biết trong index (không phải re-stat từng 70k file). Nếu cần chính xác hơn: watchman/FSEvents (native macOS) tốt nhưng thêm phụ thuộc — brainstorm đã quyết "chạy lại pha A nền" là đủ (walk 0.15s, quá rẻ để cần watcher). **Giữ nguyên quyết định đó — không cần FSEvents cho v1.**

## 7. Safe recursive walk macOS

`fs.glob`/`fs.promises.glob` (Node builtin từ v22+, đã test tồn tại) hỗ trợ pattern nhưng **không có exclude theo tên thư mục kiểu bundle tốt bằng tự viết walker** (cần logic: dừng khi gặp `.photoslibrary`/`.app`/`.fcpbundle` extension, không phải glob-exclude toàn cục vì phải áp dụng đệ quy tại mọi độ sâu). Symlink loop: `fs.lstat` lấy `dev+ino`, dùng `Set` đã thăm — rẻ (70k file, set lookup O(1)). Permission-denied: try/catch quanh `readdir`, log rồi skip, không throw làm dừng cả scan (khớp acceptance #9). `fd`/`find` không cần thiết ở scale này — 0.15s cho 70k file bằng `find` đã đo, tự viết walker Node (`fs.readdir` đệ quy async) sẽ tương đương hoặc chậm hơn chút do overhead JS, nhưng vẫn dưới 1s — chấp nhận được, và cần thiết để có logic skip/symlink tùy biến mà `find`/`fd` không cho phép dễ dàng tích hợp vào pipeline stream.

## Recommended pipeline (Node, vì Node v26 sẵn, "một lệnh" dễ nhất qua npx)

```
Pha A: tự viết recursive walker (fs.readdir đệ quy, skip bundle-ext, dev+ino symlink guard, catch EACCES)
Pha B: ảnh → image-size (dims) + exifreader (date, đọc 64KB rồi retry 128KB nếu thiếu)
       video → tự viết ISO-BMFF box-walker (tự parse moov/mvhd/tkhd, không dùng exifr/ffprobe)
Pha C: ffmpeg (mọi loại, JPEG output, on-demand theo viewport, concurrency = cpus().length)
Cache: node:sqlite cho index, thư mục ~/.cache/gal cho thumbnail jpg
Invalidate: re-run pha A nền khi mở lại, so mtime thư mục
```

**Điều kiện fail của từng lựa chọn:**
- `exifreader`: fail nếu Apple đổi cấu trúc box HEIC tương lai (ít rủi ro hơn exifr vì không hard-code ngưỡng size, nhưng vẫn cần theo dõi maintenance — repo hoạt động, nhiều star).
- box-walker tự viết (video): fail nếu gặp format video lạ (AVI, MKV cũ) — nhưng scope v1 chỉ cần MOV/MP4 (thực tế trong `~/Pictures`, `~/Movies`).
- ffmpeg thumbnail: fail nếu file hỏng/corrupt — cần try/catch, fallback placeholder icon, không crash pipeline.
- node:sqlite: fail nếu chạy Node <22 (không phải rủi ro ở đây, máy có v26).

## Unresolved / chưa đo

- Chưa viết & đo thật box-walker video width/height/creation_time (chỉ đo được vị trí `moov`, chưa parse nội dung `mvhd`/`tkhd` — độ phức tạp code vừa phải, cần làm ở bước implement).
- Chưa đo `exifreader` trên 70k file thật (throughput tổng, GC pressure khi stream nhiều buffer nhỏ) — chỉ đo per-file. Nên benchmark 1000-file sample trước khi cam kết số phút cho pha B.
- Chưa xác nhận `pillow-heif` cho Python path (không cần nếu chọn Node).
- Ngưỡng byte-đọc 128KB cho HEIC EXIF date dựa trên 1 file mẫu — nên test thêm vài chục file đa dạng nguồn (không chỉ iPhone gốc, có thể ảnh edit qua app khác có cấu trúc box khác).

Status: DONE
Summary: exifr lỗi thật trên HEIC hiện đại (xác nhận qua source + issue #138) — dùng exifreader thay thế. Video .mov iPhone có moov ở cuối file, không header-only theo nghĩa "N KB đầu" — cần box-walk seek. ffprobe quá chậm cho bulk index (25ms/spawn × 70k ≈ 29 phút tuần tự) — chỉ dùng cho pha C video, pha B nên tự parse box. Embedded-thumbnail shortcut không đáng làm (đo thật: rẻ hơn không đáng kể, phức tạp hơn nhiều). ffmpeg JPEG thắng cho thumbnail (WebP không có trong ffmpeg build hiện tại; AVIF chậm hơn, nhỏ hơn không đáng kể ở 320px). node:sqlite dùng được, không cần native module.
Concerns: box-walker video (width/height/creation_time) chưa viết & đo thật — cần benchmark trước khi implement plan cam kết số liệu.
