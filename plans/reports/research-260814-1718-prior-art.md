# Prior-art survey — does `gal <path>` need to be built?

Ngày: 2026-08-14. Contract: [brainstorm-260814-1718-gal-media-gallery.md](brainstorm-260814-1718-gal-media-gallery.md)

Test contra mỗi candidate: **1 lệnh, 0 config, 0 import, 0 daemon nền, quét đệ quy, ảnh đầu <1s, HEIC, video seek, UI hạng Google Photos.**

## Self-hosted photo servers (DB-backed, "server" tier — fail zero-daemon/zero-import ngay từ kiến trúc)

| Tool | Friction | Recursive no-import | UI | HEIC | Video | Scale | License | Status |
|---|---|---|---|---|---|---|---|---|
| [immich](https://docs.immich.app/features/libraries/) | Docker Engine 25+, 6-8GB RAM, Postgres+ML container | Có "External Library" nhưng vẫn phải tạo qua admin UI + index job chạy nền (không phải "mở path là xong") | Rất tốt, đúng kiểu Google Photos | Có | Có, transcode | 50k+ tốt | AGPL | Active, rất mạnh |
| [PhotoPrism](https://docs.photoprism.app/developer-guide/media/heif/) | Docker + MariaDB, cấu hình originals/import folder, phải "Index" thủ công lần đầu | Không — model là originals dir cố định, không phải "trỏ path bất kỳ" | Tốt | Có (docker image có patch) | Có | Tốt | Non-free (own license), core free | Active |
| [Photoview](https://github.com/photoview/photoview) | Docker + MySQL, trỏ thư mục, "scanner" chạy nền tự phát hiện file mới | Đệ quy tốt, tự update — nhưng vẫn cần DB + docker-compose, không phải 1 lệnh | Khá, đơn giản | Không rõ, không nổi bật trong docs | Có, hạn chế | Nhỏ-vừa | GPLv3 | Active, chậm |
| LibrePhotos | Docker + Postgres, AI face/object nặng | Scan filesystem, đa user | Trung bình | Có | Có | Vừa | AGPL | Active nhưng nặng |
| Piwigo | Web install (PHP+MySQL), upload-centric, video cần plugin | Không, model upload/import | Cũ kỹ | Từ v14 | Cần plugin VideoJS | Vừa | GPL | Active, lâu đời |
| Lychee | "Cài trong vài giây" nhưng vẫn cần web server+DB, upload-centric | Không | Khá | Giới hạn | Có | Vừa | MIT | Active |

Tất cả 6 tool này đều **fail hard constraint "no daemon, no import, no config"** — cần Docker/DB/admin setup trước khi xem được ảnh đầu tiên. Loại khỏi so sánh nghiêm túc với `gal`.
Sources: [docs.immich.app](https://docs.immich.app/features/libraries/), [PhotoPrism HEIF docs](https://docs.photoprism.app/developer-guide/media/heif/), [photoview/photoview](https://github.com/photoview/photoview), [Piwigo formats](https://doc.piwigo.org/import-and-manage-photos/file-formats-compatible-piwigo).

## Zero-config / CLI-first (tier đáng so sánh nhất)

| Tool | Friction | Recursive | Progressive/instant | UI | HEIC | Video | Scale ceiling | License | Last release |
|---|---|---|---|---|---|---|---|---|---|
| **[PiGallery2](https://github.com/bpatrik/pigallery2)** | `npm install` + start, hoặc docker; Docker "recommended", native install docs đánh dấu "unsupported" | Có, "directory-first", đệ quy | On-demand thumbnail theo viewport (giống pha C của Gal) khi scroll, nhưng **vẫn index vào SQLite/MySQL trước** — không phải progressive-stream pha A/B như contract | Grid đơn giản, không có justified/masonry, không lightbox cao cấp | Có nhưng "phụ thuộc vips build của docker container" — bấp bênh | mp4/webm, transcode qua ffmpeg | Thiết kế cho Raspberry Pi, không benchmark 70k | MIT | 2,959 commits, active |
| [miniserve](https://github.com/svenstaro/miniserve) | 1 binary Rust, 1 lệnh, thật sự zero-config | Có (file listing đệ quy) nhưng **là file server thuần, không có thumbnail/grid/EXIF/lightbox** | N/A — không phải gallery | Không có UI ảnh, chỉ directory listing | Không xử lý | Không | Vô hạn (không xử lý gì) | MIT | Active |
| `npx serve` | 1 lệnh nhưng cũng chỉ static file server, không gallery UI, không thumbnail | Có | N/A | Không | Không | Không | N/A | MIT | Active |
| [sigal](https://github.com/saimn/sigal) | Python, cần build cả gallery trước (`sigal build`) rồi mới xem — không phải server tức thời | Đệ quy | Không — batch build toàn bộ trước, không progressive | Theme tĩnh, chọn được | HEIC từ v2.5 | Có | Không rõ, không thiết kế cho 10^5 | MIT | v2.5 active |
| [thumbsup](https://github.com/thumbsup/thumbsup) | Node CLI, build static site trước khi xem | Chỉ **1 cấp** subfolder → mỗi subfolder thành gallery riêng, không phải 1 view đệ quy toàn cây | Không, batch build | Rất đẹp, giống Google Photos nhất trong nhóm static-gen | Không rõ trong docs | Có | Không rõ | MIT | Active |
| [fgallery](https://github.com/wavexx/fgallery) | Perl script, build static | Không đệ quy sâu — gom ảnh phẳng theo thời gian chụp | Không, batch | Tối giản, đẹp kiểu minimalist | Không | Có | Nhỏ | GPL | Ít cập nhật |
| [fastgallery](https://github.com/tonimelisma/fastgallery) | Go binary, build static, nhanh | Đệ quy | Không, batch build trước | Hiện đại | Không rõ | Có | Tốt (Go, song song) | MIT | Active |
| N-Gallery / gallery-server / simple-photo-gallery (npm) | `npx <tool> --folder` | Nông, thường 1-2 cấp, thiết kế demo | Không progressive, quét hết mới render | Sơ sài | Không | Hầu như không | Nhỏ (<1k ảnh) | MIT (đa số) | Ít maintain, dự án nhỏ/side-project |
| ThinGallery | Single HTML file, dùng EXIF thumbnail nhúng sẵn trong JPEG, không cần server xử lý | Không đệ quy thật sự (dựa vào file listing của web server) | Nhanh vì không decode gì, nhưng bỏ qua RAW/HEIC/video hoàn toàn | Tối giản | Không | Không | Nhỏ | MIT | Side-project, không active |

Sources: [bpatrik.github.io/pigallery2/features](https://bpatrik.github.io/pigallery2/features/), [svenstaro/miniserve](https://github.com/svenstaro/miniserve), [saimn/sigal README](https://github.com/saimn/sigal/blob/main/README.rst), [thumbsup.github.io](https://thumbsup.github.io/), [wavexx/fgallery](https://github.com/wavexx/fgallery/blob/master/README.rst), [tonimelisma/fastgallery](https://github.com/tonimelisma/fastgallery), [gfwilliams/ThinGallery](https://github.com/gfwilliams/ThinGallery).

## macOS-native

| Tool | Model | Fit với contract |
|---|---|---|
| Photos.app | Import bắt buộc vào thư viện riêng, không browse folder tuỳ ý | Vi phạm "no import" hoàn toàn |
| [ApolloOne](https://allmacsoft.com/apolloone) | Desktop app (không phải browser), đọc trực tiếp cấu trúc folder hiện có, **không import DB**, rất nhanh, có EXIF/culling | Gần nhất về triết lý "point at folder, no import" nhưng **không phải browser gallery, không phải CLI, trả phí, không đa nền tảng ra ngoài mac** |
| Peakto | Catalog aggregator cho Lightroom/Capture One/Photos, không phải trình xem file thô | Không match, target khác (quản lý catalog có sẵn) |
| Lyn | App xem ảnh macOS cũ, không tìm thấy info cập nhật 2026, coi như không active | Không đáng xét |

## Trả lời trực tiếp

**1. Có tool nào thoả contract không?** Không. Không tool nào đạt đồng thời cả 4: (a) một lệnh không cần Docker/DB/import, (b) đệ quy toàn cây không giới hạn cấp, (c) progressive — ảnh đầu <1s không chờ index/build xong, (d) UI hạng Google Photos (justified/masonry, lightbox mượt, timeline theo EXIF). Server-tier (immich, PhotoPrism, Photoview, LibrePhotos, Piwigo, Lychee) fail (a) vì cần Docker+DB+admin setup. Static-gen tier (sigal, thumbsup, fgallery, fastgallery) fail (c) vì phải build/index xong toàn bộ trước khi xem được gì — đúng cái antipattern "đang index, vui lòng chờ" mà contract cấm. thumbsup còn fail (b), chỉ đệ quy 1 cấp. miniserve/npx serve fail (d) — không có xử lý ảnh gì cả. PiGallery2 là gần nhất: 1 lệnh (npm), đệ quy, viewport-driven thumbnail — nhưng vẫn có bước index-vào-DB trước khi grid render (không stream pha A/B như contract), UI chỉ 1 grid mode không có masonry/justified, HEIC bấp bênh (phụ thuộc build vips của docker), và docs tự đánh dấu native install "unsupported" nên không thật sự zero-friction ngoài docker. ApolloOne gần nhất về triết lý "point-at-folder, no-import" nhưng là desktop app trả phí, không phải browser/CLI.

**2. Gap cụ thể — lý do Gal tồn tại:** Không có tool nào kết hợp "chạy 1 lệnh, không setup gì, xem được ảnh đệ quy từ path bất kỳ ngay lập tức trong <1s trong khi vẫn đang quét nền" — cái gần nhất (PiGallery2) vẫn có bước index-to-DB chặn trước khi render, các server-tier cần hạ tầng nặng (Docker+DB+admin UI) hoàn toàn trái với "1 lệnh không config", và các static-gen tier là batch-build nên không progressive theo định nghĩa. Đây chính là gap: **stream 3-pha (walk → header → thumbnail on-demand) phục vụ trực tiếp không qua DB, để lấp khoảng "ảnh đầu tiên xuất hiện <1s trên tập 70k file mà không chờ bất kỳ bước index toàn cục nào" — không tool nào trong khảo sát này làm đúng combo đó.**

**3. Đáng "cắp" ý tưởng gì:**
- **thumbsup** — UI/timeline đẹp nhất nhóm static-gen, đáng tham khảo cách group theo ngày + lightbox, dù kiến trúc batch-build không dùng được.
- **PiGallery2** — cơ chế "on-demand rendering (on scroll), prioritizes visible photos" cho thumbnail chính là pha C của contract (viewport-driven); đáng xem code của họ cách họ track viewport→priority queue.
- **ApolloOne** — triết lý "operate directly on existing folder structure, zero import" là đúng tinh thần Gal; đáng tham khảo tốc độ UI native của họ làm chuẩn UX để nhắm tới (dù thực thi khác — web vs native).
- **fastgallery (Go)** — đáng xem cách họ song song hoá xử lý ảnh hàng loạt nhanh (ffmpeg/Go concurrency) làm tham chiếu benchmark cho pha C của Gal.

## Unresolved / không cover
- Không cài thử trực tiếp bất kỳ tool nào trên máy (chỉ dựa README/docs/search) — số liệu tốc độ thực tế trên 70k file của PiGallery2/immich không verify được, chỉ trích claim từ docs.
- Không khảo sát app thương mại ngoài Apple ecosystem (vd Windows-only tools) vì out of scope contract (macOS).
- Elodie, gallery-dl viewers: không tìm thấy bằng chứng chúng có UI gallery browser (Elodie là organizer CLI di chuyển file theo EXIF date, không phải viewer; gallery-dl là downloader, không có viewer riêng) — loại khỏi bảng vì không match category.

Status: DONE
Summary: Khảo sát 15+ tool qua 3 tier (self-hosted server, CLI/static-gen, macOS-native); không tool nào thoả đồng thời 1-lệnh + đệ quy + progressive + UI hạng Google Photos — PiGallery2 gần nhất nhưng vẫn index-blocking và thiếu justified/masonry layout. Gap xác nhận: Gal có lý do tồn tại.
Concerns: Đánh giá dựa trên docs/README, chưa cài thử thực tế; nếu cần độ tin cậy cao hơn nên pull PiGallery2 và chạy thử trên `~/Pictures` thật trước khi final quyết định không build lại phần nào của nó.
