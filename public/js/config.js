/**
 * public/js/config.js
 * 全局常量配置、MIME 类型映射、基础工具函数与矢量 SVG 图标引擎
 */

export const CHUNK_SIZE = 50 * 1024 * 1024;           // 严格锁定 50 MB 分块大小
export const MULTIPART_THRESHOLD = 50 * 1024 * 1024;  // 严格锁定 50 MB 启用分块（<=50MB 走单次高效 PUT 直传）
export const MAX_CONCURRENT_CHUNKS = 3;
export const MAX_CONCURRENT_FILES = 3;

export const API = {
  auth:  '/api/auth',
  files: '/api/files',
  file:  '/api/file',
};

export const DIR_CACHE_TTL = 10 * 60 * 1000; // 10 分钟有效期
export const STORAGE_CACHE_KEY = 'r2_drive_cache_v2';
export const STORAGE_TREE_KEY  = 'r2_drive_tree_v2';
export const STORAGE_USAGE_KEY = 'r2_drive_usage_v1';
export const TOTAL_CAPACITY_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB 免费额度
export const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;       // 文本在线预览上限 2 MB

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

export function getExt(key) {
  const name = getFileName(key);
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

export function getFileType(key) {
  return EXT_TYPE_MAP[getExt(key)] || 'default';
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

export function renderSvgIcon(type, size = 20) {
  const icons = {
    folder: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#0071e3" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" fill="rgba(0,113,227,0.15)"/>
    </svg>`,
    image: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#34c759" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" fill="rgba(52,199,89,0.12)"/>
      <circle cx="9" cy="9" r="2"/>
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
    </svg>`,
    video: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#af52de" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="2" fill="rgba(175,82,222,0.12)"/>
      <path d="m10 9 5 3-5 3v-6Z" fill="#af52de"/>
    </svg>`,
    audio: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#ff9500" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="9" fill="rgba(255,149,0,0.12)"/>
      <path d="M9 18V9l8-2v9"/>
      <circle cx="8" cy="18" r="2" fill="#ff9500"/>
      <circle cx="16" cy="16" r="2" fill="#ff9500"/>
    </svg>`,
    code: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#5856d6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="16 18 22 12 16 6"/>
      <polyline points="8 6 2 12 8 18"/>
    </svg>`,
    text: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>
      <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
      <line x1="10" x2="14" y1="13" y2="13"/>
      <line x1="10" x2="14" y1="17" y2="17"/>
    </svg>`,
    pdf: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#ff3b30" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" fill="rgba(255,59,48,0.1)"/>
      <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
      <path d="M9 14v3"/>
      <path d="M9 14h2a1.5 1.5 0 0 0 0-3H9"/>
    </svg>`,
    excel: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#34c759" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" fill="rgba(52,199,89,0.1)"/>
      <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
      <path d="M8 13h8"/>
      <path d="M8 17h8"/>
      <path d="M12 11v8"/>
    </svg>`,
    word: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#0071e3" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" fill="rgba(0,113,227,0.1)"/>
      <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
      <line x1="8" x2="16" y1="13" y2="13"/>
      <line x1="8" x2="16" y1="17" y2="17"/>
    </svg>`,
    zip: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#eab308" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 8v13H3V8"/>
      <path d="M1 3h22v5H1z"/>
      <path d="M10 12h4"/>
    </svg>`,
    default: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>
      <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
    </svg>`,
  };
  return icons[type] || icons.default;
}
