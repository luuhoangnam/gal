---
phase: 9
title: "Đóng gói, phân phối"
status: completed
priority: P1
effort: "1d"
dependencies: [1, 2, 3, 4, 5, 6, 7, 8]
---

# Phase 9: Đóng gói, phân phối

## Overview

Biến repo thành `npx gal ~/Pictures` chạy được trên máy người khác. Phase ngắn nhưng quyết định
liệu lời hứa "một lệnh" có thật hay không.

## Requirements

**Functional**
- `npx gal <path>` chạy được trên máy sạch có Node ≥22
- `gal --help`, `gal --version`, `gal --clear-cache`, `gal --include-bundles`, `gal --port <n>`
- Thiếu ffmpeg → thông báo lỗi hành động được, không phải stack trace
- README có ảnh chụp màn hình và một dòng lệnh duy nhất để bắt đầu

**Non-functional**
- Gói npm nhẹ (không kèm binary ffmpeg)
- Khởi động tới ảnh đầu tiên <1s trên thư viện đã index

## Architecture

### ffmpeg: yêu cầu bản hệ thống

**Đây là giả định cần chủ dự án xác nhận** (đã nêu ở `plan.md`).

Chọn: yêu cầu ffmpeg có sẵn trên `PATH`, thiếu thì báo lỗi rõ kèm lệnh cài.

```
gal: cần ffmpeg để tạo thumbnail.
  macOS:  brew install ffmpeg
  Ubuntu: sudo apt install ffmpeg
Đã tìm trong PATH: /usr/local/bin, /opt/homebrew/bin
```

Lý do chọn phương án này thay vì tự tải bản LGPL decode-only (~20-25MB) lần chạy đầu:
không phụ thuộc mạng, không có câu hỏi license khi phát hành, ít code hơn.
Đánh đổi thật: người chưa có ffmpeg phải cài một lần — **vi phạm nhẹ lời hứa "không ceremony"**.

Nếu chủ dự án muốn đảo, chi phí chỉ nằm ở phase này: thêm module tải + kiểm checksum + cache
vào `~/.cache/gal/bin/`. Không ảnh hưởng phase khác.

Lưu ý license nếu đảo: `ffmpeg-static` trên npm tải bản **GPL** (kèm libx264/libx265), và chính
maintainer xác nhận license BSD-3 của package không phủ binary đó. Muốn phát hành sạch phải
dùng bản LGPL decode-only.

### Gói npm

- `package.json`: `bin`, `files` (chỉ `bin/`, `src/`, `web/`), `engines.node >= 22`
- Dependency runtime tối thiểu: `exifreader`, `image-size`, `photoswipe`. Hết.
  Không `justified-layout` (đã loại ở Phase 5), không `better-sqlite3` (dùng `node:sqlite`),
  không framework frontend.
- Không build step. `web/` là JS thuần chạy thẳng trong browser.

**`npx` lần đầu tốn ~1-3s** cho registry lookup (npm/cli#7295) — không tránh được với hình thức
phân phối này, và vẫn rẻ hơn mọi lựa chọn có bước cài đặt.

## Related Code Files

- Modify: `package.json`
- Create: `README.md`, `LICENSE`
- Modify: `src/ffmpeg.js` (thông điệp lỗi hành động được)
- Modify: `src/cli.js` (`--help`, `--version`, `--clear-cache`, `--port`, `--include-bundles`)
- Create: `.npmignore` hoặc dùng `files` trong package.json

## Implementation Steps

1. Hoàn thiện parse cờ CLI; `--help` in ngắn gọn, có ví dụ.
2. Thông điệp thiếu ffmpeg: nêu đã tìm ở đâu, cách cài theo OS.
3. `npm pack` rồi cài từ tarball vào thư mục sạch, chạy thử — **cách duy nhất phát hiện thiếu
   file trong `files`**.
4. Thử trên tài khoản người dùng khác / máy khác nếu có, xoá `~/.cache/gal` trước.
5. README: một dòng lệnh, ảnh chụp lưới và lightbox, bảng phím tắt, mục xử lý sự cố.
6. Chọn license (MIT là mặc định hợp lý; lưu ý `exifreader` là MPL-2.0 — copyleft cấp file,
   dùng làm dependency không sửa đổi thì không lan sang code của mình).
7. README nêu rõ **v1 nhắm Chrome** và cần ffmpeg hệ thống — hai ràng buộc này phải nằm ở phần
   đầu, không giấu trong mục xử lý sự cố.

**Test (chốt ở validation 2026-08-15):** `node:test` builtin cho unit, Playwright cho các tiêu chí
đo được (60fps, trôi scroll, RAM, a11y). Không thêm test framework. **Không dựng CI** ở v1 —
repo chưa có remote, và số đo perf trên CI runner không đáng tin cho tiêu chí 60fps.

## Success Criteria

- [x] `npm pack` → cài vào thư mục sạch → `npx gal <path>` chạy được
- [x] Máy không có ffmpeg → thông báo rõ, exit code khác 0, không stack trace
- [x] `gal --help` in usage ngắn, có ví dụ
- [x] `gal --clear-cache` xoá cache **của thư mục đó** (`<root>/.gal`), in dung lượng đã giải phóng
- [x] `gal --port 8080` bind đúng cổng chỉ định
- [x] Xoá cache rồi chạy lại → vẫn đúng, chỉ chậm hơn
- [x] Gói npm không chứa test, không chứa `plans/`, không chứa `docs/wireframe/`
- [x] README có ảnh thật, không phải mô tả suông
- [ ] Chạy trên thư mục 5 ảnh và thư mục 70k ảnh đều đúng

## Kết quả thực tế

**`--clear-cache` đổi nghĩa.** Cache không còn nằm ở `~/.cache/gal` mà ở `<root>/.gal`
(hoặc `/tmp/gal/<path-phẳng>` khi thư mục chỉ đọc), nên lệnh này cần biết xoá cache CỦA
thư mục nào: `gal <thư mục> --clear-cache`.

**ffmpeg là bắt buộc, kiểm tra trước khi mở server.** Mọi thumbnail đều là một frame do
ffmpeg dựng — ảnh cũng như video — nên thiếu nó thì lưới toàn ô xám, khó hiểu hơn nhiều
so với một câu báo lỗi. `src/ffmpeg.js` bỏ `which` (không có trên Windows) và tự quét
PATH, cộng thêm `/opt/homebrew/bin` và `/usr/local/bin` trên macOS: process khởi động từ
GUI có PATH tối giản, chỉ tin PATH là bỏ sót ffmpeg đã cài.

**Kiểm tra Node đặt trong `bin/gal.js` trước mọi import.** `src/` kéo theo `node:sqlite`;
trên Node cũ hơn 22 import thẳng chỉ ném `ERR_UNKNOWN_BUILTIN_MODULE`, không nói được gì.

**`npm pack` + cài vào thư mục sạch: chạy được**, kể cả `/vendor/photoswipe/` —
`import.meta.resolve` tìm đúng gói trong layout đã cài. Kèm một test tĩnh đi theo mọi
import tương đối trong `src/`, `bin/`, `web/` và đối chiếu với `files` của package.json,
để lần sau thiếu file thì `npm test` báo chứ không phải người dùng báo.

## Risk Assessment

**Rủi ro: gói thiếu file, chỉ lộ khi cài từ tarball.** Chạy từ repo luôn đúng vì file nào cũng có.
*Tín hiệu:* `MODULE_NOT_FOUND` sau khi cài từ npm.
*Phản ứng:* bước `npm pack` + cài sạch là bắt buộc, không phải tuỳ chọn.

**Rủi ro: quyết định ffmpeg bị đảo muộn.**
*Tín hiệu:* người dùng thử đầu tiên phàn nàn phải cài ffmpeg.
*Phản ứng:* thêm tải LGPL decode-only. Đã cô lập trong phase này nên đảo được mà không lan.

**Rủi ro: Node <22 trên máy người dùng** → `node:sqlite` không tồn tại.
*Tín hiệu:* lỗi import khi khởi động.
*Phản ứng:* `engines` chặn từ npm, và kiểm tra version lúc chạy với thông điệp rõ.
