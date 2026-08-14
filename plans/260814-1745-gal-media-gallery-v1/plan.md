---
title: "Gal media gallery v1"
description: "Một lệnh `gal <path>` mở gallery web hiển thị đệ quy toàn bộ ảnh/video, chất lượng Google Photos, Node thuần zero-native-dep"
status: pending
priority: P1
effort: "~9-13 ngày"
tags: [cli, media, gallery, nodejs, frontend]
created: 2026-08-14
blockedBy: []
blocks: []
---

# Gal media gallery v1

## Overview

`gal ~/Pictures` → mở browser, hiển thị toàn bộ ảnh/video trong thư mục **và mọi thư mục con**,
giao diện chất lượng Google Photos. Không config, không import, không daemon.

Ba USP: (1) đệ quy toàn cây, (2) UI/UX xuất sắc, (3) tức thì nhờ progressive scanning.

Contract đầy đủ: [`plans/reports/brainstorm-260814-1718-gal-media-gallery.md`](../reports/brainstorm-260814-1718-gal-media-gallery.md)
Design: [`docs/design-guidelines.md`](../../docs/design-guidelines.md)

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Một lệnh, không bước cài đặt thủ công nào | P1 |
| 2 | Ảnh đầu tiên hiện <1s, không bao giờ có màn hình chờ chặn | P1 |
| 3 | 70k media: scroll 60fps, DOM <2000 node | P1 |
| 4 | Timeline đúng ngày chụp (EXIF), 3 grid mode, filter <100ms | P1 |
| 5 | Lightbox prev/next không chớp, video seek được | P1 |
| 6 | An toàn khi phục vụ file tuỳ ý trên ổ đĩa | P1 |
| 7 | UI light mode theo design guidelines, "no manual needed" | P2 |

## Kiến trúc

```
bin/gal.js  →  src/cli.js  →  src/server.js ──┬── GET /            web/ (static)
                                              ├── GET /api/scan    NDJSON stream (pha A+B)
                                              ├── GET /api/thumb   ffmpeg on-demand + cache
                                              └── GET /api/file    HTTP Range (video seek)

Pha A  walk.js          paths                    ~0.2s/70k   → stream ngay
Pha B  metadata.js      dims + ngày chụp         ~1-2ms/file → stream patch
Pha C  thumbs.js        JPEG 320px viewport-driven ~35ms/file → on-demand

index-db.js (node:sqlite)   ~/.cache/gal/index/<hash>.db   + thumbs/<hash>.jpg
```

Frontend: JS thuần, không framework. Virtualizer tự viết (spike đã chứng minh), PhotoSwipe v5 cho lightbox.

## Quyết định đã chốt (kèm bằng chứng)

| Quyết định | Bằng chứng |
|---|---|
| Node thuần, zero native dep | Quyết định của chủ dự án; research indexing chứng minh khả thi |
| **Không** dùng `justified-layout` | Bảo trì lần cuối 2022-06-19 (`npm view`); spike tự viết 15 dòng đạt 120fps |
| `exifreader`, **không** `exifr` | exifr hard-code `ftyp>50` → hỏng với mọi HEIC iPhone hiện đại (issue #138 + đọc source) |
| Tự viết ISO-BMFF box-walker cho video | ffprobe 25ms/spawn × 70k = 29 phút; `.mov` iPhone có `moov` ở **cuối** file |
| Thumbnail JPEG qua ffmpeg | ffmpeg 9 homebrew **không có** libwebp; AVIF chậm hơn 1,6× |
| **Bỏ** shortcut thumbnail nhúng | Đo thật: 39ms so với 32ms decode thẳng — phức tạp hơn, không nhanh hơn |
| `node:sqlite` | Đo thật: 70k insert 31ms, query khoảng ngày có index 1ms |
| NDJSON + `ReadableStream` | Backpressure native; SSE không có, WebSocket thừa |
| Host header validation **bắt buộc** | DNS rebinding: CVE thật của Vite (GHSA-vg6x-rcgg-rjx6) |
| `realpath` containment, không so chuỗi | Deno CVE-2026-49401; APFS case-insensitive |
| Neo scroll theo **id cố định** | Spike đo: dò lại ô neo gây trôi 187px sau 70 lần re-layout |
| Virtualizer tự viết | react-window rò DOM node (#433/#800); TanStack stutter (#832) |
| PhotoSwipe v5 cho lightbox | Zoom/pan đã hardened; chỉ cần bọc `decode()` + content-type video |

## Phases

| # | Phase | Status | Phụ thuộc |
|---|-------|--------|-----------|
| 1 | [CLI, server, security core](./phase-01-cli-server-and-security-core.md) | Pending | — |
| 2 | [Walker đệ quy + NDJSON stream](./phase-02-recursive-walker-and-ndjson-stream.md) | Pending | 1 |
| 3 | [Metadata pass + SQLite index](./phase-03-metadata-pass-and-sqlite-index.md) | Pending | 2 |
| 4 | [Thumbnail pipeline](./phase-04-thumbnail-pipeline.md) | Pending | 1, 3 |
| 5 | [Virtualized grid](./phase-05-virtualized-grid.md) | Pending | 2, 3 |
| 6 | [Lightbox + video](./phase-06-lightbox-and-video.md) | Pending | 1, 5 |
| 7 | [Filter, sort, group, điều hướng](./phase-07-filter-sort-group-and-navigation.md) | Pending | 5 |
| 8 | [Trạng thái, a11y, polish](./phase-08-states-accessibility-and-polish.md) | Pending | 5, 6, 7 |
| 9 | [Đóng gói, phân phối](./phase-09-packaging-and-distribution.md) | Pending | tất cả |

Phase 4 chạy song song được với 5 (khác file, khác tầng).

## Success Criteria

Trích từ contract, tất cả đều đo được:

- [ ] `gal ~/Pictures` trên máy sạch → ảnh đầu tiên <1s, không có wizard/form/settings
- [ ] 70k file: scroll 60fps, RAM tab <500MB, DOM <2000 node **với thumbnail JPEG thật**
- [ ] Timeline theo ngày chụp EXIF (không phải mtime), sticky header đúng
- [ ] 3 grid mode, đổi mode không reload, không nhảy scroll
- [ ] Filter type + thư mục + khoảng ngày + size, kết hợp được, <100ms
- [ ] Lightbox: ←/→/Esc/space, zoom+pan, prev/next không chớp trắng
- [ ] Video seek được giữa file 2GB (HTTP Range đúng, có `If-Range`)
- [ ] HEIC hiển thị được; video có poster frame
- [ ] Mở lại cùng thư mục lần 2 → grid đầy gần như tức thì
- [ ] Không crash: symlink loop, tên emoji/dấu, file 0 byte, ảnh hỏng, thư mục không quyền
- [ ] Request với `Host` lạ bị từ chối; path traversal bị chặn (có test)
- [ ] Trôi scroll tích luỹ <10px ở giữa thư viện suốt pha B
- [ ] Người chưa từng thấy app xem được ảnh trong 10 giây, không cần hỏi

## Rủi ro lớn nhất

1. **RAM với thumbnail thật** — spike đo 40MB nhưng dùng CSS gradient, không có bitmap decode.
   Đây là rủi ro perf lớn nhất còn lại. Đo ngay ở Phase 5, không để tới cuối.
2. **Box-walker video chưa từng được viết và đo** — research chỉ xác nhận vị trí `moov`, chưa parse `mvhd`/`tkhd`.
3. **Ngưỡng đọc 128KB cho HEIC EXIF dựa trên 1 file mẫu** — cần test trên vài chục file đa dạng.

## Giả định cần chủ dự án xác nhận

**ffmpeg: v1 yêu cầu ffmpeg hệ thống**, thiếu thì báo lỗi rõ kèm lệnh cài (`brew install ffmpeg`).
Phương án thay thế đã khảo sát: tự tải bản LGPL decode-only lần chạy đầu (~20-25MB, giống Playwright tải browser).
Chọn phương án đơn giản vì: không phụ thuộc mạng, không có câu hỏi license khi phát hành, ít code hơn.
Đánh đổi: người chưa có ffmpeg phải cài một lần — vi phạm nhẹ lời hứa "không ceremony".
Đảo quyết định này chỉ tốn công ở Phase 9, không ảnh hưởng phase khác.

<!-- slug: gal-media-gallery-v1 -->
