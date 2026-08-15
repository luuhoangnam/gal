---
phase: 7
title: "Filter, sort, group, điều hướng"
status: pending
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

- Create: `web/filters.js`, `web/worker-index.js`, `web/scrubber.js`, `web/keyboard.js`
- Create: `web/help-sheet.js` (bảng phím tắt)
- Modify: `web/app.js`, `web/grid.js`
- Create: `test/filters.test.js` (logic lọc thuần, không cần DOM)

## Implementation Steps

1. `web/filters.js`: hàm thuần `applyFilters(items, criteria) → Uint32Array`. Thuần nên test được.
2. Dựng chỉ số thư mục và mốc thời gian sau khi pha B xong; cập nhật tăng dần trong lúc pha B chạy.
3. Worker: `postMessage` với transferable, nhận về chỉ số đã sort + ranh giới nhóm.
4. UI lọc: thanh công cụ trên + panel thư mục dạng cây có thể thu gọn.
5. Scrubber: port từ spike, thêm nhãn tháng/năm bám theo vị trí kéo.
6. Bàn phím: một handler tập trung, tôn trọng ô input đang focus (không nuốt phím khi đang gõ).
7. Trạng thái lọc phản ánh vào URL hash → tải lại trang giữ nguyên bộ lọc (deep link).

## Success Criteria

- [ ] Không rò rỉ phía JS (chuyển từ Phase 5 — cần bộ lọc mới dựng được tình huống):
      cuộn qua 10.000 ảnh rồi lọc còn 100 → RSS phải nhả đáng kể

- [ ] Lọc 70k → kết quả hiển thị <100ms (đo bằng Playwright, không phải cảm nhận)
- [ ] Kết hợp 4 loại filter cùng lúc vẫn <100ms
- [ ] Đổi sort trên 70k không chặn main thread quá 50ms một lần
- [ ] Group theo ngày/tháng/năm/không — header đúng, đếm đúng
- [ ] Scrubber: kéo từ đầu tới cuối thư viện mượt, nhãn năm cập nhật theo
- [ ] Toàn bộ phím tắt hoạt động; `?` mở bảng; gõ trong ô lọc không kích hoạt phím tắt
- [ ] `Esc` phân cấp đúng thứ tự: lightbox → bỏ chọn → xoá lọc
- [ ] Lọc rồi tải lại trang (URL hash) → giữ nguyên bộ lọc
- [ ] Lọc không khớp gì → empty state nêu rõ bộ lọc đang áp + nút xoá một click

## Risk Assessment

**Rủi ro: lọc theo text chạy lại toàn bộ 70k mỗi lần gõ phím.** Research chỉ đích danh đây là
nguồn jank thật cần canh, không phải ingest ban đầu.
*Tín hiệu:* gõ vào ô lọc thấy khựng.
*Phản ứng:* debounce 80ms + dựng chỉ số chữ thường một lần thay vì `toLowerCase()` mỗi lần so.

**Rủi ro: worker làm phức tạp thêm mà không cần thiết ở 70k.**
*Tín hiệu:* sort trên main thread đo được <50ms.
*Phản ứng:* bỏ worker luôn — đơn giản hơn thì tốt hơn. Đo trước khi thêm.
