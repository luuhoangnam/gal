# Brainstorm — Gal: local media gallery, một lệnh

Ngày: 2026-08-14. Trạng thái: contract đã chốt, **tech stack chưa chốt** (chờ `/ak:research`).

## Outcome

`gal <path>` → mở browser hiển thị **toàn bộ ảnh/video trong path và mọi thư mục con**,
giao diện chất lượng Google Photos. Không cần config, không cần import, không cần server chạy nền.

Ba USP:
1. Đệ quy toàn bộ cây thư mục, không chỉ thư mục hiện tại.
2. UI/UX xuất sắc.
3. Cảm giác tức thì nhờ progressive scanning — thấy ảnh ngay, không chờ index xong.

## Constraints (evidence-backed)

| Ràng buộc | Bằng chứng đo được trên máy này |
|---|---|
| Scale 10⁴–10⁵ file | `~/Pictures` = 70,766 media |
| Walk cây thư mục rẻ | `find ~/Pictures` = **0.15s** cho toàn cây |
| Thumbnail phải sinh sẵn | 70k ảnh full-res không thể serve raw cho browser |
| ffmpeg 9 có sẵn, lo cả ảnh+video | HEIC→jpg **44ms**, video frame **71ms** |
| HEIC bắt buộc | Đa số ảnh trong `~/Pictures` là HEIC; browser không render được |
| Package bundle phải skip | `.photoslibrary` là thư mục thật, walk vào sẽ nổ ra hàng chục nghìn file rác |
| Localhost only | Bind 127.0.0.1, port ngẫu nhiên, không token. App phục vụ file tuỳ ý trên ổ đĩa. |
| Node v26 / Python 3.14 / ffmpeg 9 sẵn có | `node -v`, `python3 -V`, `ffmpeg -version` |

## Non-goals (v1)

Sửa/xoá/xoay file · upload · face/object recognition · albums do user tạo · sync hay cloud ·
multi-user, auth, account · truy cập từ máy khác (LAN) · app đóng gói (Electron/menubar).

## Acceptance criteria

1. `gal ~/Pictures` → ảnh đầu tiên hiện trên màn hình **< 1s**, không chờ scan xong.
2. Với 70k file: scroll 60fps, RAM tab < 500MB, DOM node < 2000 tại mọi thời điểm.
3. Timeline group theo ngày/tháng/năm, sticky header, thứ tự đúng theo ngày chụp (EXIF), không phải ngày copy file.
4. Ba grid mode: justified rows (giữ tỉ lệ) / square / masonry — đổi mode không reload, không nhảy vị trí scroll.
5. Filter: type (ảnh/video), cây thư mục con, date range, size — kết hợp được, áp dụng < 100ms.
6. Lightbox: full-screen, ←/→/Esc/space, zoom+pan, prev/next **không chớp trắng, không giật**; video seek được (tua giữa file 2GB phải nhảy ngay).
7. HEIC hiển thị được. Video có poster frame trong grid.
8. Mở lại cùng thư mục lần 2 → grid đầy đủ gần như tức thì (cache còn hiệu lực).
9. Không crash trên: symlink loop, tên file có emoji/dấu, file 0 byte, ảnh hỏng, thư mục không quyền đọc.

## Quyết định kiến trúc (không phụ thuộc stack)

Đây là ràng buộc mà bất kỳ stack nào `/ak:research` chọn cũng phải thoả.

### 1. Progressive scanning — 3 pha, stream liên tục

Đây là điểm sống còn của USP #3. Không được có bước "đang index, vui lòng chờ".

```
Pha A  walk cây thư mục       →  path, size, mtime           ~0.15s/70k   → stream ngay, grid render liền
Pha B  đọc header từng file   →  width, height, EXIF date    ~1-3ms/file  → stream patch, grid re-layout dần
Pha C  sinh thumbnail         →  jpg 320px trong cache        ~50ms/file   → chỉ cho item đang trong viewport
```

- Pha A/B stream về client theo batch (server-sent events hoặc tương đương), **không** chờ hoàn tất.
- Pha B chỉ đọc **header** file, không decode toàn ảnh.
- Pha C **on-demand, viewport-driven** — không warm toàn bộ 70k. Client báo vùng đang xem, server ưu tiên sinh thumb vùng đó, concurrency = số core.
- Grid phải chịu được item chưa biết dimension (dùng placeholder tỉ lệ 1:1, re-layout khi pha B trả về mà không nhảy scroll).

### 2. Ngày chụp: EXIF, fallback mtime

`mtime` sai bét khi file được copy/download. Timeline mà sai ngày thì mất luôn giá trị.
→ Pha B đọc `DateTimeOriginal` (JPEG APP1 / HEIC meta / video creation_time). Không có thì mới rơi về mtime.

### 3. Thumbnail cache trên đĩa

`~/.cache/gal/<hash(path+mtime+size)>.jpg`. Key gồm mtime+size nên file đổi là tự invalidate.
ffmpeg lo cả ảnh, HEIC lẫn video frame → một code path, không thêm image library.

### 4. Index cache để lần mở sau instant

Lưu kết quả pha A+B theo thư mục gốc. Lần mở sau: nạp cache → render ngay → chạy lại pha A nền để phát hiện file mới/mất.

### 5. Walk phải an toàn

Skip: hidden dir, `node_modules`, bundle macOS (`.photoslibrary`, `.app`, `.fcpbundle`), symlink đã thăm (theo dev+inode).
Thư mục không quyền đọc → bỏ qua, không dừng scan.

### 6. Serve file phải hỗ trợ HTTP Range

Bắt buộc, nếu không video không seek được. Kèm chặn path traversal: mọi path phải nằm trong root đã cho.

### 7. Lightbox mượt

Preload ±2 ảnh kế tiếp và `decode()` xong mới swap → prev/next không chớp trắng.
Video dùng element native + Range request. Ảnh full-res load sau, hiện thumb phóng to trước (progressive, không màn hình trắng).

## Rủi ro chưa giải quyết

- **Justified layout + progressive dimension** là chỗ dễ hỏng nhất: layout phải ổn định khi dimension về muộn. Nếu quá khó, fallback square grid cho tới khi pha B xong cho vùng đó.
- Ảnh trong `.photoslibrary` bị skip theo mặc định → user có thể thấy "thiếu ảnh". Cần cờ opt-in để quét vào bundle.
- Chưa đo pha B trên 70k file thật (ước lượng 1-3ms/file → ~1-3 phút nền). Cần benchmark trước khi chốt.

## Handoff

1. `/ak:research` — chốt tech stack. Tiêu chí bắt buộc: chạy được bằng một lệnh không cần cài đặt thủ công, stream progressive, virtual scroll 70k item 60fps, và đủ sức làm UI/UX hạng nhất.
2. `/ak:plan` — sau khi có stack.
