---
phase: 5
title: "Virtualized grid"
status: pending
priority: P1
effort: "2.5d"
dependencies: [2, 3]
---

# Phase 5: Virtualized grid

## Overview

Lưới ảo hoá 70k item, 3 chế độ layout, sticky date header, hấp thụ dimension về muộn mà không
nhảy scroll. Spike đã chứng minh khả thi (`docs/wireframe/index.html`) — phase này biến prototype
vứt bỏ thành code production, và sửa lỗi trôi scroll spike đã tìm ra.

## Requirements

**Functional**
- 3 mode: justified rows, ô vuông, masonry. Đổi mode không reload, không nhảy scroll
- Group theo ngày, sticky header
- Hấp thụ patch dimension từ pha B, re-layout mà **không** dịch chuyển nội dung đang xem
- Đổi mật độ (`+`/`-`), giữ ảnh ở tâm viewport làm neo
- Fade-in thumbnail có stagger 15ms, tối đa 8 ô

**Non-functional**
- 60fps khi cuộn, DOM <2000 node, **RAM <500MB với thumbnail JPEG thật**
- Trôi scroll tích luỹ <10px ở giữa thư viện suốt pha B

## Architecture

### Không dùng thư viện — cả layout lẫn windowing

**`justified-layout` (Flickr): bỏ.** Bảo trì lần cuối 2022-06-19 (`npm view time.modified`).
Toán của nó là công thức đóng và spike đã tự viết trong ~15 dòng, đạt 120fps:

```js
// H = containerWidth / Σ(aspect ratio). Đóng hàng khi sum*target >= W.
let row = [], sum = 0;
for (const o of items) {
  row.push(o); sum += o.ar;
  if (sum * target >= W - GAP * row.length) flushRow(false);
}
flushRow(true);  // hàng cuối: giữ chiều cao target, để hở bên phải
```

Thêm một dependency 4 năm không cập nhật để thay 15 dòng đã chạy được là đánh đổi sai.

**Windowing tự viết.** Research khảo sát 4 thư viện, không cái nào đỡ đủ tổ hợp
justified + sticky header + dimension muộn + neo scroll ở 70k:
react-window rò DOM node (issue #433: 2000 → ~9000 node detached, vi phạm thẳng ngân sách),
TanStack Virtual có issue stutter mở với row nhóm chiều cao biến thiên (#832).

### Neo scroll — sửa lỗi spike đã tìm ra

Spike đo được **trôi 187px** ở giữa thư viện sau 70 lần re-layout. Nguyên nhân: mỗi lần
re-layout lại *dò lại* ô neo theo vị trí y, nên danh tính ô neo đổi giữa các lần, sai số
~2,7px cộng dồn.

**Cách làm đúng:** chốt ô neo theo `id` **một lần** khi pha B bắt đầu, giữ nguyên id đó cho tới
khi người dùng tự cuộn (lúc đó chọn neo mới). Bù `scrollTop` đồng bộ trong cùng tick với patch,
trước khi paint.

`overflow-anchor` của CSS **không thay thế được**: Safari không hỗ trợ (cả desktop lẫn iOS),
và trong lưới định vị tuyệt đối bằng `transform` thì browser không quan sát được dịch chuyển đó.
Bật nó như phòng thủ miễn phí trên Chromium/Firefox, không bao giờ tin cậy nó là cơ chế chính.

### Cấu trúc dữ liệu

Một mảng `placed[]` **song song thứ tự với `view[]`** → neo bằng chỉ số là O(1), không cần map id.
Binary search `scrollTop` để tìm dải hiển thị. Pool DOM tái sử dụng, `contain: strict` mỗi ô.

Item chưa biết tỉ lệ → dùng 1:1 tạm (đây là lý do phải neo scroll cho tử tế).

### RAM với thumbnail thật — đo sớm

Spike đo 40MB nhưng dùng CSS gradient, **không có bitmap decode**. Với JPEG thật, bộ nhớ do
bitmap đã decode chi phối: 320×240×4 byte ≈ 300KB mỗi ảnh khi decode. 2000 node hiển thị
≈ 600MB nếu browser giữ hết — **vượt ngân sách 500MB**.

Giảm thiểu: `loading="lazy"`, gỡ `src` của ô ra khỏi viewport xa (không chỉ ẩn), và
`decoding="async"`. Đo bằng Chrome DevTools Memory ngay khi có 5000 ảnh thật, **không đợi tới cuối**.

## Related Code Files

- Create: `web/grid.js` (virtualizer core), `web/layouts.js` (3 thuật toán layout)
- Create: `web/app.js` (ingest NDJSON, điều phối), `web/styles.css`
- Modify: `web/index.html`
- Reference: `docs/wireframe/index.html` — prototype đã chứng minh, đọc trước khi viết
- Create: `test/layouts.test.js` (toán layout thuần, test được không cần DOM)

## Implementation Steps

1. Port toán layout từ spike sang `web/layouts.js`, thành 3 hàm thuần
   `(items, width, target) → placed[]`. Thuần nên test được bằng `node:test`.
2. `web/grid.js`: pool DOM, binary search dải hiển thị, render window, sticky header.
3. **Neo scroll theo id cố định** — không lặp lại lỗi của spike. Viết test hồi quy đo trôi
   tích luỹ ở 50% thư viện, ngưỡng <10px.
4. Ingest NDJSON: `fetch` + `ReadableStream` + `TextDecoderStream`, parse theo dòng,
   áp patch theo lô 500-1000 trong `requestIdleCallback`.
5. Thumbnail: `<img loading="lazy" decoding="async">`, gỡ `src` khi ra khỏi overscan xa.
6. Fade-in stagger 15ms tối đa 8 ô; tôn trọng `prefers-reduced-motion`.
7. Báo viewport về server (`/api/priority`) khi scroll dừng 150ms.

## Success Criteria

- [ ] 70k item: cuộn 60fps trở lên, p95 frame time <16,7ms (đo bằng Playwright như spike)
- [ ] DOM node <2000 tại mọi thời điểm
- [ ] **RAM <500MB với thumbnail JPEG thật** (đo riêng, đây là tiêu chí dễ trượt nhất)
- [ ] Trôi scroll tích luỹ <10px ở 15%, 50%, 85% thư viện suốt pha B
- [ ] Đổi 3 mode qua lại: không reload, vị trí scroll giữ nguyên trong sai số một hàng
- [ ] Đổi mật độ: ảnh ở tâm viewport vẫn ở tâm sau khi đổi
- [ ] Sticky header hiện đúng ngày của vùng đang xem
- [ ] Hàng cuối mỗi nhóm giữ chiều cao target, để hở bên phải (không giãn cao bất thường)
- [ ] Item chưa có dimension hiển thị ô vuông tạm, re-layout khi có số thật
- [ ] Resize cửa sổ → re-layout đúng, không nhảy scroll

## Risk Assessment

**Rủi ro số một của cả dự án: RAM với ảnh thật.** Con số 40MB của spike không chuyển sang được.
*Tín hiệu:* DevTools báo >500MB khi cuộn qua vài nghìn ảnh.
*Phản ứng:* thu hẹp overscan, gỡ `src` tích cực hơn, giảm kích thước thumbnail xuống 256px.
Nếu vẫn vượt: dùng `<canvas>` với bitmap tự quản lý và giải phóng chủ động — đắt hơn nhiều,
chỉ làm khi các cách trên thất bại.

**Rủi ro: tự viết windowing thiếu phần "chán" mà thư viện đã hardened** — scroll-to-index,
khôi phục vị trí khi reload, quản lý focus cho a11y, ô tỉ lệ dị thường (panorama 10:1).
*Tín hiệu:* lỗi lặt vặt xuất hiện dần ở Phase 8.
*Phản ứng:* đã tính vào effort của Phase 8; ảnh panorama cần kẹp tỉ lệ tối đa khi tính layout.
