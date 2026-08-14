---
phase: 4
title: "Thumbnail pipeline"
status: pending
priority: P1
effort: "1.5d"
dependencies: [1, 3]
---

# Phase 4: Thumbnail pipeline

## Overview

Pha C: sinh thumbnail JPEG 320px **theo yêu cầu của viewport**, cache trên đĩa.
Không bao giờ warm toàn bộ 70k — đó là cách các tool static-generator thất bại ở USP #3.

## Requirements

**Functional**
- `GET /api/thumb?i=<id>&s=<size>` trả JPEG, sinh nếu chưa có
- Cache đĩa `~/.cache/gal/thumbs/<hash>.jpg`, key = `sha1(realpath + mtime + size + targetSize)`
- Ảnh, HEIC, PNG, và **poster frame video** — cùng một code path ffmpeg
- File hỏng → trả placeholder, **không** để pipeline chết
- Ưu tiên theo viewport: client báo vùng đang xem, hàng đợi phục vụ vùng đó trước

**Non-functional**
- Concurrency = `os.cpus().length`
- Thumbnail vùng nhìn thấy hoàn tất trong ~1s sau khi scroll dừng

## Architecture

**Một tool cho cả bốn loại.** ffmpeg xử lý HEIC, JPEG, PNG và frame video bằng một lệnh:

```
ffmpeg -ss 1 -i <input> -map 0:v:0 -filter:v scale=320:-1 -frames:v 1 -q:v 4 -y <out.jpg>
```

`-ss 1` chỉ cho video (lấy frame giây thứ 1, tránh frame đen đầu phim). Ảnh thì bỏ.
Lưu ý `-map 0:v:0` bắt buộc với HEIC nhiều tile — thiếu nó ffmpeg dựng filtergraph phức tạp
và fail với lỗi "Filtergraph … was specified for a stream fed from a complex filtergraph"
(đã gặp thật khi khảo sát).

**Định dạng: JPEG.** Không phải lựa chọn mặc định vì lười — có bằng chứng:
- WebP: ffmpeg 9 homebrew **không có libwebp** (`Encoder not found`). Yêu cầu user rebuild
  ffmpeg là phá lời hứa "không cài đặt".
- AVIF: 5,3KB so với 11,2KB nhưng encode 51ms so với 32ms, và decode trong browser chậm hơn
  khi scroll nhanh. Ở 320px, lợi ích size không đáng.
- JPEG: nhanh nhất cả encode lẫn decode, universal. 11,2KB × 70k = ~770MB cache tối đa — chấp nhận.

**Không dùng shortcut thumbnail nhúng.** Đo thật: HEIC Photos Library dùng grid-tile (1-228 luồng
HEVC), phải probe để biết index luồng thumbnail → 39ms, trong khi decode thẳng ảnh chính chỉ 32ms.
Phức tạp hơn, chậm hơn. Bỏ.

**Hàng đợi ưu tiên** (`src/thumbs.js`):
- `POST /api/priority` với danh sách id trong viewport → đẩy lên đầu hàng đợi
- Huỷ job của vùng đã cuộn qua (giữ token huỷ, kill process ffmpeg nếu chưa xong)
- Dedupe: cùng một id yêu cầu nhiều lần → một job, nhiều promise chờ

**Dọn cache:** kiểm tra tổng dung lượng lúc khởi động; vượt ngưỡng (mặc định 2GB) thì xoá
theo LRU dựa trên `atime`. Không chạy nền liên tục.

## Related Code Files

- Create: `src/thumbs.js` (hàng đợi, cache, dedupe), `src/ffmpeg.js` (định vị binary, spawn)
- Modify: `src/server.js` (route `/api/thumb`, `/api/priority`)
- Create: `test/thumbs.test.js`
- Create: `web/assets/broken.svg` (placeholder ảnh hỏng)

## Implementation Steps

1. `src/ffmpeg.js`: tìm ffmpeg theo `PATH` (`which`), cache kết quả. Thiếu → ném lỗi có
   thông điệp hành động được (`brew install ffmpeg`) — xem Phase 9.
2. `src/thumbs.js`: `Map<id, Promise>` để dedupe; hàng đợi hai mức (priority / normal);
   semaphore giới hạn `os.cpus().length`.
3. Cache key gồm `mtime`+`size` nên file đổi là tự invalidate — không cần so nội dung.
4. Ghi file cache theo kiểu atomic: ghi `.tmp` rồi `rename`, tránh đọc phải file nửa vời khi
   có nhiều request song song.
5. Timeout mỗi job ffmpeg (10s), kill và trả placeholder — file hỏng có thể làm ffmpeg treo.
6. Route `/api/thumb` set `Cache-Control: max-age=31536000, immutable` (key đã gồm mtime).

## Success Criteria

- [ ] HEIC iPhone → JPEG 320px hiển thị được trên browser
- [ ] Video → poster frame, không phải khung đen
- [ ] File hỏng / 0 byte → placeholder, request tiếp theo vẫn chạy bình thường
- [ ] Cuộn nhanh qua 5000 ảnh → chỉ sinh thumbnail vùng dừng lại, không sinh hết đường đi
      (đo bằng số job ffmpeg đã chạy)
- [ ] Yêu cầu cùng id 20 lần song song → đúng 1 process ffmpeg
- [ ] Sửa mtime file → thumbnail tự sinh lại
- [ ] Lần thứ hai mở cùng thư mục → thumbnail lấy từ cache, không gọi ffmpeg
- [ ] Cache vượt 2GB → dọn LRU, không xoá file đang dùng

## Risk Assessment

**Rủi ro: ffmpeg treo trên file hỏng.** Đã có timeout, nhưng process zombie vẫn có thể tích tụ.
*Tín hiệu:* số process ffmpeg tăng dần, máy nóng.
*Phản ứng:* kill theo process group, kiểm tra bằng test tạo file hỏng cố ý.

**Rủi ro: 770MB cache bất ngờ với user.** Người dùng không mong app chiếm ngần đó đĩa im lặng.
*Tín hiệu:* phàn nàn về dung lượng.
*Phản ứng:* in dung lượng cache khi khởi động nếu vượt 500MB, và cung cấp `gal --clear-cache`.
