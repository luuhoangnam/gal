import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let cached;

/**
 * Tự quét PATH thay vì gọi `which`: `which` không có trên Windows, và một lần
 * spawn để tìm một file là đắt hơn việc tự nhìn vào PATH.
 */
export function ffmpegPath() {
  if (cached !== undefined) return cached;
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  cached = null;
  for (const dir of searchDirs()) {
    const p = path.join(dir, exe);
    try {
      accessSync(p, constants.X_OK);
      cached = p;
      break;
    } catch {
      /* thư mục tiếp theo */
    }
  }
  return cached;
}

/**
 * PATH, cộng hai thư mục Homebrew. GUI trên macOS khởi động process với PATH
 * tối giản không có `/opt/homebrew/bin`, nên chỉ tin PATH là bỏ sót ffmpeg đã
 * cài — lỗi khó hiểu nhất có thể gặp.
 */
export function searchDirs() {
  const extra = process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [];
  const fromPath = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return [...new Set([...fromPath, ...extra])];
}

const INSTALL = {
  darwin: 'brew install ffmpeg',
  linux: 'sudo apt install ffmpeg   (hoặc dnf/pacman tuỳ bản phân phối)',
  win32: 'winget install ffmpeg',
};

/** Thông điệp thiếu ffmpeg: nói cách cài VÀ đã tìm ở đâu, không phải stack trace. */
export function ffmpegMissingMessage() {
  const how = INSTALL[process.platform] ?? 'cài ffmpeg từ https://ffmpeg.org/download.html';
  const dirs = searchDirs();
  const shown = dirs.slice(0, 6).join(', ');
  return [
    'gal: cần ffmpeg để tạo thumbnail cho ảnh và video.',
    `  Cài: ${how}`,
    `  Đã tìm trong ${dirs.length} thư mục của PATH: ${shown}${dirs.length > 6 ? ', …' : ''}`,
  ].join(os.EOL);
}
