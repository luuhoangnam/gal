---
phase: 2
title: "Walker đệ quy + NDJSON stream"
status: completed
priority: P1
effort: "1d"
dependencies: [1]
---

# Phase 2: Walker đệ quy + NDJSON stream

## Overview

Pha A: duyệt toàn cây thư mục, stream đường dẫn về client **ngay khi tìm thấy**, không chờ duyệt xong.
Đây là nền của USP #1 (đệ quy) và USP #3 (tức thì).

## Requirements

**Functional**
- Duyệt đệ quy từ root, nhận diện media theo đuôi file
- Stream từng lô qua `GET /api/scan` dạng NDJSON
- Bỏ qua: thư mục ẩn, `node_modules`, bundle macOS (`.photoslibrary`, `.app`, `.fcpbundle`, `.imovielibrary`, `.tvlibrary`)
- Cờ `--include-bundles` để quét vào bundle khi user muốn
- Không dừng scan khi gặp thư mục không quyền đọc

**Non-functional**
- 70k file: hoàn tất pha A dưới 1s (baseline: `find` đo 0,15s)
- Không bao giờ giữ toàn bộ danh sách trong RAM trước khi gửi — stream thật

## Architecture

**Walker** (`src/walk.js`) — async generator, `fs.readdir(dir, {withFileTypes:true})` đệ quy.

- **Symlink thư mục: KHÔNG đi vào, mặc định.** Red team tìm ra mâu thuẫn: nếu walker đi theo
  symlink ra ngoài root thì `resolveInside` của Phase 1 sẽ trả 403 cho chính những file đó —
  index có mục nhưng không bao giờ xem được. Hai lớp phải nhất quán, và lớp an toàn là lớp đúng.
  Cờ `--follow-symlinks` cho người thật sự cần; khi bật thì root hợp lệ của Phase 1 phải mở rộng
  theo, không phải chỉ nới walker.
- **Chống lặp symlink** (khi bật cờ trên): `fs.lstat` lấy `dev`+`ino`, lưu `Set` các cặp đã thăm.
  Set lookup O(1), 70k entry không đáng kể.
- **Bỏ qua bundle:** kiểm tra theo **đuôi thư mục** tại mọi độ sâu, không phải glob toàn cục.
  `fs.glob` builtin không làm tốt việc này nên tự viết walker.
- **EACCES:** try/catch quanh mỗi `readdir`, đếm số thư mục bị bỏ qua để hiển thị ở empty state
  (yêu cầu của design guidelines §6: nói rõ đã bỏ qua bao nhiêu và vì sao).

**Nhận diện media** (`src/media-types.js`) — theo đuôi, không sniff nội dung ở pha A (quá đắt).
Ảnh: `jpg jpeg png heic heif gif webp avif tif tiff bmp`. Video: `mp4 mov m4v avi mkv webm`.

**Transport** (`GET /api/scan`) — NDJSON, mỗi dòng một lô:

```
{"t":"a","items":[{"i":41,"p":"rel/path.heic","s":2481234,"m":1699999999,"v":0}, ...]}
{"t":"a","items":[...]}
{"t":"done_a","n":70000,"skipped":3,"dirs":2847}
```

`i` là **rowid SQLite gắn với đường dẫn** (Phase 3), **không** phải số đếm theo thứ tự phát hiện.
Dùng thứ tự phát hiện là lỗi: thêm hoặc xoá một file thì mọi id dịch, và `/api/thumb?i=N` trả
nhầm ảnh ở lần mở sau. Id này còn là khoá neo scroll ở Phase 5 nên bắt buộc ổn định qua các lần chạy.

Lô 500-1000 item. Dùng NDJSON + `ReadableStream` chứ không SSE: backpressure native,
client kiểm soát nhịp đọc, không có thuế framing `data: ` mỗi dòng.

**Một scan cho mỗi root.** Tải lại trang hoặc mở tab thứ hai không được sinh walker thứ hai
ghi vào cùng không gian id — request thứ hai gắn vào scan đang chạy.

Đường dẫn gửi đi là **relative so với root**, không phải absolute — giảm byte và không rò
cấu trúc thư mục máy ra ngoài response.

## Related Code Files

- Create: `src/walk.js`, `src/media-types.js`
- Modify: `src/server.js` (thêm route `/api/scan`)
- Create: `test/walk.test.js` (fixture: symlink loop, tên emoji, thư mục cấm, bundle giả)

## Implementation Steps

1. `src/media-types.js`: hai `Set` đuôi file + `classify(name)` → `'image'|'video'|null`.
2. `src/walk.js`: `async function* walk(root, opts)` yield từng entry media.
   Bọc `readdir` trong try/catch, tăng `stats.skippedDirs` khi EACCES.
3. Guard symlink: `visited = new Set()`, key `` `${dev}:${ino}` ``.
4. Route `/api/scan`: gom generator thành lô, `res.write(JSON.stringify(batch)+'\n')`,
   `await once(res,'drain')` khi `write` trả `false` — đây là chỗ backpressure thật sự có tác dụng.
5. Fixture test tạo bằng code trong `os.tmpdir()`, dọn sạch sau test.

## Success Criteria

- [x] Walk `~/Pictures` (70k file) hoàn tất <1s, đếm khớp `find`
      — **615-646ms**, 70.822 mục, khớp đúng con số `find -iname` theo cùng danh sách đuôi
- [x] Symlink trỏ về thư mục cha → không lặp vô hạn, test chứng minh
- [x] Thư mục `chmod 000` → bị bỏ qua, scan vẫn chạy tiếp, `skipped` tăng
- [x] `.photoslibrary` bị bỏ qua mặc định; `--include-bundles` thì quét vào
- [x] Tên file có emoji và dấu tiếng Việt → không hỏng, không mojibake
- [x] Client nhận được lô đầu tiên trước khi scan xong — **chunk đầu 2ms, `done_a` 567ms**
- [x] `curl <url>/api/scan` in ra NDJSON hợp lệ từng dòng (143 dòng trên thư viện thật)

## Ghi chú thực hiện

- **`i` (rowid) chưa có trong pha A.** Item hiện chỉ mang `p`, `s`, `m`, `v`. Rowid là của
  SQLite nên chỉ tồn tại được từ Phase 3; gán số đếm tạm ở đây đúng là lỗi mà plan cảnh báo
  (thêm/xoá file → id dịch). Chưa client nào tiêu thụ nên hoãn không tốn gì.
- **"Một scan cho mỗi root" hoãn sang Phase 3** vì lý do tương tự: DB mới là trạng thái chung
  tự nhiên để request thứ hai gắn vào. Hiện mỗi request chạy walker riêng, chưa có id nên vô hại.
- **Nút thắt pha A là `lstat`, không phải `readdir`.** Đo trên 135k file: `readdir` một mình
  296ms, `lstat` tuần tự 2.859ms, `lstat` song song 16 chỉ 432ms (64 và 256 không nhanh thêm).
  Bản đầu tuần tự cho 3.570ms — trượt tiêu chí. Sửa: stat theo lô 64 trong từng thư mục
  (`STAT_BATCH`), giữ nguyên hình dạng generator. 3.570ms → 620ms.
  Plan đoán phải song song hoá `readdir`; số đo nói ngược lại — chỉ 4.408 thư mục cho 70k file.
- **`--follow-symlinks` giữ được tính nhất quán hai lớp**: walker báo mọi thư mục nó đi vào
  ngoài root qua `onExtraRoot`, server đưa vào vùng cho phép của `/api/file`. Không có cơ chế này
  thì cờ tự mâu thuẫn — index có mục mà mở ra 403, đúng như red team chỉ.
- `--host` / `--port` thêm ở CLI (yêu cầu chủ dự án). `--port` cố định làm việc trùng cache giữa
  các root thành tất định — đúng lý do URL thumbnail phải chứa hash nội dung ở Phase 4.

## Risk Assessment

**Rủi ro: bỏ qua `.photoslibrary` khiến user thấy "thiếu ảnh".** Trên máy đo, phần lớn 70k ảnh
nằm trong bundle này. User mở `~/Pictures` sẽ thấy gần như trống.
*Tín hiệu:* thư viện lớn nhưng grid gần rỗng.
**Đã xác nhận bằng số đo (2026-08-15):** `~/Pictures` có **10** file media ngoài bundle,
**70.822** file bên trong `.photoslibrary`. Mặc định hiện tại làm grid gần như trống trên máy này.
Yêu cầu empty state của Phase 8 do đó là bắt buộc, không phải tuỳ chọn.

*Phản ứng:* empty state phải nói rõ "đã bỏ qua N thư viện Photos, dùng `--include-bundles` để quét" —
đây là yêu cầu bắt buộc của Phase 8, không phải gợi ý.

**Rủi ro: walker JS chậm hơn `find` đáng kể.** Ngoại suy từ `find` 0,15s, chưa đo walker JS thật.
*Tín hiệu:* pha A vượt 2s trên 70k.
*Phản ứng:* tăng song song `readdir` theo thư mục (Promise pool ~16), không đổi kiến trúc.
