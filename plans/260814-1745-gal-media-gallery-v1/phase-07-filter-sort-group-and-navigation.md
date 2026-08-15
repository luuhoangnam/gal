---
phase: 7
title: "Filter, sort, group, điều hướng"
status: completed
priority: P1
effort: "2.5d"
dependencies: [5]
---

# Phase 7: Filter, sort, group, điều hướng

## Overview

Lọc, sắp xếp, nhóm trên 70k item với phản hồi dưới 100ms, cộng với thanh scrubber năm và
bộ phím tắt đầy đủ. Đây là phần biến "một đống ảnh" thành "thư viện duyệt được".

## Requirements

**Functional**
- Filter: loại (ảnh/video), cây thư mục con, khoảng ngày, dung lượng — **kết hợp được**
- Sort: ngày chụp, tên, dung lượng — tăng/giảm
- Group: ngày / tháng / năm / không nhóm
- Thanh scrubber năm bám mép phải, kéo để nhảy qua nhiều năm
- Bộ phím tắt đầy đủ theo design guidelines §5, `?` mở bảng trợ giúp

**Non-functional**
- Mọi thao tác lọc/sort/group phản hồi <100ms trên 70k item
- Không chặn main thread khi tính toán

## Architecture

### Lọc và sắp xếp — Web Worker cho pass nặng, không cho parse

Research chỉ rõ: parse JSON 70k bản ghi chỉ tốn hàng chục ms, **không phải nguồn jank**.
Nguồn jank thật là DOM churn và pass sort/group O(n log n).

→ Worker (`web/worker-index.js`) chỉ làm một việc: nhận mảng metadata, trả về
`Uint32Array` chỉ số đã sắp xếp và ranh giới nhóm. Chuyển bằng transferable
(zero-copy), không dùng `SharedArrayBuffer` (cần COOP/COEP, phức tạp không đáng ở quy mô này).

Lọc theo text chạy trên main thread nhưng có debounce 80ms — nếu chạy lại toàn bộ 70k mỗi
lần gõ phím thì đó chính là nguồn jank cần canh.

**Chỉ số dựng sẵn:** cây thư mục (`Map<dir, id[]>`) và mốc năm/tháng dựng một lần sau pha B,
nên lọc theo thư mục là tra bảng chứ không quét tuyến tính.

### Scrubber năm

Dải mỏng mép phải, hiện khi cuộn, ẩn sau 1,5s không hoạt động. Đánh dấu mốc năm theo vị trí
tương đối trong tổng chiều cao. Kéo = nhảy thẳng.

Với 70k ảnh trải nhiều năm, đây là **tương tác giá trị cao nhất** — không có nó thì thư viện
lớn là một hố cuộn vô tận. Spike đã có bản chạy được.

### Bàn phím

```
← → ↑ ↓   di chuyển ô chọn        Space  mở / play
Esc       đóng → bỏ chọn → xoá lọc (phân cấp, không đóng sạch cùng lúc)
+ -       mật độ                   1 2 3  justified / vuông / masonry
G         nhảy tới ngày            /      focus ô lọc
Home End  đầu / cuối               ?      bảng phím tắt
```

`Esc` phân cấp là chi tiết quan trọng: đóng sạch mọi thứ cùng lúc là hành vi phá trạng thái
người dùng đã dựng công.

Phím tắt tồn tại nhưng **không bắt buộc** — mọi chức năng đều làm được bằng chuột
(nguyên tắc "no manual needed", design guidelines §2).

## Related Code Files

- Create: `web/filters.js`, `web/scrubber.js`, `web/keyboard.js`
- Modify: `web/app.js`, `web/grid.js`, `web/layouts.js`, `web/index.html`, `web/styles.css`
- Create: `test/filters.test.js` (logic lọc thuần, không cần DOM)
- **Không tạo**: `web/worker-index.js`, `web/help-sheet.js` (xem Kết quả thực tế)

## Implementation Steps

1. `web/filters.js`: hàm thuần `applyFilters(items, criteria) → Uint32Array`. Thuần nên test được.
2. Dựng chỉ số thư mục và mốc thời gian sau khi pha B xong; cập nhật tăng dần trong lúc pha B chạy.
3. Worker: `postMessage` với transferable, nhận về chỉ số đã sort + ranh giới nhóm.
4. UI lọc: thanh công cụ trên + panel thư mục dạng cây có thể thu gọn.
5. Scrubber: port từ spike, thêm nhãn tháng/năm bám theo vị trí kéo.
6. Bàn phím: một handler tập trung, tôn trọng ô input đang focus (không nuốt phím khi đang gõ).
7. Trạng thái lọc phản ánh vào URL hash → tải lại trang giữ nguyên bộ lọc (deep link).

## Success Criteria

- [x] Không rò rỉ phía JS (chuyển từ Phase 5 — cần bộ lọc mới dựng được tình huống):
      cuộn qua 10.000 ảnh rồi lọc còn 100 → RSS phải nhả đáng kể

- [x] Lọc 70k → kết quả hiển thị <100ms (đo bằng Playwright, không phải cảm nhận)
- [x] Kết hợp 4 loại filter cùng lúc vẫn <100ms
- [x] Đổi sort trên 70k không chặn main thread quá 50ms một lần
- [x] Group theo ngày/tháng/năm/không — header đúng, đếm đúng
- [x] Scrubber: kéo từ đầu tới cuối thư viện mượt, nhãn năm cập nhật theo
- [x] Toàn bộ phím tắt hoạt động; `?` mở bảng; gõ trong ô lọc không kích hoạt phím tắt
- [x] `Esc` phân cấp đúng thứ tự: lightbox → bỏ chọn → xoá lọc
- [x] Lọc rồi tải lại trang (URL hash) → giữ nguyên bộ lọc
- [x] Lọc không khớp gì → empty state nêu rõ bộ lọc đang áp + nút xoá một click

## Kết quả thực tế

**Không có Web Worker.** Plan bảo đo trước, và số đo bác bỏ nhu cầu: trên 70k item,
lọc thuần 3ms, lọc + layout + render 29ms, sort theo tên 25ms, theo ngày 39ms —
đều dưới ngưỡng 50ms plan đặt ra. Kèm theo đó bỏ luôn chỉ số `Map<dir, id[]>` dựng
sẵn: quét tuyến tính đã là 3ms.

**Không có `help-sheet.js`.** `<dialog>` native đã có focus trap, backdrop và Esc;
bảng phím tắt là markup tĩnh trong `index.html`, bật bằng một dòng `showModal()`.
Cũng vậy với "nhảy tới ngày": `showPicker()` của `<input type="date">` thay cho lịch tự vẽ.

**Số đo (Playwright, Chrome, 70k item):**

| Thao tác | Thời gian |
|---|---|
| Lọc theo loại (63.642 kết quả), gồm layout + render | 29ms |
| Bốn filter kết hợp (201 kết quả) | 5,5ms |
| Đổi sort sang tên | 25ms |
| Đổi sort sang ngày | 39ms |
| Riêng `applyFilters` | 3ms |
| DOM node lúc cao nhất | 55 |

**Không rò rỉ JS:** cuộn qua ~10.000 ảnh rồi lọc còn 1 → heap JS 51,6MB → 16,4MB.

**Một bug Phase 5 lộ ra:** `.hdr` có `display: flex`, đè lên `display: none` mặc định
của thuộc tính `[hidden]` — header của nhóm đã bị lọc mất vẫn nằm lại trên lưới.
Chỉ thấy được khi có bộ lọc làm nhóm biến mất.

**Đơn giản hoá có chủ ý:** panel thư mục là danh sách thụt lề theo độ sâu, không có
nút thu gọn từng nhánh — danh sách đã cuộn được và đã hiện số mục mỗi nhánh, thu gọn
chỉ thêm trạng thái mà không thêm thông tin.

## Risk Assessment

**Rủi ro: lọc theo text chạy lại toàn bộ 70k mỗi lần gõ phím.** Research chỉ đích danh đây là
nguồn jank thật cần canh, không phải ingest ban đầu.
*Tín hiệu:* gõ vào ô lọc thấy khựng.
*Phản ứng:* debounce 80ms + dựng chỉ số chữ thường một lần thay vì `toLowerCase()` mỗi lần so.

**Rủi ro: worker làm phức tạp thêm mà không cần thiết ở 70k.**
*Tín hiệu:* sort trên main thread đo được <50ms.
*Phản ứng:* bỏ worker luôn — đơn giản hơn thì tốt hơn. Đo trước khi thêm.
