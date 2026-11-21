/**
 * public/js/config.js
 * 全局常量配置、MIME 类型映射、基础工具函数与矢量 SVG 图标引擎
 */

export const CHUNK_SIZE = 10 * 1024 * 1024;           // 10 MB 分块大小，充分吃满跨境并发
export const MULTIPART_THRESHOLD = 20 * 1024 * 1024;  // 超过 20 MB 启用分块直传（<=20MB 走单次 PUT）
export const MAX_CONCURRENT_CHUNKS = 5;               // 5 路并发分块
export const MAX_CONCURRENT_FILES = 3;

export const API = {
  auth:  '/api/auth',
  files: '/api/files',
  file:  '/api/file',
};

export const DIR_CACHE_TTL = 60 * 60 * 1000; // 1 小时有效期
export const STORAGE_CACHE_KEY = 'r2_drive_cache_v2';
export const STORAGE_TREE_KEY  = 'r2_drive_tree_v2';
export const STORAGE_USAGE_KEY = 'r2_drive_usage_v1';
export const TOTAL_CAPACITY_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB 免费额度
export const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;       // 文本在线预览上限 2 MB
export const MAX_RICH_PREVIEW_BYTES = 30 * 1024 * 1024;      // DOCX/XLSX/ZIP 在线解析上限 30 MB
export const MAX_HEIC_CACHE_ITEMS = 15;                      // HEIC 解码 ObjectURL 缓存上限

export const EXT_TYPE_MAP = {
  // 图片
  jpg:'image', jpeg:'image', png:'image', gif:'image', webp:'image',
  svg:'image', bmp:'image', ico:'image', tiff:'image', avif:'image',
  heic:'image', heif:'image',
  // 视频
  mp4:'video', webm:'video', mov:'video', avi:'video', mkv:'video', flv:'video',
  // 音频
  mp3:'audio', wav:'audio', ogg:'audio', flac:'audio', aac:'audio', m4a:'audio',
  // 文本
  txt:'text', md:'text', log:'text', csv:'text', yaml:'text', yml:'text', ini:'text', conf:'text',
  // 代码
  js:'code', ts:'code', jsx:'code', tsx:'code', html:'code', htm:'code',
  css:'code', json:'code', xml:'code', sh:'code', bash:'code', py:'code',
  go:'code', rs:'code', java:'code', cpp:'code', c:'code', h:'code',
  php:'code', rb:'code', swift:'code', kt:'code', sql:'code', toml:'code',
  // 文档
  pdf:'pdf',
  xls:'excel', xlsx:'excel',
  doc:'word', docx:'word',
  ppt:'ppt', pptx:'ppt',
  // 压缩
  zip:'zip', tar:'zip', gz:'zip', '7z':'zip', rar:'zip', bz2:'zip',
};

export function formatSize(bytes) {
  if (bytes == null || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

export function formatDate(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  return d.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

export function getFileName(key) {
  return key.split('/').filter(Boolean).pop() || key;
}

export const TYPE_GROUPS = {
  image:   ['image'],
  video:   ['video'],
  doc:     ['pdf', 'word', 'excel', 'ppt', 'text'],
  archive: ['zip'],
};

const THUMB_EXCLUDED_EXTS = new Set(['heic', 'heif', 'svg']);

export function getExt(key) {
  const name = getFileName(key);
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

export function getFileType(key) {
  return EXT_TYPE_MAP[getExt(key)] || 'default';
}

export function getFileCategory(key) {
  const type = getFileType(key);
  for (const [cat, types] of Object.entries(TYPE_GROUPS)) {
    if (types.includes(type)) return cat;
  }
  return 'other';
}

export function isThumbnailSupported(key) {
  const ext = getExt(key);
  return getFileType(key) === 'image' && !THUMB_EXCLUDED_EXTS.has(ext);
}

export function uid() {
  return Math.random().toString(36).slice(2);
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const VALID_BADGE_TYPES = new Set([
  'folder', 'image', 'video', 'audio', 'code', 'text',
  'pdf', 'excel', 'word', 'ppt', 'zip', 'default',
]);

export function renderSvgIcon(type, size = 20) {
  const icons = {
    folder: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#007AFF" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" fill="rgba(0,122,255,0.16)"/>
    </svg>`,
    image: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#34C759" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="3" fill="rgba(52,199,89,0.12)"/>
      <circle cx="8.5" cy="8.5" r="1.5" fill="#34C759"/>
      <path d="m21 15-3.5-3.5a2 2 0 0 0-2.828 0L6 21"/>
    </svg>`,
    video: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#AF52DE" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="3" fill="rgba(175,82,222,0.12)"/>
      <path d="m10 8.5 5.5 3.5-5.5 3.5v-7Z" fill="#AF52DE"/>
    </svg>`,
    audio: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#FF9500" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="9" fill="rgba(255,149,0,0.12)"/>
      <path d="M9.5 17V9l7-1.8V15"/>
      <circle cx="8" cy="17" r="1.8" fill="#FF9500"/>
      <circle cx="15" cy="15" r="1.8" fill="#FF9500"/>
    </svg>`,
    code: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#64748B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="16 18 22 12 16 6"/>
      <polyline points="8 6 2 12 8 18"/>
    </svg>`,
    text: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#64748B" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" fill="rgba(100,116,139,0.08)"/>
      <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
      <line x1="8" x2="16" y1="13" y2="13"/>
      <line x1="8" x2="13" y1="17" y2="17"/>
    </svg>`,
    pdf: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#FF3B30" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" fill="rgba(255,59,48,0.10)"/>
      <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
      <path d="M9 17v-5h2a1.75 1.75 0 0 1 0 3.5H9"/>
    </svg>`,
    excel: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#16A34A" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" fill="rgba(22,163,74,0.10)"/>
      <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
      <path d="M8 13h8"/>
      <path d="M8 17h8"/>
      <path d="M12 11v8"/>
    </svg>`,
    word: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#2563EB" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" fill="rgba(37,99,235,0.10)"/>
      <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
      <line x1="8" x2="16" y1="13" y2="13"/>
      <line x1="8" x2="16" y1="17" y2="17"/>
    </svg>`,
    ppt: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#EA580C" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" fill="rgba(234,88,12,0.10)"/>
      <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
      <rect x="8" y="12" width="8" height="5" rx="1"/>
    </svg>`,
    zip: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#D97706" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 8v13H3V8" fill="rgba(217,119,6,0.10)"/>
      <path d="M1 3h22v5H1z" fill="rgba(217,119,6,0.14)"/>
      <path d="M10 12h4"/>
    </svg>`,
    default: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#8E8E93" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" fill="rgba(142,142,147,0.08)"/>
      <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
    </svg>`,
  };
  return icons[type] || icons.default;
}

export function renderFileBadge(type, badgeSize = 'md') {
  const safeType = VALID_BADGE_TYPES.has(type) ? type : 'default';
  const iconSize = badgeSize === 'lg' ? 26 : badgeSize === 'sm' ? 18 : 20;
  return `<span class="file-type-badge file-type-badge--${badgeSize} is-${safeType}" aria-hidden="true">${renderSvgIcon(safeType, iconSize)}</span>`;
}
