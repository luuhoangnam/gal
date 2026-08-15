// Allowlist đuôi media. Mọi thứ ngoài bảng này không bao giờ được phục vụ:
// một file .html/.svg trong thư mục ảnh = script chạy trong origin của gal,
// đọc được mọi file dưới root. SVG bị loại khỏi v1 vì lý do đó.
export const MEDIA_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.3gp': 'video/3gpp',
};

export const IMAGE_EXTS = new Set(
  Object.keys(MEDIA_TYPES).filter((e) => MEDIA_TYPES[e].startsWith('image/')),
);
export const VIDEO_EXTS = new Set(
  Object.keys(MEDIA_TYPES).filter((e) => MEDIA_TYPES[e].startsWith('video/')),
);

export function mediaType(ext) {
  return MEDIA_TYPES[ext.toLowerCase()] ?? null;
}

/** Nhận diện theo đuôi file. Pha A không sniff nội dung — quá đắt trên 70k file. */
export function classify(name) {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return null;
}
