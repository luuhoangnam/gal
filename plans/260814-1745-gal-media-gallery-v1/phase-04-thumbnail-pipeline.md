---
phase: 4
title: "Thumbnail pipeline"
status: completed
priority: P1
effort: "2.5d"
dependencies: [1, 3]
---

# Phase 4: Thumbnail pipeline

## Overview

Pha C: sinh thumbnail JPEG 320px **theo yêu cầu của viewport**, cache trên đĩa.
Không bao giờ warm toàn bộ 70k — đó là cách các tool static-generator thất bại ở USP #3.

## Requirements

**Functional**
- `GET /api/thumb/<hash>.jpg` trả JPEG, sinh nếu chưa có.
  **URL chứa hash nội dung, không phải id** — nếu dùng `?i=<id>` kèm `Cache-Control: immutable`
  thì browser sẽ tái dùng thumbnail của root khác khi trùng cổng (dải ephemeral macOS chỉ có
  16384 cổng, và `--port` làm nó thành tất định).
- Cache đĩa `~/.cache/gal/thumbs/<hash>.jpg`, key = `sha1(realpath + Math.floor(mtimeMs) + size + targetSize)`.
  `Math.floor` bắt buộc: `mtimeMs` là số thực (đo thật `…984.1538`), làm tròn khác nhau giữa
  Phase 3 và Phase 4 sẽ khiến cache không bao giờ hit.
- **Negative cache cho file lỗi**: file hỏng phải được nhớ là hỏng, nếu không mỗi lần cuộn qua
  lại spawn ffmpeg — bão process trên thư mục có nhiều file rác.
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

- [x] HEIC iPhone → JPEG hiển thị được (đo thật trên thư viện: 320×240, 13-27KB)
- [x] Video → poster frame, không phải khung đen (test dùng `testsrc`, màu phẳng không phân biệt được)
- [x] File hỏng / 0 byte → placeholder `/assets/broken.svg`, request tiếp theo vẫn chạy
- [ ] Cuộn nhanh qua 5000 ảnh → chỉ sinh thumbnail vùng dừng lại
      — **cần client, kiểm ở Phase 5.** Cơ chế đã có: `/api/priority` + hàng đợi hai mức
- [x] Yêu cầu cùng hash 20 lần song song → đúng 1 process ffmpeg
- [x] Sửa mtime file → khoá đổi → thumbnail sinh lại
- [x] Lần thứ hai → lấy từ cache, `spawned` không tăng
- [x] Cache vượt ngưỡng → dọn LRU theo `atime`, dừng đúng lúc xuống dưới ngưỡng, không xoá sạch
- [x] File hỏng gọi lại 5 lần → vẫn đúng 1 spawn mỗi file (negative cache), không bão process
- [x] Root khác → khoá khác (khoá gồm absolute path), không lẫn cache giữa hai root
- [x] Khoá dùng chung `Math.floor(mtimeMs)` với Phase 3 → mở lại không sinh lại thumbnail nào

## Ghi chú thực hiện

### `scale=320:-1` là sai — chặn cạnh dài, không chặn chiều rộng

Lệnh trong plan cố định **chiều rộng**. Đo thật: một screenshot dọc cho ra thumbnail
**320×693**, decode 887KB thay vì 307KB. Với thư viện 70k và bộ nhớ grid bám theo số ảnh
đã cuộn qua (Phase 5), đây là chi phí nhân lên hàng chục nghìn lần.

Sửa thành `scale=w=320:h=320:force_original_aspect_ratio=decrease` — lọt trong hộp 320×320.

| | Trung bình / ảnh | Ngoại suy 70k |
|---|---|---|
| `scale=320:-1` | 27,0 KB | 1.823 MB |
| Chặn cạnh dài | 16,6 KB | **1.119 MB** |

Ước tính 11,2KB của plan lấy từ một ảnh mẫu; con số thật trên thư viện là 16,6KB.
Vẫn dưới ngưỡng dọn 2GB, nên ngưỡng giữ nguyên.

### Chi tiết khác

- **Ghi ra `.tmp` thì ffmpeg không đoán được format** từ đuôi file và fail sạch. Phải thêm
  `-f image2`. Đây là chi phí của việc ghi atomic mà plan không nêu.
- **Kill theo process group** (`spawn` với `detached: true`, `process.kill(-pid)`) chứ không
  kill mỗi process cha — đúng phản ứng mà mục Risk yêu cầu.
- Hàng đợi hai mức làm bằng cách gắn cờ `priority` lên **hàm resolve** đang chờ, không phải lên
  promise: promise không mang được thông tin cho bên giải phóng semaphore đọc.
- Negative cache nằm trong RAM (`Set`), không ghi đĩa. Đủ cho yêu cầu "mỗi file hỏng chỉ spawn
  một lần"; ghi đĩa chỉ có ích khi khởi động lại app nhiều lần trên cùng thư mục rác.
- `sweep()` chạy một lần lúc khởi động; nếu cache >500MB mà chưa vượt ngưỡng thì CLI in dung
  lượng ra stdout — phản ứng cho rủi ro "770MB bất ngờ với user".

## Risk Assessment

**Rủi ro: ffmpeg treo trên file hỏng.** Đã có timeout, nhưng process zombie vẫn có thể tích tụ.
*Tín hiệu:* số process ffmpeg tăng dần, máy nóng.
*Phản ứng:* kill theo process group, kiểm tra bằng test tạo file hỏng cố ý.

**Rủi ro: 770MB cache bất ngờ với user.** Người dùng không mong app chiếm ngần đó đĩa im lặng.
*Tín hiệu:* phàn nàn về dung lượng.
*Phản ứng:* in dung lượng cache khi khởi động nếu vượt 500MB, và cung cấp `gal --clear-cache`.
