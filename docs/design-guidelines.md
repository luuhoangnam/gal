# Gal — Design Guidelines

Nguồn chân lý về UI/UX. Mọi component phải trích được về một quy tắc ở đây.

Hai ràng buộc chi phối toàn bộ tài liệu:
1. **UI biến mất.** Ảnh của người dùng là thứ duy nhất có màu trên màn hình.
2. **Không cần hướng dẫn.** Không có tour, không có onboarding, không có màn hình cài đặt lúc mở lần đầu.

---

## 1. Nguyên tắc nền

### 1.1 Chrome không màu

Mọi màu UI phát ra đều cạnh tranh với ảnh. Vì vậy toàn bộ chrome là thang xám trung tính.
Ngoại lệ **duy nhất**: một accent color, chỉ dùng cho focus ring, selection và trạng thái active — không bao giờ dùng để trang trí.

Cấm: gradient trang trí, glow, glassmorphism trên nền ảnh, viền phát sáng, màu thương hiệu trên thanh công cụ.
Lý do: những thứ này làm lệch cảm nhận màu của ảnh và lỗi mốt trong vòng 2 năm.

### 1.2 Lưới sáng, lightbox tối

Mặc định sáng. Nhưng **lightbox thì tối** — khi xem một ảnh full-screen, nền sáng bao quanh làm mắt điều tiết sai và ảnh trông nhạt. Apple Photos làm đúng vậy: chrome sáng, chế độ xem đơn ảnh thì tối đi. Đây là hai ngữ cảnh khác nhau, không phải hai theme.

```
--bg-canvas:    #FBFBFD   /* nền lưới ảnh */
--bg-surface:   #FFFFFF   /* toolbar, panel, sheet — nổi trên canvas */
--bg-sunken:    #F2F2F5   /* ô thumbnail chưa có ảnh, track thanh cuộn */
--bg-immersive: #0A0A0B   /* NỀN LIGHTBOX — chỉ dùng ở đây */
```

Canvas không dùng trắng tinh `#FFFFFF`: cần chừa `#FFFFFF` cho bề mặt nổi, nếu không toolbar và nền lẫn vào nhau và mất hoàn toàn phân lớp.

### 1.3 Thang chữ — đã tính, không phải ước lượng

Số liệu dưới đây tính bằng công thức WCAG 2.x trên nền `--bg-canvas`:

```
--fg-primary:   #1D1D1F   /* 16.28:1 */
--fg-secondary: #5A5A5F   /*  6.63:1 — meta, đếm số */
--fg-tertiary:  #6E6E73   /*  4.91:1 — sàn, không xuống thấp hơn */
--fg-disabled:  #A1A1A6   /*  2.49:1 — hợp lệ: WCAG 1.4.3 miễn trừ phần tử vô hiệu hoá */
--accent:       #0A66E8   /*  4.98:1 — focus, selection, active */
--danger:       #D92D20   /*  4.67:1 */
--border:       #D2D2DA   /*  1.45:1 — hairline trong panel */
--border-strong:#C7C7CF   /*  1.63:1 — tách toolbar khỏi nội dung */
```

Chữ trắng `#F5F5F7` trên nền lightbox `#0A0A0B` = 18.18:1.

Không được thêm cấp xám thứ tư dưới `--fg-tertiary`. Gray-on-gray là dấu hiệu số một của UI nghiệp dư.

Hai giá trị dưới 4.5:1 ở trên là **cố ý và hợp chuẩn**: `--fg-disabled` được WCAG miễn trừ, `--border` là đường kẻ trang trí chứ không mang thông tin. Không "sửa" chúng cho đạt 4.5 — làm vậy sẽ khiến phần tử disabled trông như đang bật được.

### 1.4 Typography

- **Chrome UI:** `system-ui` stack. Native trên macOS, load tức thì, không FOIT, không tốn byte. Chữ UI ở đây quá ít để một webfont xứng đáng chi phí.
- **Date header:** đây là phần tử typographic duy nhất có kích thước đáng kể trong app, và là thứ neo cảm giác "sản phẩm chỉn chu". Dùng một variable font bundle sẵn (đề xuất: **Instrument Sans** hoặc **Geist**), weight 600, tracking `-0.02em`.
- **Số liệu** (đếm ảnh, dung lượng, timestamp): bắt buộc `font-variant-numeric: tabular-nums`. Không có nó, số nhảy giật khi cập nhật realtime lúc scan.

Thang: `11 / 12 / 13 / 15 / 20 / 28`. Chữ UI nhỏ hơn 11px là cấm.

### 1.5 Spacing & radius

Nhịp 4px. Gap lưới ảnh: **2px** (không phải 8px — ảnh cần gần nhau để đọc như một tấm thảm liên tục, đây là lý do lưới Google Photos "đã mắt").
Radius: thumbnail `2px`, card/panel `10px`, sheet `14px`. Thumbnail bo tròn nhiều là sai — nó cắt mất nội dung ảnh ở góc.

---

## 2. "Không cần hướng dẫn" — nghĩa cụ thể

Triết lý này dễ bị nói suông. Đây là các quy tắc kiểm chứng được:

| Quy tắc | Kiểm chứng |
|---|---|
| Lần chạy đầu không có bước cấu hình nào | Chạy `gal <path>` trên máy sạch → thấy ảnh, không thấy form/wizard/settings |
| Không có gesture nào là đường **duy nhất** tới một chức năng | Mọi chức năng làm được bằng chuột + có phím tắt; gesture chỉ là lối tắt |
| Phím tắt tồn tại nhưng không bắt buộc | Nhấn `?` hiện bảng phím tắt; không nhấn thì vẫn dùng được 100% |
| Không có empty state nào yêu cầu người dùng đi cấu hình | Thư mục rỗng → nói đúng đường dẫn đã quét + số file đã bỏ qua, không nói "hãy thiết lập..." |
| Không giải thích thứ đang tự chạy | Scan nền không có modal, không có "đang index, vui lòng chờ" |
| Icon một mình không mang nghĩa quan trọng | Mọi icon-only button có tooltip + `aria-label` |

Kiểm thử chấp nhận: đưa app cho người chưa từng thấy nó, không nói gì. Trong 10 giây họ phải xem được ảnh, đổi được cỡ lưới, và mở được một ảnh full-screen. Nếu phải hỏi thì thiết kế sai.

---

## 3. Nơi "wow" thật sự đến từ

Xếp theo tỉ lệ ấn tượng trên chi phí thực hiện.

### 3.1 Shared-element zoom (chữ ký của sản phẩm)

Click thumbnail → chính ô ảnh đó **nở ra** thành lightbox từ đúng vị trí và tỉ lệ của nó, không phải fade-in một overlay mới. Đóng lại thì co về đúng ô cũ.
Kỹ thuật: FLIP (First-Last-Invert-Play) — đo rect trước và sau, dùng `transform` để nghịch đảo rồi thả. Chỉ animate `transform`/`opacity`.
Đây là động tác đơn lẻ tạo cảm giác "đắt tiền" nhất trong toàn bộ app.

### 3.2 Thanh scrubber thời gian

Dải mỏng bám mép phải, hiện khi scroll, đánh dấu các mốc năm/tháng. Kéo nó là bay xuyên 70.000 ảnh qua nhiều năm trong một cử chỉ.
Với thư viện lớn, đây là **tương tác có giá trị cao nhất** — không có nó, 70k ảnh là một hố scroll vô tận. Ẩn sau 1.5s không hoạt động.

### 3.3 Tốc độ được nhìn thấy

Ảnh hiện dần theo tiến trình scan, không bao giờ có spinner chặn màn hình, không bao giờ có lưới trắng.
Thumbnail vào bằng fade 120ms, **stagger 15ms** theo thứ tự trong hàng. Không stagger thì cả hàng bật ra cùng lúc, cảm giác rẻ tiền; stagger quá chậm thì thành lười.
Tiến trình scan là một sợi chỉ mảnh 2px ở mép trên + con số đếm tăng dần, không phải progress bar modal.

### 3.4 Đổi mật độ lưới mượt

`+` / `-` hoặc pinch → cỡ thumbnail đổi, layout **animate** sang bố cục mới thay vì nhảy cóc. Giữ nguyên ảnh ở tâm viewport làm điểm neo.

### 3.5 Lọc tức thì

Gõ vào ô lọc → lưới phản hồi dưới 100ms trên 70k item. Cảm giác "app không có độ trễ" là một dạng wow mà không hiệu ứng nào mua được.

---

## 4. Motion

| Thuộc tính | Giá trị |
|---|---|
| Micro-interaction (hover, press) | 120ms, `ease-out` |
| Chuyển trạng thái (mở panel, đổi mode) | 220ms, `cubic-bezier(0.32, 0.72, 0, 1)` |
| Shared-element zoom | 300ms vào / 220ms ra |
| Stagger thumbnail | 15ms mỗi ô, tối đa 8 ô rồi thôi |

Quy tắc cứng:
- Chỉ animate `transform` và `opacity`. Animate `width`/`height`/`top`/`left` gây reflow và giết 60fps ở 70k item.
- Thoát nhanh hơn vào (~70%). Ngược lại thì cảm giác ì.
- Mọi animation phải **ngắt được** — người dùng click tiếp là animation hiện tại nhường ngay.
- `prefers-reduced-motion: reduce` → tắt stagger và zoom, giữ crossfade 80ms. Không tắt sạch thành 0ms, vì mất luôn cảm giác nhân quả.

---

## 5. Bàn phím

Bắt buộc — nhưng không bao giờ là con đường duy nhất.

```
← → ↑ ↓     điều hướng ô đang chọn
Space       mở lightbox / play-pause video
Esc         đóng lightbox → bỏ chọn → xoá bộ lọc (theo thứ tự)
+ -         đổi mật độ lưới
1 2 3       justified / square / masonry
G           nhảy tới ngày (date jump)
/           focus ô lọc
?           bảng phím tắt
Home End    đầu / cuối thư viện
```

`Esc` phải phân cấp, không được đóng sạch mọi thứ cùng lúc — đó là hành vi phá trạng thái người dùng.

---

## 6. Trạng thái bắt buộc thiết kế

Không được bỏ qua cái nào. UI trông nghiệp dư gần như luôn vì thiếu mấy trạng thái này chứ không phải vì màu xấu.

| Trạng thái | Yêu cầu |
|---|---|
| Đang scan, chưa có ảnh nào | Skeleton lưới nhịp thở, **không** spinner giữa màn |
| Đang scan, đã có ảnh | Ảnh hiện dần + chỉ tiến trình mảnh ở mép trên |
| Thumbnail chưa sinh xong | Ô giữ đúng tỉ lệ, nền `--bg-sunken`, shimmer rất nhẹ |
| Chưa biết tỉ lệ (dimension về muộn) | Giữ ô vuông 1:1 tạm, re-layout khi có số thật, **không nhảy scroll** |
| Ảnh hỏng / không đọc được | Icon + tên file, không phải ô trống câm lặng |
| Thư mục không có media | Nói rõ đường dẫn đã quét, số thư mục đã bỏ qua và vì sao |
| Không quyền đọc | Nêu đúng đường dẫn bị chặn, gợi ý cách cấp quyền trên macOS |
| Bộ lọc không khớp gì | Nêu bộ lọc đang áp + nút xoá lọc một click |
| Video đang tải | Poster frame + control, không phải khung đen |

---

## 7. Accessibility — sàn không thương lượng

- Contrast: chữ thường ≥4.5:1, chữ lớn ≥3:1. Đã bảo đảm bởi thang màu ở §1.3.
- Focus ring luôn nhìn thấy: `2px` accent + `2px` offset. **Không bao giờ** `outline: none` mà không thay thế.
- Thứ tự tab khớp thứ tự thị giác. Lưới ảo hoá phải quản lý focus thủ công — đây là chỗ virtual scroll hay làm hỏng a11y.
- Lightbox là focus trap thật, `Esc` thoát, focus trả về đúng thumbnail vừa mở.
- Mọi thumbnail có `alt` là tên file + ngày. Icon-only button có `aria-label`.
- Tiến trình scan thông báo qua `aria-live="polite"`, throttle 5s một lần — không phải mỗi ảnh, nếu không screen reader sẽ đọc liên tục không dứt.
- Hỗ trợ `prefers-reduced-motion` và zoom trình duyệt tới 200% không vỡ layout.

---

## 8. Chống AI-slop

Dấu hiệu nhận biết giao diện do AI sinh ẩu, cấm tuyệt đối trong repo này:

- Emoji dùng làm icon → dùng Lucide SVG.
- Gradient tím-xanh ở mọi nơi.
- Card bo tròn 16px có shadow lớn nổi trên nền tối.
- Chữ "✨ Powered by AI" hay tương tự.
- Nhiều hơn một accent color.
- Shadow to và mờ kiểu `0 10px 40px rgba(0,0,0,.3)`. Nền sáng cho phép dùng shadow, nhưng phải là shadow ngắn và chặt: `0 1px 2px rgba(0,0,0,.06), 0 1px 1px rgba(0,0,0,.04)`. Phân lớp chủ yếu bằng hairline `--border`, shadow chỉ để nhấn phần tử thật sự nổi (popover, sheet).
- Hover scale 1.05 trên thumbnail → làm vỡ lưới justified. Dùng đổi độ sáng hoặc viền trong.
- Bo tròn thumbnail nhiều (≥8px) → cắt mất nội dung ảnh ở bốn góc.

---

## 9. Checklist trước khi giao

- [ ] Không emoji làm icon; toàn bộ icon cùng một họ, cùng stroke width
- [ ] Không có accent color thứ hai
- [ ] Đủ 9 trạng thái ở §6
- [ ] Focus ring nhìn thấy trên mọi phần tử tương tác, kể cả ô trong lưới ảo hoá
- [ ] `prefers-reduced-motion` được tôn trọng
- [ ] Chỉ animate transform/opacity — grep xem có animate width/height/top/left không
- [ ] Số dùng tabular-nums
- [ ] Phím tắt hoạt động; `?` mở được bảng
- [ ] Kiểm tra ở 1280 / 1440 / 1920 và cửa sổ hẹp 900px
- [ ] Kiểm tra với thư mục rỗng, thư mục 1 ảnh, thư mục 70k ảnh
- [ ] Người chưa từng thấy app xem được ảnh trong 10 giây mà không cần hỏi

---

## Quyết định đã chốt

- **Light mode là mặc định** (quyết định của chủ dự án). Lightbox vẫn dùng nền tối `--bg-immersive` — đây là ngữ cảnh xem, không phải theme thứ hai.
- Dark mode đầy đủ: chưa làm ở v1. Không phải vì khó, mà vì nó nhân đôi ma trận kiểm contrast trong khi chưa có nhu cầu xác thực.

## Câu hỏi chưa chốt

1. Date header dùng `system-ui` hay bundle một variable font (Instrument Sans / Geist)? Bundle tốn ~40KB nhưng là thứ duy nhất tạo cá tính typographic trong một giao diện cố tình vô hình.
