---
phase: 5
title: "Virtualized grid"
status: pending
priority: P1
effort: "4d"
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
- 60fps khi cuộn **và sau khi đã cuộn qua 10.000 ảnh**, DOM <2000 node
- Không rò rỉ phía JS, không crash tab. **Không có ngưỡng RAM cứng** — đã chốt bỏ, xem `plan.md`
- Trôi scroll tích luỹ <10px ở giữa thư viện suốt pha B
- Mục tiêu v1 là **Chrome**; Safari không cam kết perf nhưng không được crash

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

**Cách làm đúng:** chốt ô neo theo **id ổn định** (rowid từ Phase 3), giữ nguyên id đó suốt
đợt patch. Bù `scrollTop` đồng bộ trong cùng tick với patch, trước khi paint.

**Neo bằng chỉ số là sai** — pha B mang về ngày chụp EXIF, mà lưới sắp theo ngày chụp, nên
**thứ tự sắp xếp đổi trong lúc pha B chạy**. Chỉ số `i` trong `placed[]` trỏ sang item khác giữa
hai lần layout. Phải tra theo id: giữ `Map<id, index>` dựng lại sau mỗi lần layout.

**"Giữ tới khi người dùng cuộn" là định nghĩa không cài đặt được** từ sự kiện `scroll`: chính
việc bù `scrollTop` của ta cũng phát ra `scroll`, không phân biệt được với cuộn của người dùng.
Thay bằng: đặt cờ `isCompensating` quanh thao tác bù, bỏ qua đúng sự kiện đó; hoặc dùng
`scrollend` (đã xác nhận có ở **cả** WebKit lẫn Chromium) kèm cờ.

**Sửa một sai sót trong bản plan trước:** research nói "Safari không hỗ trợ `overflow-anchor`"
và tôi đã chép lại. **Sai** — đo bằng Playwright WebKit: `CSS.supports('overflow-anchor','auto')`
trả `true`, và WebKit bù đúng như Chromium. Quyết định tự bù vẫn giữ, nhưng vì lý do đúng:
lưới định vị bằng `transform` nên browser không quan sát được dịch chuyển, chứ không phải vì
thiếu hỗ trợ.

### Cấu trúc dữ liệu

`placed[]` song song `view[]` cho binary search dải hiển thị (O(log n)), **cộng thêm**
`Map<id, index>` để tra ô neo và ô đang focus theo id. Pool DOM tái sử dụng, `contain: strict` mỗi ô.

**Pool phải gắn theo id, không theo chỉ số.** Pool đánh theo chỉ số làm hỏng âm thầm:
`alt` sai ảnh, focus nhảy sang ảnh khác khi layout đổi, và lightbox trả focus về nhầm ô.

Item chưa biết tỉ lệ → dùng 1:1 tạm (đây là lý do phải neo scroll cho tử tế).

### Nhắm Chrome — nhưng vẫn giữ shim 3 dòng

**Quyết định (validation 2026-08-15): v1 chỉ hỗ trợ Chrome.** `gal` mở Chrome trực tiếp
(Phase 1), không mở browser mặc định. Bỏ được gánh nặng kiểm thử chéo WebKit.

Dù vậy vẫn giữ shim, vì người dùng có thể dán URL vào Safari và 3 dòng này biến một
`ReferenceError` chết app thành hoạt động bình thường:

```js
const yieldToMain = globalThis.scheduler?.postTask
  ? (fn) => scheduler.postTask(fn, { priority: 'background' })
  : (fn) => setTimeout(fn, 0);
```

Đã đo: WebKit thiếu **cả** `requestIdleCallback` **lẫn** `scheduler.postTask` — không gọi thẳng
cái nào. Không cam kết 60fps trên WebKit ở v1, nhưng cũng không để nó vỡ ngay từ dòng đầu.

`performance.memory` không có trong WebKit → script đo dùng RSS tiến trình cho mọi engine.

### RAM: ngân sách 500MB không đạt được bằng kiến trúc này — đã đo, không phải suy đoán

Spike đo 40MB nhưng dùng CSS gradient, không có bitmap decode. Đo lại với **JPEG 320px thật**
(1.200 ảnh, Chromium, cửa sổ ảo hoá tối giản):

| | Đo được |
|---|---|
| Ảnh đã cuộn qua | 1.200 |
| Ô còn `src` | **24** |
| DOM node tổng | **38** |
| RAM tăng | **385 MB** |
| Giữ lại / ảnh | **329 KB** |
| Cuộn về đầu, chờ 3s | nhả đúng **16 MB** |

**Kết luận: bộ nhớ bám theo số ảnh ĐÃ TỪNG cuộn qua, không phải số ô đang hiển thị.**
Chỉ 24 ô sống và 38 node mà vẫn 385MB. Đây là cache ảnh đã decode của browser, khoá theo URL,
giữ lại **sau khi** `<img>` đã nhả.

Hệ quả: ba biện pháp trong bản plan trước (`loading=lazy`, gỡ `src`, thu hẹp overscan)
**không điều khiển được đại lượng này** — red team đo riêng và ra cùng kết luận (chênh 3%
giữa có và không gỡ `src`). Lập luận "2000 node × 300KB = 600MB" trong bản trước **sai cả hai chiều**:
sai vì không phải node quyết định, và sai vì số thật lớn hơn nhiều khi cuộn xa.

**Đòn bẩy thật sự chỉ có hai:**
1. **Số điểm ảnh.** 160px giảm đáng kể so với 320px, nhưng 320px vốn đã dưới chuẩn Retina ở DPR 2 —
   hạ nữa là thấy mờ rõ rệt. Đây là đánh đổi chất lượng hình ảnh, không phải tối ưu miễn phí.
2. **Tự quản lý vòng đời bitmap**: `createImageBitmap` + `blob:` URL + `revokeObjectURL` khi ô
   rời vùng xa, hoặc vẽ vào `<canvas>` và chủ động giải phóng. Lấy lại quyền kiểm soát từ cache
   browser, nhưng phải tải lại khi cuộn ngược — đắt và phức tạp hơn nhiều.

**Ngân sách 500MB trong contract cần được xem lại** — xem mục quyết định ở `plan.md`.
Đo bằng RSS tiến trình, **không** dùng `performance.memory` (WebKit không có).

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
   áp patch theo lô 500-1000 qua shim `yieldToMain` (xem Architecture).
   **Không gọi thẳng `requestIdleCallback` hay `scheduler.postTask`** — WebKit không có cả hai (đã đo).
5. Thumbnail: `<img loading="lazy" decoding="async">`, gỡ `src` khi ra khỏi overscan xa.
6. Fade-in stagger 15ms tối đa 8 ô; tôn trọng `prefers-reduced-motion`.
7. Báo viewport về server (`/api/priority`) khi scroll dừng 150ms.

## Success Criteria

- [ ] 70k item: cuộn 60fps trở lên, p95 frame time <16,7ms (đo bằng Playwright như spike)
- [ ] DOM node <2000 tại mọi thời điểm
- [ ] Chrome: toàn bộ tiêu chí perf đạt. Safari: mở được, không `ReferenceError` (không đo fps)
- [ ] **60fps sau khi đã cuộn qua 10.000 ảnh** (đo bằng RSS tiến trình + frame time, JPEG thật —
      không đo lúc vừa mở, và không dùng `performance.memory` vì WebKit không có)
- [ ] Không rò rỉ phía JS: sau khi cuộn qua 10k ảnh rồi lọc còn 100, RAM phải nhả đáng kể
      (nếu không nhả thì có tham chiếu JS treo, khác với cache browser)
- [ ] Không crash tab khi cuộn hết 70k liên tục
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
