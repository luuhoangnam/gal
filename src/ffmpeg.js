import { execFileSync } from 'node:child_process';

let cached;

/**
 * Định vị ffmpeg một lần rồi nhớ kết quả. Thiếu ffmpeg là lỗi hành động được,
 * không phải stack trace — Phase 9 dùng thông điệp này lúc khởi động.
 */
export function ffmpegPath() {
  if (cached !== undefined) return cached;
  try {
    cached = execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim() || null;
  } catch {
    cached = null;
  }
  return cached;
}

export const FFMPEG_MISSING =
  'gal cần ffmpeg để tạo thumbnail. Cài bằng: brew install ffmpeg';
