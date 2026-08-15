---
phase: 6
title: "Lightbox + video"
status: completed
priority: P1
effort: "2.5d"
dependencies: [1, 5]
---

# Phase 6: Lightbox + video

## Overview

Xem ảnh full-screen với zoom/pan, chuyển prev/next **không chớp trắng**, và video player tua
được giữa file lớn. Đây là nơi "wow" đến từ chuyển động, không phải trang trí.

## Requirements

**Functional**
- Mở từ grid bằng shared-element zoom (FLIP), đóng thì co về đúng ô cũ
- prev/next bằng ←/→, click, swipe — không chớp trắng, không giật
- Zoom + pan (bánh xe, pinch, double-click)
- Video: play/pause, seek, âm lượng, fullscreen, tua được giữa file 2GB
- `Esc` đóng, focus trả về đúng thumbnail vừa mở

**Non-functional**
- Nền lightbox tối `--bg-immersive` dù app là light mode (design guidelines §1.2)
- Preload ±2; dùng `msrc` (thumbnail sẵn có) làm cách chính chống chớp trắng, `decode()` gate chỉ khi cần

## Architecture

### PhotoSwipe v5 cho ảnh — không tự viết zoom/pan

Đây là chỗ ngược lại với grid: thư viện thắng rõ ràng. Vật lý zoom/pan (rubber-band,
double-tap-zoom, pinch, quán tính) là bề mặt lớn và đã được hardened nhiều năm.
PhotoSwipe 5.4.4, MIT, install base lớn.

`preload` mặc định của nó đã đáp ứng yêu cầu ±2 — "renders only nearby slides, but not less than 2".

**Nhưng nó không tự gọi `img.decode()` trước khi swap.** Đây là khoảng trống so với contract
(yêu cầu "không chớp trắng").

**Cách chính, dùng trước:** PhotoSwipe có sẵn cơ chế `msrc` — ảnh thumbnail độ phân giải thấp
hiển thị ngay tại chỗ trong khi ảnh full-res tải nền. Đây là giải pháp có sẵn cho đúng vấn đề
"chớp trắng", và lưới đã có sẵn thumbnail để đưa vào `msrc`. Làm cái này trước.

**Chỉ khi `msrc` chưa đủ** mới thêm lớp `decode()` gate. Lưu ý bản nháp trước của plan này có
snippet gán `content.__ready = img.decode()...` mà **không ai `await` nó** — viết vậy là vô nghĩa,
promise treo không chặn gì cả. Muốn gate thật thì phải chặn trong lifecycle của PhotoSwipe
(giữ slide cũ tới khi promise resolve), không chỉ gán một thuộc tính.

Phải xác minh thời điểm swap thật trong source v5 — issue #1210/#904 cho thấy cộng đồng
từng vướng chỗ này, nên đừng tin mặc định là đủ.

### Video — content type tuỳ biến

PhotoSwipe sinh ra cho ảnh, không quản video. Đăng ký content type riêng qua plugin API v5,
render `<video>` native với `src` trỏ `/api/file?p=...`.

Seek dựa hoàn toàn vào **HTTP Range của Phase 1**. Nếu `If-Range` sai, video sẽ thỉnh thoảng
tải lại toàn bộ file sau seek — chậm im lặng, không có lỗi. Phase này là nơi phát hiện điều đó
trong thực tế, nên phải test với file lớn thật (≥1GB).

Poster frame lấy từ `/api/thumb` để không hiện khung đen trước khi video load.

### FLIP shared-element zoom

Click thumbnail → chính ô đó nở ra thành lightbox từ đúng vị trí và tỉ lệ, không phải fade-in
overlay mới. Kỹ thuật: đo rect trước (`First`) và sau (`Last`), dùng `transform` nghịch đảo
(`Invert`) rồi thả (`Play`). Chỉ animate `transform`/`opacity`.

300ms vào / 220ms ra, `cubic-bezier(0.32,0.72,0,1)`. Spike đã có bản chạy được, tham khảo.
`prefers-reduced-motion` → bỏ FLIP, dùng crossfade 80ms.

## Related Code Files

- Create: `web/lightbox.js` (PhotoSwipe, content type video, metadata bar)
- Modify: `web/grid.js` (click/Enter mở lightbox, `tileImg`, `focusId`)
- Modify: `web/app.js` (nạp lightbox theo yêu cầu, w/h cho slide)
- Modify: `web/styles.css`, `web/index.html` (theme tối, CSS PhotoSwipe)
- Modify: `src/server.js` (route `/vendor/photoswipe/`, `/api/preview`)
- Modify: `src/thumbs.js`, `src/media-types.js` (preview 1600px, HEIC stream group)
- Create: `test/lightbox-assets.test.js`
- Add dep: `photoswipe@^5.4.4`

## Implementation Steps

1. Nhúng PhotoSwipe v5 (ESM, không CDN — phải chạy offline).
2. Wrapper `decode()` gate; **đo thật** bằng cách chuyển nhanh 20 ảnh liên tiếp và quay video
   màn hình tìm frame trắng.
3. Content type video: `<video controls preload="metadata" poster="/api/thumb?...">`.
4. FLIP: port từ spike, xử lý trường hợp ô nguồn đã bị ảo hoá ra khỏi DOM (cuộn xa rồi mới đóng)
   → khi không tìm thấy ô nguồn thì fallback fade, không crash.
5. Focus trap + trả focus: lưu element vừa mở, `focus()` lại khi đóng.
6. Metadata bar: tên file, ngày chụp, kích thước, đường dẫn thư mục.

## Success Criteria

- [ ] Chuyển 20 ảnh liên tiếp bằng phím: **không frame trắng nào** (kiểm bằng quay màn hình)
- [x] Zoom/pan bằng bánh xe, pinch, double-click hoạt động mượt
- [ ] Video 2GB: kéo thanh tua tới giữa → phát gần như tức thì, không tải lại từ đầu
      (kiểm bằng tab Network: phải thấy 206 với Content-Range, không phải 200 toàn file)
- [x] Video quay dọc hiển thị đúng chiều
- [x] FLIP zoom mở/đóng khớp đúng ô nguồn
- [x] Cuộn xa rồi đóng lightbox → không crash, fallback fade
- [x] `Esc` đóng và focus trở lại đúng thumbnail
- [x] `prefers-reduced-motion` → không FLIP, chỉ crossfade
- [x] Nền lightbox tối, contrast chữ trên nền 18:1

## Kết quả thực tế

**FLIP tự viết: không viết.** PhotoSwipe v5 đã có sẵn shared-element zoom theo ô
nguồn (`element` + `thumbCropped: true`), kể cả nhánh fallback fade khi ô nguồn đã
bị ảo hoá (`thumbEl` trả undefined → nó tự chuyển). `web/video-slide.js` cũng không
cần: content type video gọn trong 10 dòng của `lightbox.js`.

**`decode()` gate: không cần.** `msrc` đủ — đo bằng Playwright, 12/12 lượt chuyển
slide đều có placeholder thumbnail đứng thế chỗ, không có khoảng trống.

**Ba bug của phase trước lộ ra ở đây, đã sửa tận gốc:**

1. `thumbs.js` dùng `-map 0:v:0`, mà HEIC iPhone là **lưới ô 512×512** → thumbnail
   ra 320×320 vuông, thực chất là một góc ảnh. Sửa thành `-filter_complex` trên
   stream group (`0:g:0`), có nhánh lùi về `0:v:0` cho HEIC một ô.
2. `app.js` đảo w/h theo `orient` **lần thứ hai** — `exif-image.js` và
   `video-meta.js` đã đảo trước khi phát. Mọi ảnh dọc sai tỉ lệ trong grid.
3. Chrome không giải mã HEIC/TIFF trong `<img>` → thêm `/api/preview` (ffmpeg
   1600px, dùng lại đúng hàng đợi và cache của thumbnail).

## Risk Assessment

**Rủi ro: `decode()` gate không đủ để chặn chớp trắng** nếu PhotoSwipe swap DOM trước khi
promise resolve.
*Tín hiệu:* vẫn thấy frame trắng khi chuyển nhanh.
*Phản ứng:* giữ slide cũ hiển thị (không gỡ) cho tới khi ảnh mới `decode()` xong rồi mới
crossfade — cần can thiệp sâu hơn vào lifecycle, đã tính là khả năng.

**Rủi ro: `If-Range` sai từ Phase 1 chỉ lộ ra ở đây.**
*Tín hiệu:* seek video chậm bất thường, Network hiện 200 thay vì 206.
*Phản ứng:* quay lại sửa `src/range.js` và bổ sung test — không vá ở tầng frontend.
