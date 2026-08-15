---
phase: 8
title: "Trạng thái, a11y, polish"
status: completed
priority: P1
effort: "2.5d"
dependencies: [5, 6, 7]
---

# Phase 8: Trạng thái, a11y, polish

## Overview

Chín trạng thái bắt buộc, accessibility, và lớp hoàn thiện thị giác. UI trông nghiệp dư gần như
luôn vì thiếu mấy trạng thái này chứ không phải vì chọn màu xấu — nên đây không phải phase "trang trí".

## Requirements

Toàn bộ 9 trạng thái ở `docs/design-guidelines.md` §6, sàn a11y §7, và checklist §9.

## Architecture

### Chín trạng thái

| Trạng thái | Yêu cầu |
|---|---|
| Đang scan, chưa có ảnh | Skeleton lưới nhịp thở, **không** spinner giữa màn |
| Đang scan, đã có ảnh | Ảnh hiện dần + sợi tiến trình 2px mép trên |
| Thumbnail chưa sinh | Ô giữ đúng tỉ lệ, nền `--bg-sunken`, shimmer nhẹ |
| Chưa biết tỉ lệ | Ô vuông 1:1 tạm, re-layout khi có số thật, không nhảy scroll |
| Ảnh hỏng | Icon + tên file, không phải ô trống câm |
| Thư mục không có media | Nêu đường dẫn đã quét, **số bundle đã bỏ qua**, gợi ý `--include-bundles` |
| Không quyền đọc | Nêu đúng đường dẫn bị chặn + cách cấp quyền trên macOS |
| Bộ lọc không khớp | Nêu bộ lọc đang áp + nút xoá một click |
| Video đang tải | Poster frame + control, không phải khung đen |

Trạng thái "thư mục không có media" đặc biệt quan trọng: trên máy đo, phần lớn 70k ảnh nằm
trong `.photoslibrary` bị bỏ qua mặc định, nên user mở `~/Pictures` **sẽ** gặp trạng thái này.
Nếu nó chỉ nói "không có ảnh" thì đó là bug trải nghiệm, không phải thông báo.

### Accessibility — sàn không thương lượng

- Focus ring luôn thấy: 2px accent + 2px offset. Không bao giờ `outline: none` mà không thay thế.
- **Lưới ảo hoá phải quản lý focus thủ công** — đây là chỗ virtual scroll hay phá a11y:
  ô đang focus bị ảo hoá ra khỏi DOM thì focus rơi về `body`, người dùng bàn phím mất vị trí.
  Giải pháp: giữ ô đang focus trong DOM dù ra ngoài viewport, và **pool DOM phải gắn theo id**
  (Phase 5) — pool theo chỉ số làm focus nhảy sang ảnh khác khi layout đổi.
- **Không dùng ARIA `grid`.** Pattern `grid` giả định số ô mỗi hàng đều nhau; lưới justified có
  số ô thay đổi từng hàng, khai báo `grid` sẽ khiến screen reader đọc sai toạ độ hàng/cột.
  Dùng `role="list"` + `role="listitem"` với `aria-setsize`/`aria-posinset` để báo đúng
  "ảnh thứ N trên tổng M" — đúng ngữ nghĩa cho một dòng ảnh, và không hứa cấu trúc bảng không có thật.
- Lightbox là focus trap thật, `Esc` thoát, focus trả về đúng thumbnail.
- Mọi thumbnail có `alt` = tên file + ngày. Icon-only button có `aria-label`.
- Tiến trình scan qua `aria-live="polite"`, **throttle 5s** — không phải mỗi ảnh, nếu không
  screen reader đọc liên tục không dứt.
- Zoom trình duyệt 200% không vỡ layout.

### Polish thị giác

Theo design guidelines: chrome không màu, một accent duy nhất, gap lưới 2px, radius thumbnail 2px,
shadow ngắn và chặt (không phải shadow mờ to), số dùng `tabular-nums`.

Chống AI-slop (§8): không emoji làm icon, không gradient tím-xanh, không hover scale 1.05 trên
thumbnail (làm vỡ lưới justified — dùng đổi độ sáng).

## Related Code Files

- Modify: `web/grid.js` (roving tabindex, giữ ô focus trong DOM, aria-posinset, ô hỏng)
- Modify: `web/app.js`, `web/index.html`, `web/styles.css` (9 trạng thái, live region, `?state=`)
- Modify: `src/walk.js`, `src/scan.js` (báo root + thư mục bị từ chối cho empty state)
- Modify: `src/server.js` (thumbnail hỏng trả 404 thay vì redirect)
- Create: `test/a11y.test.js` (grep tĩnh + Chrome thật, chạy trong `npm test`)
- **Không tạo**: `web/states.js`, `web/a11y.js` (xem Kết quả thực tế)

## Implementation Steps

1. Dựng từng trạng thái một, có cách kích hoạt thủ công để kiểm tra (query param `?state=`).
2. Quản lý focus lưới: giữ ô focus trong DOM pool dù ngoài viewport.
3. `aria-live` cho tiến trình scan, throttle 5s.
4. Rà `outline: none` trong CSS — mỗi chỗ phải có thay thế nhìn thấy được.
5. Kiểm contrast bằng script tính WCAG (đã có công thức dùng lúc soạn design guidelines).
6. Chạy checklist §9 của design guidelines, đánh dấu từng mục.
7. Test thủ công với VoiceOver: duyệt lưới, mở lightbox, đóng lại.

## Success Criteria

- [x] Đủ 9 trạng thái, mỗi trạng thái kích hoạt và xem được
- [x] Empty state của `~/Pictures` nêu rõ số bundle đã bỏ qua và cách quét vào
- [x] Tab qua lưới: focus luôn nhìn thấy, không rơi về `body` khi ô bị ảo hoá
- [x] Lightbox: focus trap đúng, `Esc` trả focus về thumbnail nguồn
- [ ] VoiceOver đọc được tên + ngày ảnh; tiến trình scan không đọc dồn dập
- [x] Zoom browser 200% → không vỡ layout, không cuộn ngang
- [x] `prefers-reduced-motion` → tắt stagger và FLIP, giữ crossfade 80ms
- [x] Không `outline: none` nào thiếu thay thế (grep chứng minh)
- [x] Không animate `width`/`height`/`top`/`left` (grep chứng minh)
- [ ] Toàn bộ checklist §9 design guidelines đạt
- [ ] Người chưa từng thấy app: xem được ảnh, đổi cỡ lưới, mở full-screen trong 10 giây, không hỏi

## Kết quả thực tế

**Không có `states.js` / `a11y.js`.** Chín trạng thái là markup tĩnh cộng vài lớp CSS
bật/tắt — gói chúng vào một module "component" chỉ thêm một tầng gọi hàm. Quản lý focus
thuộc về lưới ảo hoá (nó mới biết ô nào còn trong DOM), nên nằm trong `grid.js`.

**Roving tabindex + ghim ô đang focus.** Trước đó mọi ô đều `tabindex=0`: Tab qua thư
viện 70k là 70k lần bấm, và cuộn xa làm ô đang focus bị ảo hoá đi khiến focus rơi về
`<body>`. Nay cả lưới là một điểm dừng Tab, ô mang focus luôn được giữ lại trong DOM
dù đã ra ngoài viewport, mũi tên điều hướng bên trong.

**Thumbnail hỏng: server đổi 302 → 404.** Redirect sang `broken.svg` làm `<img>` báo
LOAD THÀNH CÔNG, client không phân biệt nổi với thumbnail thật nên không thể vẽ trạng
thái hỏng. 404 để `onerror` bắn, client vẽ icon + tên file. Đơn giản hơn (bớt một
round-trip) và `test/host-guard.test.js` đã cập nhật theo.

**Hai vi phạm design guidelines tự tìm ra bằng chính test mới:**
`.scan` animate `width` (giờ là `transform: scaleX`) và `#scroller` animate `left` khi
mở panel thư mục (bỏ hẳn transition). Cả hai giờ có test grep chặn tái diễn.

**`?state=`** ép từng trạng thái để xem: `scanning`, `bundles`, `denied`, `empty`, `filter`.

## Kiểm chứng còn thiếu

- VoiceOver: chưa thử tay. Test tự động chỉ chứng minh `aria-posinset`/`aria-setsize`/
  `alt` đúng và live region throttle, không thay được một lần nghe thật.
- "10 giây không cần hỏi": chưa thử với người thật, và không tự chấm điểm cho mình được.

## Risk Assessment

**Rủi ro: focus trong lưới ảo hoá là bài toán khó bị đánh giá thấp.** Research cảnh báo đây là
phần "chán" mà thư viện đã hardened còn code tự viết thì chưa.
*Tín hiệu:* tab vào lưới rồi mất focus, hoặc tab qua 70k ô.
*Phản ứng:* lưới là một composite widget — chỉ một tab stop (roving tabindex), điều hướng bên
trong bằng phím mũi tên. Ô đang focus luôn được giữ trong DOM dù ra ngoài viewport.

**Rủi ro: tiêu chí "10 giây không cần hỏi" mang tính chủ quan.**
*Tín hiệu:* không có, vì không đo được bằng máy.
*Phản ứng:* thử với ít nhất 2 người thật chưa xem app. Không tự chấm điểm cho mình.
