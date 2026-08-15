#!/usr/bin/env node

// Kiểm tra phiên bản TRƯỚC khi import: `src/` kéo theo `node:sqlite`, có từ Node
// 22. Trên Node cũ hơn, import thẳng sẽ nổ ra một `ERR_UNKNOWN_BUILTIN_MODULE`
// không nói được gì cho người dùng.
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.error(
    `gal: cần Node 22 trở lên (đang chạy ${process.versions.node}).\n` +
      '  Nâng cấp: https://nodejs.org — hoặc `nvm install 22`',
  );
  process.exit(1);
}

const { main } = await import('../src/cli.js');
main(process.argv.slice(2));
