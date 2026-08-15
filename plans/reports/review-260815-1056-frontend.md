# Code Review — web/ frontend (mobile feed + bottom sheets)

Ngày: 2026-08-15 · Nhánh: main · Phạm vi: uncommitted diff trên `web/` + đọc lại toàn bộ frontend

## Scope

- Diff: `web/app.js` (+64/-14), `web/index.html` (+77), `web/keyboard.js` (+3/-3), `web/styles.css` (+320), `web/feed.js` (mới, 260 dòng, chưa từng review)
- Đọc thêm: `web/grid.js`, `web/layouts.js`, `web/lightbox.js`, `web/filters.js`, `web/scrubber.js`
- Test: `npm test` → 119 pass / 0 fail (9.2s). Không có test nào chạm `feed.js`, `app.js`, hay CSS mobile mới.

## Overall

Kiến trúc ảo hoá lưới (`grid.js` + `layouts.js`) vẫn vững: neo theo id, roving tabindex, pool theo id chứ không theo chỉ số. Phần mới (`feed.js` + bottom sheet) đúng ý tưởng — dùng `scroll-snap` của trình duyệt thay vì tự viết gesture — nhưng nó là code overlay đầu tiên **không** đồng bộ với vòng đời dữ liệu của lưới, và đó là nguồn của phần lớn phát hiện dưới đây.

**Không có lỗi Critical.** Không tìm thấy XSS (chi tiết ở mục "Trust boundary" bên dưới), không có breaking change với contract server, không có lộ dữ liệu.

---

## Important

### I1. Feed giữ cửa sổ chỉ số cũ khi lưới rebuild → hiện sai ảnh, sai tên file

`web/feed.js:44-47,64-66,180-200` chốt `start`/`end`/`cur` là **chỉ số trong `placed`** tại thời điểm mở, còn `web/app.js:139-151` gom patch pha B rồi gọi `rebuild()` → `grid.setView(applyFilters(...))` mỗi 250ms. Pha B đổi `it.t` (ngày chụp EXIF) nên **thứ tự sort đổi**, `placed` được dựng lại hoàn toàn (`layouts.js:71`).

Kịch bản: điện thoại, thư viện đang quét (phase `b`), người dùng chạm ảnh ở vị trí 500 → feed mở với `start=0,end=2000,cur=500`. 250ms sau `rebuild()` chạy, item ở chỉ số 500 giờ là ảnh khác.
- `feed.js:65` `if (slides.has(i)) return;` → slide đã mount **không bao giờ được làm mới**, DOM vẫn là ảnh cũ.
- `feed.js:135-138` `renderMeta(grid.at(i))` chỉ chạy khi `setActive` đổi `cur` (cuộn tiếp) → khi đó thanh chữ dưới đáy nói tên/ngày/thư mục của **một file khác** với ảnh đang hiển thị.
- `feed.js:209-210` `close()` gọi `grid.focusId(it.i)` với `it` lấy từ `grid.at(cur)` sau rebuild → cuộn lưới về ô không liên quan.
- Cùng chuyện xảy ra với `--watch` (`app.js:467-483` → `scan()` → `rebuild()`) khi ai đó copy file vào thư mục lúc feed đang mở.

Hướng sửa: chốt theo **id** như phần còn lại của codebase (`grid.js:48-51` đã nêu chính xác lý do không pool theo chỉ số). Tối thiểu: `grid` phát một callback `onView` để feed re-resolve `cur` theo id, remount slide khi `grid.at(i).i !== id đã mount`, và cập nhật lại `grid.count` trong `posEl`.

### I2. Race khi chạm hai lần nhanh → hai instance `createFeed`, listener leak

`web/app.js:56-63`:

```js
let feed = null;
async function openFeed(index) {
  if (feed === null) {
    const { createFeed } = await import('./feed.js');
    feed = createFeed({ grid, root: $('#feed') });
  }
  feed.open(index);
}
```

Guard `feed === null` nằm **trước** `await`, nên hai sự kiện click liên tiếp (double-tap trên ô lưới, `grid.js:280-283` phát 2 click) trong lúc `./feed.js` chưa nạp xong đều đi vào nhánh khởi tạo → `createFeed` chạy hai lần trên **cùng một `#feed`**:
- Hai listener `popstate`/`resize` trên `window` (`feed.js:248,252`) — instance đầu không bao giờ được thu hồi.
- Cả hai instance mount slide vào cùng `#fsizer` → DOM chồng, `pool` riêng biệt.
- `overlayOpen()` (`app.js:65`) chỉ hỏi instance thứ hai → nếu instance đầu đang mở mà instance hai chưa mở, phím tắt toàn cục vẫn chạy dưới overlay.

Lỗi y hệt ở `openLightbox` (`app.js:46-53`) — có sẵn từ trước, nhưng nay đường mở mặc định trên mobile đi qua `openFeed`. Sửa: memo hoá **promise** thay vì instance (`feedP ??= import(...).then(...)`, rồi `(await feedP).open(index)`).

### I3. Sheet đóng vẫn nằm trong tab order và cây accessibility (mobile)

`web/index.html:86` bỏ thuộc tính `hidden` khỏi `<aside class="side" id="side">`, và `web/styles.css:785-808` cho trạng thái đóng là `transform: translateY(101%)` **không kèm** `visibility`/`inert`:

```css
.fbar, .side { display: block; ...; transform: translateY(101%); }
body.filter-on .fbar, body.side-on .side { transform: none; }
```

`transform` không gỡ phần tử khỏi tab order. Kịch bản: điện thoại + VoiceOver, vuốt phải từ bộ đếm `#cnt` → rơi thẳng vào danh sách thư mục (có thể 200 nút) và toàn bộ ô lọc trong khi cả hai sheet đang đóng và vô hình. Với bàn phím Bluetooth, `Tab` cũng đi vào đó trước khi tới lưới. Trước diff này `#side` có `hidden` nên không có vấn đề — đây là hồi quy trực tiếp từ diff.

Thêm: bấm `#filterdone`/`#sidedone` (`app.js:433-434`) đóng sheet nhưng để focus lại trên chính nút vừa trượt ra khỏi màn hình; không có đường trả focus về `#filterbtn`/`#sidetoggle`.

Hướng sửa: thêm `visibility: hidden` cho trạng thái đóng (`transition: transform .28s, visibility .28s`) hoặc bật/tắt thuộc tính `inert`; `setSheet(null)` trả focus về nút đã mở sheet.

### I4. Feed không phải dialog: nền vẫn focus được, không có role

`web/index.html:116` `<div class="feed" id="feed" hidden tabindex="-1" aria-label="Xem toàn màn hình">` — `aria-label` trên `div` không role thì AT bỏ qua; không có `role="dialog"` + `aria-modal="true"`; không có gì đặt `inert`/`aria-hidden` lên `.bar`, `.fbar`, `#scroller` khi feed mở. `feed.js:196` chỉ `root.focus()`.

Kịch bản: feed mở, người dùng nhấn `Tab` → focus rời khỏi overlay vào lưới phía sau (`#scroller` có `tabindex="0"`, `index.html:96`), khi đó `bindKeyboard` vẫn bị chặn bởi `overlay()` (`keyboard.js:20`) nên mũi tên chết, còn `feed.js:240` chỉ nghe trên `root` → người dùng bàn phím kẹt: không di chuyển được feed, cũng không dùng được lưới. `Escape` cũng chết vì handler nằm trên `root`.

Sửa: `role="dialog" aria-modal="true"`, chuyển keydown lên `document` khi `opened`, và `inert` phần nền.

### I5. Video không phát được thì im lặng hoàn toàn

`web/feed.js:130,174,231` đều `m.play().catch(() => {})`, và `<video>` không có handler `error`. Comment nói lý do là autoplay bị chặn, nhưng `catch` này nuốt **mọi** lỗi.

Kịch bản: file `.mkv` (`src/media-types.js:20` khai `video/x-matroska`) hoặc `.mov` chứa ProRes → Chrome/Safari không decode. Feed hiện poster đứng im; chạm để phát cũng không có gì xảy ra; không có thông báo. Lightbox ít nhất có `errorMsg: 'Không mở được tệp này'` (`lightbox.js:83`). Sửa: chỉ nuốt `NotAllowedError`, thêm `m.onerror` hiện chữ trong `.fmeta`.

### I6. `setSheet` relayout toàn bộ 70k item mỗi lần chạm, kể cả khi không cần

`web/app.js:422-429` gọi `grid.relayout(8)` vô điều kiện — kể cả `setSheet(null)` khi không có sheet nào mở (`#scrim` click, `applyViewport()` lúc khởi động, mỗi lần đổi breakpoint). Nhưng trên **mobile** sheet là overlay: `styles.css:809-812` đặt `body.side-on #scroller { left: 0 }`, tức bề rộng lưới **không đổi** → relayout hoàn toàn thừa đúng ở nhánh vừa được thêm.

`relayout` = `layout()` trên toàn bộ view (O(n) trên 70k) + `render()` + ghi `scroller.scrollTop` (forced reflow, `grid.js:85`). Kịch bản: thư viện 70k, mở/đóng sheet lọc vài lần → mỗi lần một lần sắp xếp lại toàn bộ, giật thấy rõ trên điện thoại. Thêm nữa `applyViewport()` (`app.js:440-446`) gọi liên tiếp `setSheet(null)` + `setMode` + `setTarget` = ba lần relayout cho một lần xoay máy.

Sửa: chỉ relayout khi class trên `body` thật sự đổi **và** breakpoint là desktop.

### I7. Đổi kích thước cửa sổ qua ngưỡng 700px xoá vĩnh viễn lựa chọn layout của người dùng

`web/app.js:440-446`:

```js
function applyViewport() {
  setSheet(null);
  if (mobile.matches) { setMode('square'); setTarget(140); }
  else setTarget(0);
}
```

Nhánh desktop không khôi phục `mode`. Kịch bản: người dùng desktop chọn Masonry → thu hẹp cửa sổ dưới 700px (hoặc mở DevTools ở chế độ dock ngang) → mở rộng lại → lưới kẹt ở `square`, mật độ về mặc định, không có cách nào biết là đã bị đổi. Cần nhớ mode/target do người dùng chọn trước khi ép sang mobile và trả lại khi thoát.

### I8. Bàn phím trên mobile vẫn mở PhotoSwipe, ngược với thiết kế đã nêu

`web/app.js:39` định tuyến chạm theo `mobile.matches`, nhưng `app.js:490` `actions: { open: openLightbox, ... }` vẫn cứng lightbox. Kịch bản: iPad/điện thoại có bàn phím Bluetooth, `Enter` trên một ô → tải PhotoSwipe (chính thứ comment `app.js:55` nói "điện thoại không tải PhotoSwipe") và mở một UI khác với UI khi chạm. Dùng lại đúng lambda ở `app.js:39` cho `actions.open`.

---

## Minor

### M1. Ba bản sao của luật "đuôi nào cần transcode"

`web/feed.js:14` và `web/lightbox.js:7` có cùng regex `/\.(heic|heif|tiff?)$/i`, `src/media-types.js:40` có `TRANSCODE_EXTS`. `feed.js:10-15` còn copy luôn helper `q` và `fmtDate` từ `lightbox.js:9-11`. Diff hiện tại vừa sửa `src/media-types.js` (`.mov` → `video/mp4`) — đúng loại thay đổi sẽ lệch giữa ba bản sao. Gom vào một `web/media-url.js` (`previewUrl(item)`), server giữ bản của nó.

### M2. `fpos` nói "x / 70.000" nhưng chỉ vuốt được 2000 mục

`web/feed.js:30,136,166` — cửa sổ `WINDOW = 2000` được ghi chú và có lý do, nhưng `posEl` hiển thị tổng **toàn cục** `grid.count`. Kịch bản: mở mục đầu tiên rồi vuốt liên tục → dừng cứng ở mục 2000 trong khi UI vẫn nói "2.000 / 70.000", không có dấu hiệu đây là mép cửa sổ chứ không phải hết thư viện. Hoặc hiện tổng của cửa sổ, hoặc dịch cửa sổ khi tới mép (cách nâng cấp mà chính comment đã mô tả).

### M3. `Escape` không đóng bottom sheet

`web/keyboard.js:38-42` xử lý `Escape` theo phân cấp blur → clear filter, không có bước "đóng sheet đang mở". Kết hợp với I3 (sheet đóng vẫn focus được) thì người dùng bàn phím không có cách thoát sheet ngoài việc tìm nút "Xong". Thêm một nhánh gọi `setSheet(null)` trước `clearFilters`.

### M4. `close()` có thể làm rơi focus về `<body>`

`web/feed.js:209-210`: nếu item đang xem đã bị lọc bỏ hoặc bị xoá khỏi `items` (`app.js:306` prune ở `done_b`) trong lúc feed mở, `grid.focusId(id)` gặp `byId.get(id) === undefined` và return sớm — trong khi `root` vừa bị `hidden`, tức focus rơi về `<body>` và người dùng bàn phím mất vị trí. Cần fallback `scroller.focus()`.

### M5. `innerHTML` với nội suy trong vòng render nóng

`web/grid.js:221`:

```js
el.innerHTML = `${fmtHead(h.t, group)} <em>${h.n.toLocaleString('vi-VN')} mục</em>`;
```

Hôm nay an toàn — `h.t` là timestamp số đi qua `Date`, `h.n` là số (kiểm chứng `layouts.js:52`). Nhưng đây là chỗ duy nhất trong frontend nội suy giá trị vào `innerHTML`; ngày nào thêm "nhóm theo thư mục" thì tên thư mục do người dùng đặt sẽ vào thẳng HTML. Đổi sang `textContent` + một `<em>` dựng sẵn (pool đã có sẵn element, chi phí bằng không).

### M6. Bàn phím ảo trên mobile kích hoạt relayout toàn bộ

`web/grid.js:267` `addEventListener('resize', () => relayout(8))`. Trên iOS/Android, focus vào `#q` trong sheet lọc làm bàn phím ảo bật lên → `resize` → relayout 70k item ngay giữa lúc người dùng bắt đầu gõ. `feed.js:252-257` đã xử lý đúng chuyện này (chỉ đo lại khi chiều cao **thật sự** đổi); `grid.js` thì chưa. Áp cùng cách: bỏ qua nếu `scroller.clientWidth` không đổi.

### M7. `#fsound` thiếu `aria-pressed`, chấm "đang lọc" không có tương đương cho AT

`web/index.html:135` nút loa chỉ đổi `aria-label` (`feed.js:177`) — với một nút toggle nên có `aria-pressed`. `styles.css:757-766` `#filterbtn.on::after` là chấm thuần trang trí; trạng thái "đang lọc" không được phát ra cho screen reader ở đâu cả (`app.js:206` chỉ toggle class).

---

## Trust boundary — kết quả kiểm tra XSS

Không tìm thấy lỗ hổng. Đã theo dấu mọi chuỗi có nguồn từ filesystem:

- Tên file / đường dẫn: `grid.js:113,117` (`img.alt`, `textContent`), `app.js:363-364` (`append` chuỗi + `textContent`), `app.js:192,197` (`textContent`), `feed.js:82,86,146-151` (`aria-label`, `alt`, `textContent`), `lightbox.js:53-62` (`textContent`) — tất cả đều là text node hoặc thuộc tính, không phải HTML.
- URL: `feed.js:15` và `lightbox.js:9` đều `encodeURIComponent(p)` trước khi ghép vào `/api/file?p=`.
- `feed.js:73` `backgroundImage = url("${thumb}")` là chỗ duy nhất nội suy vào CSS — `thumb` là `/api/thumb/${it.k}.jpg` với `it.k` là sha1 hex (`src/thumbs.js:26-29`), và server chỉ nhận `^/api/thumb/([0-9a-f]{40})\.jpg$` (`src/server.js:209`). Không thoát được khỏi `url("...")`.
- `innerHTML` chỉ xuất hiện ở `grid.js:101`, `feed.js:59` (chuỗi hằng) và `grid.js:221` (xem M5).
- `info.denied[0]` từ server đi qua `textContent` (`app.js:197`).

## Ảo hoá / rò rỉ — kết quả kiểm tra

Không tìm thấy rò rỉ node hay listener trong `grid.js`: pool theo id có giới hạn, `release()` gỡ `src`, listener uỷ quyền trên container (`grid.js:276-290`), `headPool` chỉ ẩn chứ không tạo thêm. `feed.js` giới hạn 5 slide, `release()` gọi `pause()` + `removeAttribute('src')` + `load()` (đúng, Chrome cần `load()` để dừng tải). Không dùng `IntersectionObserver`/`ResizeObserver` nên không có gì phải disconnect. Rò rỉ duy nhất là ở I2 (hai instance).

Toán ảo hoá: `visibleRange` (`layouts.js:159-172`) đúng nửa mở `[start, end)`; `grid.js:176` lùi 8 ô để bù masonry không đơn điệu — có lý do và khớp với `layouts.js:60-63`. Không thấy off-by-one.

## `feed.js` có trùng `grid.js`/`layouts.js` không?

Không. Nó không dùng lại toán layout mà cũng không nên: mỗi slide bằng đúng viewport nên "layout" chỉ là `i * h`. Không phải dead code: được nạp động từ `app.js:59`, `index.html` không cần thẻ script và `package.json` `files` ship cả thư mục `web` (kiểm chứng bằng `test/packaging.test.js:80-105`). Trùng lặp thật chỉ ở M1.

## Phím tắt — không hồi quy

Đối chiếu bảng trong `index.html:172-183` với `keyboard.js:22-84`: mũi tên, Space/Enter, Esc, +/−/0, 1/2/3, G, /, R, Home/End, ? — đủ cả. Thay đổi `lightbox()` → `overlay()` giữ nguyên ngữ nghĩa và mở rộng đúng cho feed.

## Hành động đề xuất (theo thứ tự)

1. I1 — chốt feed theo id thay vì chỉ số, remount khi view đổi.
2. I2 — memo hoá promise trong `openFeed`/`openLightbox`.
3. I3 + I4 — `visibility`/`inert` cho sheet đóng, `role="dialog" aria-modal` + inert nền cho feed, trả focus khi đóng.
4. I6 + I7 — `setSheet` chỉ relayout khi cần; nhớ và khôi phục mode/target khi rời mobile.
5. I5 — bề mặt hoá lỗi phát video.
6. I8 — dùng chung một hàm định tuyến mở cho cả chạm lẫn bàn phím.
7. M1 — gom luật transcode về một chỗ.
8. Còn lại: M2–M7.

## Metrics

- Type coverage: không áp dụng (JS thuần, không có JSDoc typecheck trong CI).
- Test: 119 pass / 0 fail. `feed.js` (260 dòng) và toàn bộ nhánh mobile trong `app.js`: **0 test**. `layouts.js`/`filters.js` có test thuần hàm tốt; `a11y.test.js` chỉ kiểm CSS bằng grep nên không bắt được I3.
- Lint: repo không cấu hình linter (`package.json` chỉ có `test`).

## Câu hỏi chưa giải quyết

1. Feed có nên tự đóng khi `rebuild()` xoá mất item đang xem (file bị xoá dưới `--watch`), hay giữ khung hình hiện tại và báo "file đã biến mất"? Đây là quyết định sản phẩm, ảnh hưởng cách sửa I1.
2. Ngưỡng 700px là ngưỡng "màn hình nhỏ" hay "cảm ứng"? `applyViewport` hiện ép layout theo bề rộng, nên một cửa sổ desktop hẹp bị coi là điện thoại (I7). Nếu ý là cảm ứng thì `(pointer: coarse)` mới đúng tín hiệu.
