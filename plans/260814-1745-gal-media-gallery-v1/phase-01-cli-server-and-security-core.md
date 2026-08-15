---
phase: 1
title: "CLI, server, security core"
status: completed
priority: P1
effort: "2.5d"
dependencies: []
---

# Phase 1: CLI, server, security core

## Overview

`gal <path>` khởi động HTTP server localhost, mở browser. Toàn bộ lớp bảo mật nằm ở phase này —
vì app phục vụ file tuỳ ý trên ổ đĩa, làm sai ở đây là lỗ hổng thật, không phải lỗi thẩm mỹ.

## Requirements

**Functional**
- `gal <path>` → resolve path, validate tồn tại và là thư mục, bind 127.0.0.1 port ngẫu nhiên, mở browser
- Serve static frontend từ `web/`
- `GET /api/file?p=<path>` phục vụ file gốc, **hỗ trợ HTTP Range đầy đủ**
- Không đối số → in usage ngắn, exit 0. Path không tồn tại → lỗi rõ ràng, exit 1

**Non-functional**
- Mặc định chỉ bind loopback. Bind `0.0.0.0` chỉ khi user tự bật `--lan`
- Mọi request bị từ chối nếu `Host` header không phải `127.0.0.1:<port>` hoặc `localhost:<port>`
- Mọi path phải nằm trong root sau khi `realpath`

## Architecture

**Ba lớp phòng thủ, không lớp nào thay thế lớp nào:**

1. **Path containment** (`src/safe-path.js`) — `realpath` cả root lẫn path yêu cầu, rồi
   `path.relative(root, target)` không được bắt đầu bằng `..` và không được là absolute.
   *Không dùng `resolved.startsWith(root)`* — pattern này hỏng với `/root` vs `/root-evil`,
   và trên APFS (case-insensitive, chuẩn hoá Unicode) so chuỗi thô sẽ trượt trong khi kernel
   vẫn trỏ cùng inode. Đây chính là lớp lỗ hổng Deno đã dính (CVE-2026-49401).

2. **Host header validation** (`src/server.js`) — chặn DNS rebinding. Port ngẫu nhiên **một mình
   là không đủ**: trang web độc hại có thể rebind `evil.com` → `127.0.0.1`, và same-origin policy
   so hostname chứ không so IP, nên request đi lọt như same-origin. Vite đã dính đúng lỗi này
   (GHSA-vg6x-rcgg-rjx6), webpack-dev-server cũng vậy.

3. **Origin / `Sec-Fetch-Site` validation** — Host một mình **cũng không đủ**.
   `<img src="http://127.0.0.1:PORT/api/thumb?i=5">` từ trang bất kỳ sẽ gửi Host **hợp lệ**
   (`127.0.0.1:PORT`) và đi lọt qua lớp 2. Phải chặn thêm: từ chối request có `Origin` khác
   origin của chính server, và từ chối `Sec-Fetch-Site: cross-site`.

4. **Content-type an toàn cho `/api/file`** — đây là lỗ hổng nặng nhất nếu bỏ qua.
   Thư mục ảnh của user có thể chứa file `.html` hoặc `.svg`. Phục vụ chúng từ cùng origin
   nghĩa là **script chạy trong origin của gal** và đọc được mọi file dưới root.
   Bắt buộc: allowlist đuôi media (`src/media-types.js` đã có), `X-Content-Type-Options: nosniff`,
   và `Content-Disposition: attachment` cho mọi thứ không phải ảnh/video đã biết.
   SVG phải phục vụ dưới `Content-Type: image/svg+xml` kèm CSP `sandbox`, hoặc đơn giản hơn:
   **loại SVG khỏi danh sách media v1**.

5. **Port ngẫu nhiên** — defense in depth, chống dò mù. Giữ, nhưng không tin cậy một mình.
   Lưu ý: dải ephemeral macOS là 49152-65535 (đo bằng `sysctl`) = **16384 cổng**, nên trùng cổng
   giữa các lần chạy khác root là chuyện sẽ xảy ra — xem mục cache bên dưới.

6. **Khoá cache thumbnail phải theo nội dung, không theo URL.** `/api/thumb?i=5` với
   `Cache-Control: immutable` sẽ khiến browser tái dùng thumbnail của **root khác** khi trùng
   cổng (16384 cổng, và `--port` ở Phase 9 làm nó thành tất định). Sửa: URL phải chứa hash
   nội dung, ví dụ `/api/thumb/<hash>.jpg`, thì `immutable` mới đúng nghĩa.

**HTTP Range** (`src/range.js`) — Node `http` không cho sẵn, phải tự viết. Phải xử lý:
`206`, `Content-Range: bytes s-e/total`, `Accept-Ranges: bytes` (kể cả trên GET thường),
`If-Range` (validator có điều kiện), suffix range (`bytes=-500`), open-ended (`bytes=500-`),
range không hợp lệ → `416`. **Bỏ qua multi-range** — browser gần như không gửi cho `<video>`.

Thiếu `If-Range` sẽ gây bug im lặng: `<video>` thỉnh thoảng tải lại toàn bộ file sau khi seek.
Không crash, không log, chỉ chậm — loại bug dễ ship mà không ai thấy.

## Related Code Files

- Create: `bin/gal.js` (shebang, gọi src/cli.js)
- Create: `src/cli.js`, `src/server.js`, `src/safe-path.js`, `src/range.js`
- Create: `package.json` (type: module, bin: gal, engines: node >=22)
- Create: `test/safe-path.test.js`, `test/range.test.js`, `test/host-guard.test.js`
- Create: `web/index.html` (khung rỗng để verify serve tĩnh)

## Implementation Steps

1. `package.json`: ESM, `bin: {gal: "./bin/gal.js"}`, `engines.node >= 22` (mốc `node:sqlite`).
2. `src/safe-path.js`: export `resolveInside(root, rel)` → absolute path hoặc ném lỗi.
   Dùng `fs.realpath` cho cả hai vế trước khi so.
3. `src/range.js`: export `parseRange(header, size)` và `serveFile(req, res, absPath)`.
   `serveFile` set `Accept-Ranges` cả khi không có Range.
4. `src/server.js`: `http.createServer`, middleware guard Host đầu tiên, rồi router.
   `server.listen(0, '127.0.0.1')` lấy port thật từ `server.address().port`.
5. `src/cli.js`: parse argv (không thêm thư viện — `process.argv.slice(2)` là đủ),
   resolve root, start server, **mở Chrome cụ thể**:
   `spawn('open', ['-a', 'Google Chrome', url])`. Không dùng `open <url>` trần vì nó mở browser
   mặc định — trên macOS gốc là Safari, ngoài phạm vi hỗ trợ v1 (validation 2026-08-15).
   Không có Chrome → in URL kèm ghi chú "v1 nhắm Chrome", vẫn khởi động server chứ không thoát.
   Luôn in URL ra stdout để user tự mở nếu cần.
6. Test bằng `node:test` builtin, không thêm test framework.

## Success Criteria

- [x] `gal <thư mục>` mở **Chrome** tới trang có tiêu đề, in URL ra terminal
- [ ] Máy không có Chrome → vẫn khởi động server, in URL + ghi chú, không thoát lỗi
      *(code path có: `open` exit≠0 → in ghi chú; chưa chạy được trên máy không có Chrome)*
- [x] `gal /không/tồn/tại` → thông báo lỗi rõ, exit 1
- [x] `curl -H 'Host: evil.com' <url>` → 403
- [x] `curl -H 'Origin: https://evil.com' <url>/api/...` → 403
- [x] `curl -H 'Sec-Fetch-Site: cross-site' <url>/api/file?...` → 403
- [x] File `.html` trong thư mục ảnh → **không** phục vụ dạng `text/html` thực thi được (403, ngoài allowlist)
- [x] Mọi response `/api/file` có `X-Content-Type-Options: nosniff`
- [x] `curl '<url>/api/file?p=../../../../etc/passwd'` → 403, và mọi biến thể encode
- [x] Test: path traversal qua symlink trỏ ra ngoài root → chặn
- [x] Test: `/ROOT/x.jpg` với root `/root` không bypass được (APFS case-insensitivity)
- [ ] URL thumbnail chứa hash nội dung → thuộc Phase 4, chưa có route `/api/thumb`
- [x] Test Range: full, `bytes=0-99`, `bytes=100-`, `bytes=-500`, `If-Range` khớp và không khớp, range quá size → 416
- [x] `curl -r 0-99 <url>/api/file?p=... -o -` trả đúng 100 byte, status 206

## Ghi chú thực hiện

- Đuôi ngoài allowlist media → **403**, không phải `Content-Disposition: attachment`.
  Ít đường đi hơn, cùng hiệu quả phòng thủ. SVG bị loại khỏi allowlist đúng như phân tích.
- `Sec-Fetch-Site` chỉ chấp nhận `same-origin` và `none`. `same-site` cũng bị chặn vì
  localhost khác cổng vẫn gửi `same-site` mà đã là cross-origin.
- Test Host guard dùng `node:http` thô — `fetch`/undici cấm ghi đè header `Host`.
- ETag = `size-mtime` (mtime đã `Math.floor`), dùng cho cả `If-Range`.
- **`--lan` (yêu cầu của chủ dự án 2026-08-15)** — nới yêu cầu "chỉ bind loopback,
  không bao giờ 0.0.0.0" thành opt-in. Không bật cờ thì hành vi cũ giữ nguyên.
  Bật thì bind `0.0.0.0`, và Host guard nới đúng bằng **allowlist địa chỉ thật của máy**
  (`os.networkInterfaces()` + hostname + `.local`), không phải chấp nhận mọi Host —
  nới hết là mở lại đúng lỗ DNS rebinding mà lớp 2 sinh ra để chặn.
  Đánh đổi còn lại: trong LAN không có xác thực, ai biết URL đều xem được toàn bộ media
  dưới root. CLI in cảnh báo một dòng khi bật.

## Risk Assessment

**Rủi ro: tự viết Range sai một trường hợp biên.** Đây là lý do research nghiêng về Go
(`http.ServeContent` cho sẵn). Chọn Node là quyết định của chủ dự án, nên chi phí phải trả
là bộ test Range đầy đủ — không phải "chắc là đúng".
*Tín hiệu hỏng:* video tua bị giật hoặc tải lại từ đầu.
*Phản ứng:* thêm case test tái hiện, sửa parser; không nới lỏng test.

**Rủi ro: Host guard chặn nhầm.** Một số browser gửi Host kèm IPv6 `[::1]`.
*Tín hiệu:* trang trắng, 403 trong log.
*Phản ứng:* thêm `[::1]:<port>` vào allowlist — vẫn là loopback, không mở rộng bề mặt tấn công.
