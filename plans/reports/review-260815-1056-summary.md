# Code review tổng hợp — gal @ main (4 reviewer song song)

`npm test`: 119/119 pass, 8.9s (Node 26.7.0, macOS). Có 1 flake: `test/watcher.test.js:10` fail ở lần chạy full đầu tiên, pass khi chạy riêng.

Báo cáo chi tiết:
- [server + security](review-260815-1056-server-security.md)
- [scan + index](review-260815-1056-scan-index.md)
- [frontend](review-260815-1056-frontend.md)
- [tests + packaging](review-260815-1056-tests-packaging.md)

## Kết luận

Lõi bảo mật **vững**: path traversal, symlink escape, allowlist đuôi file, guard Host/Origin/Sec-Fetch 3 lớp — bị tấn công trực tiếp, không thủng. Không có XSS: mọi chuỗi từ filesystem vào DOM qua `textContent`/`alt`/`append`.

Chỗ hỏng nằm ở **resource lifecycle và error path**, không phải ở trust boundary.

## Critical — chặn release (6)

| # | Vị trí | Lỗi | Hậu quả |
|---|---|---|---|
| C1 | `src/scan.js:35` | `batch.map((b,k)=>({...b,i:-k}))`, `batch` reset mỗi 500 item → id lặp `0..-499` từng batch | Instance thứ 2 trên cùng thư mục (mode read-only) chỉ hiện ≤500/12.000 ảnh rồi báo "xong". Mất dữ liệu im lặng |
| C2 | `src/scan.js:77` | `promise.catch()` không push gì vào `log` | Mọi throw kết thúc NDJSON với HTTP 200; client render thư viện cụt như đã hoàn tất. Với tới được qua TOCTOU `index-db.js:31` → `SQLITE_BUSY` |
| C3 | `src/range.js:85,94` `src/server.js:114,136` | `.pipe(res)` không destroy source khi client bỏ đi | Rò fd mỗi request bị huỷ — scroll grid huỷ load `<img>`, seek video huỷ Range request. Đích đến là `EMFILE`. Fix: `pipeline()` |
| C4 | `src/server.js:143` | `await once(res,'drain')` không settle trên `close` | Handler `/api/scan` treo vĩnh viễn khi client disconnect; guard `res.destroyed` ở `:254/:260` không bao giờ tới lượt. `scanner.reset()` không chạy → lần scan sau phát lại log cũ |
| C5 | `web/feed.js` untracked, `web/app.js:59` `await import('./feed.js')` | File chưa commit nhưng đường dẫn cài duy nhất trong README là `git clone` | Clone mới 404 ở mọi lần mở tile trên mobile; không có `.catch()` nên tap im lặng không làm gì. `npm pack` lại *có* file → tarball và git khác nhau |
| C6 | `package.json:10`, `bin/gal.js:6-13`, `README.md:40` | `node:sqlite` chỉ unflag từ 22.13.0, không phải 22.0 | Trên Node 22.0–22.12 (gồm bản LTS 22.11) mọi guard pass rồi chết bằng đúng cái `ERR_UNKNOWN_BUILTIN_MODULE` mà `bin/gal.js` định chặn |

## Important (chọn lọc)

**Đúng đắn**
- `web/feed.js:44-47,64-66` ghim index mảng trong khi grid rebuild bên dưới (`app.js:139-151` re-sort mỗi 250ms ở pha B). `if (slides.has(i)) return` không remount → ảnh cũ + tên/ngày của file khác. Cũng dính khi `--watch`
- `web/app.js:56-63` guard `if (feed === null)` đặt *trước* `await import()` → double-tap tạo 2 instance trên cùng `#feed`, rò listener `popstate`/`resize`. Fix: memo hoá promise. `openLightbox` cùng hình dạng
- `web/app.js:440-446` `applyViewport` không restore `mode` → qua mốc 700px rồi quay lại, desktop kẹt ở `square`
- `src/walk.js` symlink loop nhân đôi index rows + nhân đôi spawn ffmpeg (chứng minh empiric); `test/walk.test.js:86` assert `out.length < 50` nên vẫn xanh
- Cache invalidation bỏ qua `size` trong khi `thumbKey` lại có → `cp -p` cho thumbnail mới trong khung hình cũ
- EXIF `0000:00:00` → 1899-11-29, QuickTime `1904-01-01` → 1904, cả hai gắn cờ `DATE_EXIF`
- `ffprobe` tìm trên PATH trần còn ffmpeg có fallback Homebrew → mở từ GUI thì toàn bộ metadata video null im lặng
- ffmpeg `detached: true` bị orphan quá timeout khi Ctrl-C

**A11y — regression từ chính diff này**
- `web/index.html:46` gỡ `hidden` khỏi `#side`; `styles.css:785-808` đóng sheet chỉ bằng `transform: translateY(101%)` → folder list và toàn bộ filter input đóng vẫn nằm trong tab order và a11y tree
- `web/index.html:116` `#feed` có `aria-label` nhưng thiếu `role`/`aria-modal`, không inert background → Tab thoát ra `#scroller` trong khi `keyboard.js:20` chặn phím grid; Escape chết vì handler gắn trên `root`

**Vận hành / release**
- `--port 80` → 403 mọi request (browser bỏ `:80`, `hostAllowed` khớp `${n}:${port}` không bao giờ trúng)
- Host allowlist là snapshot lúc khởi động → đổi Wi-Fi/DHCP là `--lan` chết giữa chừng
- `src/cache-dir.js:25` fallback `/tmp/gal/<path-phẳng>` đoán được, thư mục world-writable → user khác trên cùng máy pre-create/symlink để thu thumbnail ảnh riêng tư
- `bin/gal.js:16` không `await main()`, `sweep()` không `.catch()` → lỗi ra stack trace thô thay vì thông báo CLI đã soạn sẵn
- `README.md:36` "never writes to the folder" **sai**: `cache-dir.js:16-23` mkdir `<root>/.gal` + ghi file probe. Thiết kế `.gal` ổn — câu văn mới là lỗi. Tự mâu thuẫn với README.md:104-107
- Thiếu `repository`/`homepage`/`bugs`; `docs/` không có trong `files` → ảnh README vỡ trên npmjs

## Về chất lượng test

Không phải happy-path-only — `safe-path`, `range`, `host-guard`, `walk` test thật sự đối kháng, và **không reviewer nào tìm ra defect trong code trust-boundary**. Nhưng:

- Suite xanh khi vắng cả tầng: `a11y.test.js:74-79` bare-catch lỗi launch → 6 test browser biến mất; +6 thumbs +4 metadata skip khi không có ffmpeg. Không có CI ghim môi trường
- ffmpeg bị probe bằng binary này rồi gọi bằng binary khác: `thumbs.test.js:18` probe `ffmpegPath()` rồi chạy `ffprobe`; `metadata.test.js:17` ngược lại → fail cứng thay vì skip
- `watcher.test.js:13,24,35` dùng bare `return` thay `t.skip` → xanh rỗng
- `walk.test.js:99` (chmod 000), `cache-dir.test.js:17` (chmod 555) fail khi chạy as root — đúng trường hợp CI container
- Zero coverage: `src/scan.js`, `src/media-types.js`, `web/feed.js` (260 dòng), toàn bộ nhánh mobile của `app.js`, route `/api/watch`

## `.mov` → `video/mp4`: an toàn

Đã grep hết consumer (`range.js:4`, `server.js:14`, `walk.js:3`). `VIDEO_EXTS` derive bằng `startsWith('video/')` nên `.mov` vẫn là video; `classify` → `v:1` → `videoMeta` và nhánh thumbnail `info.kind === 1` không đổi; `needsTranscode` là list riêng; không test nào assert `quicktime`.

Lưu ý: phân loại giờ derive từ nhãn MIME, nên một lần đổi nhãn tương lai sẽ âm thầm đổi luồng pipeline. Đáng một test ghim.

## Trùng lặp / dead code

- Quy tắc đuôi-file-cần-transcode có 3 bản: `web/feed.js:14`, `web/lightbox.js:7`, `src/media-types.js:40`
- `src/cli.js:155-157` unreachable: `--clear-cache` tạo `<root>/.gal` trước khi xoá nó, báo "giải phóng 0.0 MB" cho thư viện chưa từng có cache
- `web/app.js:521,524` hook demo `?state=` với path `/Users/ai-do/Pictures` được ship

## Câu hỏi chưa giải quyết

1. Máy nhiều user có nằm trong threat model không? Quyết định này định đoạt fallback `/tmp` (I3 báo cáo server)
2. `web/feed.js` cố ý chưa commit (đang dở) hay quên `git add`?
