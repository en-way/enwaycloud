/**
 * app.js — R2 云盘前端核心逻辑 (Apple 现代微质感 · 复选框多选与集中操作版)
 * 纯原生 JavaScript | 零外部依赖 | 毫秒级首屏 | 全矢量 SVG 图标
 */

'use strict';

// ─── 常量与配置 (R2 终极省流版：50MB 大分块与单文件直传) ─────────────────────────
const CHUNK_SIZE = 50 * 1024 * 1024;           // 严格锁定 50 MB 分块大小
const MULTIPART_THRESHOLD = 50 * 1024 * 1024;  // 严格锁定 50 MB 启用分块（<=50MB 走单次高效 PUT 直传）
const MAX_CONCURRENT_CHUNKS = 3;               // 最大并发分块数
const MAX_CONCURRENT_FILES = 3;                // 最大并发文件数

const API = {
  auth:  '/api/auth',
  files: '/api/files',
  file:  '/api/file',
};

// ─── sessionStorage 跨刷新目录持久化缓存 (10分钟保鲜) ──────────────────────────
const DIR_CACHE_TTL = 10 * 60 * 1000; // 10 分钟有效期
const STORAGE_CACHE_KEY = 'r2_drive_cache_v2';
const STORAGE_USAGE_KEY = 'r2_drive_usage_v1';
const TOTAL_CAPACITY_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB 免费额度
const inFlightRequests = new Map(); // key -> Promise

function loadDirCacheFromStorage() {
  try {
    const raw = sessionStorage.getItem(STORAGE_CACHE_KEY);
    if (!raw) return new Map();
    const data = JSON.parse(raw);
    const map = new Map();
    const now = Date.now();
    for (const [k, v] of Object.entries(data)) {
      if (now - v.timestamp < DIR_CACHE_TTL) {
        map.set(k, v);
      }
    }
    return map;
  } catch (_) {
    return new Map();
  }
}

const dirCache = loadDirCacheFromStorage();

function saveDirCacheToStorage() {
  try {
    const obj = Object.fromEntries(dirCache);
    sessionStorage.setItem(STORAGE_CACHE_KEY, JSON.stringify(obj));
  } catch (_) {}
}

function clearDirCache() {
  dirCache.clear();
  textPreviewCache.clear();
  heicPreviewCache.clear();
  xlsxPreviewCache.clear();
  try {
    sessionStorage.removeItem(STORAGE_CACHE_KEY);
    sessionStorage.removeItem(STORAGE_USAGE_KEY);
  } catch (_) {}
  state.allObjects = null;
  state.isVirtualTree = false;
  state.totalUsedBytes = 0;
  updateStorageUI(0);
}

// ─── 全盘轻量虚拟树解析引擎 (Single-Pass Virtual Tree: 0 网络请求，0 Class A) ────
function extractVirtualDir(prefix) {
  if (!state.allObjects) return null;
  const prefixLen = prefix.length;
  const folderSet = new Set();
  const files = [];

  for (const obj of state.allObjects) {
    if (!obj.key.startsWith(prefix)) continue;
    if (obj.key === prefix) continue;

    const rest = obj.key.slice(prefixLen);
    const slashIndex = rest.indexOf('/');

    if (slashIndex !== -1) {
      // 提取直接子目录
      const folderName = rest.slice(0, slashIndex + 1);
      folderSet.add(prefix + folderName);
    } else {
      // 当前层级的文件（或非 0 字节目录占位符）
      if (!obj.key.endsWith('/') || obj.size > 0) {
        files.push(obj);
      }
    }
  }

  return {
    folders: Array.from(folderSet).sort(),
    files,
  };
}

// ─── 预览本地内存缓存池 (同一会话内重复查看零网络开销，零 Class A) ────────────────
const textPreviewCache = new Map(); // key -> text content
const heicPreviewCache = new Map(); // key -> ObjectUrl
const xlsxPreviewCache = new Map(); // key -> ArrayBuffer

// ─── 异步依赖脚本按需加载器 (仅在首次使用时拉取本地 vendor，0 首屏负担) ──────────────
const loadedScripts = new Set();
function loadScript(src) {
  if (loadedScripts.has(src)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => { loadedScripts.add(src); resolve(); };
    s.onerror = () => reject(new Error('无法加载本地依赖库：' + src));
    document.head.appendChild(s);
  });
}

// ─── 本地状态乐观更新 (Optimistic UI Update: 彻底省去写后额外 list() 请求) ───────
function optimisticRemoveItems(keys) {
  const set = new Set(keys);
  const isRemoved = k => {
    if (set.has(k)) return true;
    for (const item of keys) {
      if (item.endsWith('/') && k.startsWith(item)) return true;
    }
    return false;
  };

  // 统计被删除文件的总大小
  let deletedBytes = 0;
  const removedSet = new Set();
  state.files.forEach(f => {
    if (isRemoved(f.key) && !removedSet.has(f.key)) {
      removedSet.add(f.key);
      deletedBytes += (f.size || 0);
    }
  });
  if (state.allObjects) {
    state.allObjects.forEach(o => {
      if (isRemoved(o.key) && !removedSet.has(o.key)) {
        removedSet.add(o.key);
        deletedBytes += (o.size || 0);
      }
    });
  }

  state.files = state.files.filter(f => !isRemoved(f.key));
  state.folders = state.folders.filter(f => !isRemoved(f));

  // 1. 同步更新全盘虚拟树
  if (state.allObjects) {
    state.allObjects = state.allObjects.filter(o => !isRemoved(o.key));
  }

  // 2. 同步更新各目录 cache (前缀级联清除)
  for (const [pfx, cached] of dirCache.entries()) {
    if (isRemoved(pfx)) {
      dirCache.delete(pfx);
    } else {
      cached.files = cached.files.filter(f => !isRemoved(f.key));
      cached.folders = cached.folders.filter(f => !isRemoved(f));
    }
  }
  saveDirCacheToStorage();

  // 3. 实时扣减容量并更新 UI (0 额外 Class A)
  state.totalUsedBytes = Math.max(0, state.totalUsedBytes - deletedBytes);
  updateStorageUI(state.totalUsedBytes);

  keys.forEach(k => textPreviewCache.delete(k));
  state.selectedKeys.clear();
  updateSelectionUI();
  renderFileList();
}

function optimisticAddFolder(folderKey) {
  // 1. 同步推入全盘虚拟树（0 字节目录占位符）
  if (state.allObjects) {
    const exists = state.allObjects.some(o => o.key === folderKey);
    if (!exists) {
      state.allObjects.push({
        key: folderKey,
        size: 0,
        uploaded: new Date().toISOString(),
        httpMetadata: { contentType: 'application/x-directory' },
        etag: null,
      });
    }
  }

  if (!state.folders.includes(folderKey)) {
    state.folders.push(folderKey);
    state.folders.sort();
  }

  const cached = dirCache.get(state.currentPrefix);
  if (cached && !cached.folders.includes(folderKey)) {
    cached.folders.push(folderKey);
    cached.folders.sort();
  }
  saveDirCacheToStorage();
  renderFileList();
}

function optimisticAddFile(key, size, mimeType) {
  textPreviewCache.delete(key);
  const oldFile = state.files.find(f => f.key === key) || (state.allObjects && state.allObjects.find(o => o.key === key));
  const diff = size - (oldFile ? (oldFile.size || 0) : 0);

  const newFile = {
    key,
    size,
    uploaded: new Date().toISOString(),
    httpMetadata: { contentType: mimeType || 'application/octet-stream' },
    etag: null,
  };

  // 1. 同步更新全盘虚拟树
  if (state.allObjects) {
    state.allObjects = state.allObjects.filter(o => o.key !== key);
    state.allObjects.push(newFile);
  }

  // 2. 更新当前视图与缓存
  state.files = state.files.filter(f => f.key !== key);
  state.files.push(newFile);

  const cached = dirCache.get(state.currentPrefix);
  if (cached) {
    cached.files = cached.files.filter(f => f.key !== key);
    cached.files.push(newFile);
  }
  saveDirCacheToStorage();

  // 3. 实时累加容量并更新 UI (0 额外 Class A)
  state.totalUsedBytes = Math.max(0, state.totalUsedBytes + diff);
  updateStorageUI(state.totalUsedBytes);

  renderFileList();
}

function optimisticMoveItems(mappings) {
  // mappings: Array<{ from: string, to: string, isFolder: boolean }>
  for (const m of mappings) {
    textPreviewCache.delete(m.from);
    heicPreviewCache.delete(m.from);
    xlsxPreviewCache.delete(m.from);

    if (m.isFolder) {
      if (state.allObjects) {
        state.allObjects.forEach(obj => {
          if (obj.key.startsWith(m.from)) {
            obj.key = m.to + obj.key.slice(m.from.length);
          }
        });
      }
    } else {
      if (state.allObjects) {
        const target = state.allObjects.find(o => o.key === m.from);
        if (target) {
          target.key = m.to;
        }
      }
    }
  }

  // 清空内存目录缓存池以基于原地更新后的 state.allObjects 重新渲染，0 次网络请求
  dirCache.clear();
  sessionStorage.removeItem(STORAGE_CACHE_KEY);

  if (state.isVirtualTree && state.allObjects) {
    const vData = extractVirtualDir(state.currentPrefix);
    if (vData) {
      state.folders = vData.folders;
      state.files = vData.files;
    }
  } else {
    const fromKeys = new Set(mappings.map(m => m.from));
    state.files = state.files.filter(f => !fromKeys.has(f.key));
    state.folders = state.folders.filter(f => !fromKeys.has(f));
  }

  state.selectedKeys.clear();
  updateSelectionUI();
  renderFileList();
}

// 扩展名映射文件类型
const EXT_TYPE_MAP = {
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

// ─── SVG 矢量图标引擎 ──────────────────────────────────────────────────────────
function renderSvgIcon(type, size = 20) {
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

// ─── 应用状态 ──────────────────────────────────────────────────────────────────
const state = {
  password:      localStorage.getItem('drive_password') || '',
  currentPrefix: '',
  files:         [],
  folders:       [],
  selectedKeys:  new Set(),  // 勾选中的项目 key 集合
  viewMode:      localStorage.getItem('view_mode') || 'list',
  sortKey:       'name',
  sortDir:       'asc',
  uploadQueue:   [],
  previewItem:   null,
  loading:       false,
  allObjects:    null,       // 全盘虚拟树平铺对象数组
  isVirtualTree: false,      // 是否启用了全盘虚拟树模式 (整盘 1 次 Class A 搞定)
  totalUsedBytes: parseInt(sessionStorage.getItem(STORAGE_USAGE_KEY) || '0', 10) || 0,
};

// ─── DOM 缓存 ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const dom = {
  appLoader:          $('app-loader'),
  loginModal:         $('login-modal'),
  loginForm:          $('login-form'),
  passwordInput:      $('password-input'),
  togglePassword:     $('toggle-password'),
  eyeIcon:            $('eye-icon'),
  loginError:         $('login-error'),
  loginBtnText:       $('login-btn-text'),
  loginSpinner:       $('login-spinner'),

  app:                $('app'),
  breadcrumb:         $('breadcrumb'),
  storageBadge:       $('storage-badge'),
  storageBarFill:     $('storage-bar-fill'),
  storageText:        $('storage-text'),

  btnViewList:        $('btn-view-list'),
  btnViewGrid:        $('btn-view-grid'),
  btnLogout:          $('btn-logout'),

  btnUpload:          $('btn-upload'),
  fileInput:          $('file-input'),
  btnMkdir:           $('btn-mkdir'),
  btnBatchRename:     $('btn-batch-rename'),
  textBatchRename:    $('text-batch-rename'),
  btnBatchMove:       $('btn-batch-move'),
  textBatchMove:      $('text-batch-move'),
  btnBatchDownload:   $('btn-batch-download'),
  textBatchDownload:  $('text-batch-download'),
  btnBatchDelete:     $('btn-batch-delete'),
  textBatchDelete:    $('text-batch-delete'),
  btnRefresh:         $('btn-refresh'),
  fileCount:          $('file-count'),

  dropOverlay:        $('drop-overlay'),

  uploadPanel:        $('upload-panel'),
  uploadList:         $('upload-list'),
  btnClearDone:       $('btn-clear-done'),
  btnClosePanel:      $('btn-close-panel'),

  fileListView:       $('file-list-view'),
  fileGridView:       $('file-grid-view'),
  selectAllCheckbox:  $('select-all-checkbox'),
  fileTbody:          $('file-tbody'),
  fileGrid:           $('file-grid'),
  emptyHint:          $('empty-hint'),
  emptyHintGrid:      $('empty-hint-grid'),
  loadingHint:        $('loading-hint'),

  previewModal:       $('preview-modal'),
  previewIcon:        $('preview-icon'),
  previewFilename:    $('preview-filename'),
  previewMeta:        $('preview-meta'),
  previewBody:        $('preview-body'),
  btnPreviewDl:       $('btn-preview-download'),
  btnPreviewDel:      $('btn-preview-delete'),
  btnPreviewClose:    $('btn-preview-close'),

  mkdirModal:         $('mkdir-modal'),
  mkdirForm:          $('mkdir-form'),
  mkdirInput:         $('mkdir-input'),
  mkdirError:         $('mkdir-error'),
  btnMkdirCancel:     $('btn-mkdir-cancel'),

  confirmModal:       $('confirm-modal'),
  confirmTitle:       $('confirm-title'),
  confirmMessage:     $('confirm-message'),
  btnConfirmCancel:   $('btn-confirm-cancel'),
  btnConfirmOk:       $('btn-confirm-ok'),

  renameModal:        $('rename-modal'),
  renameTitle:        $('rename-title'),
  renameForm:         $('rename-form'),
  renameInput:        $('rename-input'),
  renameError:        $('rename-error'),
  btnRenameCancel:    $('btn-rename-cancel'),
  btnRenameSubmit:    $('btn-rename-submit'),

  moveModal:          $('move-modal'),
  moveTitle:          $('move-title'),
  moveSubtitle:       $('move-subtitle'),
  moveFolderTree:     $('move-folder-tree'),
  moveQuotaTip:       $('move-quota-tip'),
  btnMoveCancel:      $('btn-move-cancel'),
  btnMoveConfirm:     $('btn-move-confirm'),

  toastContainer:     $('toast-container'),
};

// ─── 基础工具函数 ──────────────────────────────────────────────────────────────
function formatSize(bytes) {
  if (bytes == null || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function formatDate(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  return d.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function getFileName(key) {
  return key.split('/').filter(Boolean).pop() || key;
}

function getExt(key) {
  const name = getFileName(key);
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

function getFileType(key) {
  return EXT_TYPE_MAP[getExt(key)] || 'default';
}

function uid() {
  return Math.random().toString(36).slice(2);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildMediaUrl(key) {
  const url = new URL(API.file, location.origin);
  url.searchParams.set('key', key);
  if (state.password) url.searchParams.set('auth', state.password);
  return url.toString();
}

function buildDownloadUrl(key) {
  const url = new URL(API.file, location.origin);
  url.searchParams.set('key', key);
  url.searchParams.set('download', '1');
  if (state.password) url.searchParams.set('auth', state.password);
  return url.toString();
}

async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.password && !headers.has('X-Drive-Password')) {
    headers.set('X-Drive-Password', state.password);
  }
  const res = await fetch(url, { ...options, headers });
  return res;
}

// ─── Toast 通知系统 ────────────────────────────────────────────────────────────
function showToast(message, type = 'info', duration = 3000) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const iconSvg = type === 'success'
    ? `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`
    : type === 'error'
    ? `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`
    : `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;

  toast.innerHTML = `${iconSvg}<span>${escapeHtml(message)}</span>`;
  dom.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('removing');
    toast.addEventListener('animationend', () => toast.remove());
  }, duration);
}

// ─── 确认对话框 ────────────────────────────────────────────────────────────────
function showConfirm(title, message) {
  return new Promise(resolve => {
    dom.confirmTitle.textContent = title;
    dom.confirmMessage.textContent = message;
    dom.confirmModal.hidden = false;

    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };

    function cleanup() {
      dom.confirmModal.hidden = true;
      dom.btnConfirmOk.removeEventListener('click', onOk);
      dom.btnConfirmCancel.removeEventListener('click', onCancel);
    }

    dom.btnConfirmOk.addEventListener('click', onOk);
    dom.btnConfirmCancel.addEventListener('click', onCancel);
  });
}

// ─── 鉴权与首屏流 (纯轻量免 R2 校验，0 Class A 消耗) ───────────────────────────
async function tryAuth(password) {
  try {
    const res = await apiFetch(API.auth, {
      headers: { 'X-Drive-Password': password },
    });
    return res.status === 200;
  } catch (err) {
    return false;
  }
}

async function initAuth() {
  if (state.password) {
    const ok = await tryAuth(state.password);
    if (ok) {
      hideLoader();
      showApp();
      return;
    }
    state.password = '';
    localStorage.removeItem('drive_password');
  } else {
    const noPasswordNeeded = await tryAuth('');
    if (noPasswordNeeded) {
      hideLoader();
      showApp();
      return;
    }
  }

  hideLoader();
  showLogin();
}

function hideLoader() {
  if (dom.appLoader) {
    dom.appLoader.style.opacity = '0';
    setTimeout(() => { dom.appLoader.hidden = true; }, 250);
  }
}

function showLogin() {
  dom.loginModal.hidden = false;
  dom.app.hidden = true;
  setTimeout(() => dom.passwordInput?.focus(), 150);
}

// ─── 云盘容量占用显示 (Apple 微质感胶囊，0 额外 Class A) ────────────────────────
function updateStorageUI(usedBytes) {
  if (usedBytes != null) {
    state.totalUsedBytes = Math.max(0, usedBytes);
    try {
      sessionStorage.setItem(STORAGE_USAGE_KEY, String(state.totalUsedBytes));
    } catch (_) {}
  }
  if (!dom.storageBadge) return;
  dom.storageBadge.hidden = false;
  const pct = Math.min(100, Math.max(0, (state.totalUsedBytes / TOTAL_CAPACITY_BYTES) * 100));
  dom.storageBarFill.style.width = pct.toFixed(1) + '%';
  dom.storageBarFill.classList.toggle('warning', pct >= 80 && pct < 95);
  dom.storageBarFill.classList.toggle('danger', pct >= 95);
  dom.storageText.textContent = `${formatSize(state.totalUsedBytes)} / 10 GB`;
}

function showApp() {
  dom.loginModal.hidden = true;
  dom.app.hidden = false;
  applyViewMode();
  updateStorageUI();
  loadFiles(state.currentPrefix);
}

dom.loginForm.addEventListener('submit', async e => {
  e.preventDefault();
  const pwd = dom.passwordInput.value.trim();
  if (!pwd) return;

  dom.loginBtnText.textContent = '验证中...';
  dom.loginSpinner.hidden = false;
  dom.loginError.hidden = true;

  try {
    const ok = await tryAuth(pwd);
    if (ok) {
      state.password = pwd;
      localStorage.setItem('drive_password', pwd);
      showApp();
    } else {
      dom.loginError.textContent = '密码错误，请重新输入';
      dom.loginError.hidden = false;
      dom.passwordInput.select();
    }
  } catch (err) {
    dom.loginError.textContent = '网络连接异常，请重试';
    dom.loginError.hidden = false;
  } finally {
    dom.loginBtnText.textContent = '解锁进入';
    dom.loginSpinner.hidden = true;
  }
});

dom.togglePassword.addEventListener('click', () => {
  const isText = dom.passwordInput.type === 'text';
  dom.passwordInput.type = isText ? 'password' : 'text';
  dom.eyeIcon.innerHTML = isText
    ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`
    : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>`;
});

dom.btnLogout.addEventListener('click', () => {
  state.password = '';
  localStorage.removeItem('drive_password');
  clearDirCache();
  textPreviewCache.clear();
  state.currentPrefix = '';
  state.files = [];
  state.folders = [];
  state.selectedKeys.clear();
  showLogin();
});

// ─── 文件数据加载 (全盘轻量虚拟树 + sessionStorage 持久化 + 请求合并) ─────────────
async function loadFiles(prefix = '', forceRefresh = false) {
  state.loading = true;
  state.currentPrefix = prefix;
  state.selectedKeys.clear(); // 切换目录时清空勾选
  updateSelectionUI();
  renderBreadcrumb(prefix);

  // 1. 全盘轻量虚拟树引擎：若已索引整盘且非强制刷新，直接在内存切分目录，0 网络请求，0 Class A！
  if (!forceRefresh && state.isVirtualTree && state.allObjects) {
    const vData = extractVirtualDir(prefix);
    if (vData) {
      state.folders = vData.folders;
      state.files = vData.files;
      renderFileList();
      state.loading = false;
      setLoading(false);
      return;
    }
  }

  // 2. 检查 sessionStorage / 内存缓存 (10 分钟保鲜)
  const cached = dirCache.get(prefix);
  if (!forceRefresh && cached && (Date.now() - cached.timestamp < DIR_CACHE_TTL)) {
    state.folders = cached.folders || [];
    state.files = cached.files || [];
    renderFileList();
    state.loading = false;
    setLoading(false);
    return;
  }

  setLoading(true);

  // 3. 构建请求 URL：整盘首次加载或根目录强制刷新时优先扫描 ?all=1
  const shouldTryAll = (prefix === '' && (!state.isVirtualTree || forceRefresh));
  const reqUrl = shouldTryAll
    ? `${API.files}?all=1${forceRefresh ? '&refresh=1' : ''}`
    : `${API.files}?prefix=${encodeURIComponent(prefix)}${forceRefresh ? '&refresh=1' : ''}`;

  // 并发请求合并（In-flight Request Deduplication）
  const inFlightKey = reqUrl;
  if (inFlightRequests.has(inFlightKey)) {
    try {
      await inFlightRequests.get(inFlightKey);
    } catch (_) {}
    state.loading = false;
    setLoading(false);
    return;
  }

  const fetchPromise = (async () => {
    try {
      const res = await apiFetch(reqUrl);
      if (res.status === 401) {
        state.password = '';
        localStorage.removeItem('drive_password');
        clearDirCache();
        textPreviewCache.clear();
        showLogin();
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || '获取文件列表失败', 'error');
        return;
      }
      const data = await res.json();

      if (data.all) {
        // 成功载入全盘索引
        state.allObjects = data.objects || [];
        state.isVirtualTree = !data.truncated; // 如果 <= 1000 个文件，开启全盘虚拟树

        const vData = extractVirtualDir(prefix);
        state.folders = vData ? vData.folders : [];
        state.files = vData ? vData.files : [];

        // 统计并同步全盘容量 (0 额外 Class A)
        const total = data.totalSize != null
          ? data.totalSize
          : state.allObjects.reduce((acc, o) => acc + (o.size || 0), 0);
        updateStorageUI(total);
      } else {
        // 单目录按需降级模式
        state.folders = data.folders || [];
        state.files = data.files || [];
      }

      // 写入持久化缓存
      dirCache.set(prefix, {
        folders: state.folders,
        files: state.files,
        timestamp: Date.now(),
      });
      saveDirCacheToStorage();

      renderFileList();
    } catch (err) {
      showToast('网络错误：' + err.message, 'error');
    } finally {
      inFlightRequests.delete(inFlightKey);
      state.loading = false;
      setLoading(false);
    }
  })();

  inFlightRequests.set(inFlightKey, fetchPromise);
  await fetchPromise;
}

function setLoading(loading) {
  dom.loadingHint.hidden = !loading;
}

// ─── 面包屑导航 ────────────────────────────────────────────────────────────────
function renderBreadcrumb(prefix) {
  dom.breadcrumb.innerHTML = '';

  const rootBtn = document.createElement('button');
  rootBtn.className = 'breadcrumb-item root';
  rootBtn.dataset.prefix = '';
  rootBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="bc-icon">
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>根目录`;
  rootBtn.addEventListener('click', () => loadFiles(''));
  dom.breadcrumb.appendChild(rootBtn);

  if (!prefix) {
    rootBtn.classList.add('current');
    return;
  }

  const parts = prefix.split('/').filter(Boolean);
  parts.forEach((part, idx) => {
    const sep = document.createElement('span');
    sep.className = 'breadcrumb-separator';
    sep.textContent = '/';
    dom.breadcrumb.appendChild(sep);

    const btn = document.createElement('button');
    btn.className = 'breadcrumb-item';
    btn.textContent = part;

    const segPrefix = parts.slice(0, idx + 1).join('/') + '/';
    if (idx === parts.length - 1) {
      btn.classList.add('current');
    } else {
      btn.addEventListener('click', () => loadFiles(segPrefix));
    }
    dom.breadcrumb.appendChild(btn);
  });
}

// ─── 多选与工具栏联动控制 (核心重构) ───────────────────────────────────────────
function toggleItemSelection(key) {
  if (state.selectedKeys.has(key)) {
    state.selectedKeys.delete(key);
  } else {
    state.selectedKeys.add(key);
  }
  updateSelectionUI();
  updateRowsSelectionClass();
}

function updateSelectionUI() {
  const totalItems = state.folders.length + state.files.length;
  const count = state.selectedKeys.size;
  const hasSelection = count > 0;

  // 更新表头全选框状态
  if (dom.selectAllCheckbox) {
    dom.selectAllCheckbox.checked = totalItems > 0 && count === totalItems;
    dom.selectAllCheckbox.indeterminate = count > 0 && count < totalItems;
  }

  // 1. 下载按钮：必须勾选后才弹出显示
  if (dom.btnBatchDownload) {
    dom.btnBatchDownload.hidden = !hasSelection;
    dom.btnBatchDownload.disabled = !hasSelection;
    dom.textBatchDownload.textContent = count > 1 ? `下载 (${count})` : '下载';
  }

  // 2. 删除按钮：必须勾选后才弹出显示
  if (dom.btnBatchDelete) {
    dom.btnBatchDelete.hidden = !hasSelection;
    dom.btnBatchDelete.disabled = !hasSelection;
    dom.textBatchDelete.textContent = count > 1 ? `删除 (${count})` : '删除';
  }

  // 3. 移动按钮：必须勾选后才弹出显示
  if (dom.btnBatchMove) {
    dom.btnBatchMove.hidden = !hasSelection;
    dom.btnBatchMove.disabled = !hasSelection;
    dom.textBatchMove.textContent = count > 1 ? `移动 (${count})` : '移动';
  }

  // 4. 重命名按钮：仅在勾选 1 项时激活弹出
  if (dom.btnBatchRename) {
    dom.btnBatchRename.hidden = count !== 1;
    dom.btnBatchRename.disabled = count !== 1;
  }
}

function updateRowsSelectionClass() {
  // 更新表格行的高亮状态与复选框勾选态
  document.querySelectorAll('#file-tbody tr[data-key]').forEach(tr => {
    const key = tr.dataset.key;
    const isChecked = state.selectedKeys.has(key);
    tr.classList.toggle('row-selected', isChecked);
    const cb = tr.querySelector('.item-checkbox');
    if (cb) cb.checked = isChecked;
  });

  // 更新网格卡片的高亮状态与复选框勾选态
  document.querySelectorAll('#file-grid .grid-item[data-key]').forEach(card => {
    const key = card.dataset.key;
    const isChecked = state.selectedKeys.has(key);
    card.classList.toggle('card-selected', isChecked);
    const cb = card.querySelector('.item-checkbox');
    if (cb) cb.checked = isChecked;
  });
}

// 表头全选事件监听
dom.selectAllCheckbox?.addEventListener('change', e => {
  const shouldSelectAll = e.target.checked;
  state.selectedKeys.clear();
  if (shouldSelectAll) {
    state.folders.forEach(f => state.selectedKeys.add(f));
    state.files.forEach(f => state.selectedKeys.add(f.key));
  }
  updateSelectionUI();
  updateRowsSelectionClass();
});

// ─── 排序与列表渲染 ────────────────────────────────────────────────────────────
function getSortedItems() {
  const { sortKey, sortDir } = state;

  const sortedFolders = [...state.folders].sort((a, b) => {
    const nameA = getFileName(a).toLowerCase();
    const nameB = getFileName(b).toLowerCase();
    return sortKey === 'name'
      ? (sortDir === 'asc' ? nameA.localeCompare(nameB) : nameB.localeCompare(nameA))
      : 0;
  });

  const sortedFiles = [...state.files].sort((a, b) => {
    if (sortKey === 'name') {
      const na = getFileName(a.key).toLowerCase();
      const nb = getFileName(b.key).toLowerCase();
      return sortDir === 'asc' ? na.localeCompare(nb) : nb.localeCompare(na);
    }
    if (sortKey === 'size') {
      return sortDir === 'asc' ? a.size - b.size : b.size - a.size;
    }
    if (sortKey === 'date') {
      const da = a.uploaded ? new Date(a.uploaded) : 0;
      const db = b.uploaded ? new Date(b.uploaded) : 0;
      return sortDir === 'asc' ? da - db : db - da;
    }
    return 0;
  });

  return { sortedFolders, sortedFiles };
}

function renderFileList() {
  const { sortedFolders, sortedFiles } = getSortedItems();
  const totalCount = sortedFolders.length + sortedFiles.length;

  if (totalCount > 0) {
    const parts = [];
    if (sortedFolders.length > 0) parts.push(`${sortedFolders.length} 文件夹`);
    if (sortedFiles.length > 0) parts.push(`${sortedFiles.length} 文件`);
    let text = parts.join(' · ');
    const currentFilesSize = sortedFiles.reduce((acc, f) => acc + (f.size || 0), 0);
    if (currentFilesSize > 0) {
      text += ` (${formatSize(currentFilesSize)})`;
    }
    dom.fileCount.textContent = text;
  } else {
    dom.fileCount.textContent = '';
  }

  if (state.viewMode === 'list') {
    renderListView(sortedFolders, sortedFiles);
  } else {
    renderGridView(sortedFolders, sortedFiles);
  }
  updateSelectionUI();
}

/** 列表视图渲染 (左侧复选框 · 取消右侧操作列 · 点击整行直达预览) */
function renderListView(folders, files) {
  dom.fileTbody.innerHTML = '';
  const isEmpty = folders.length === 0 && files.length === 0;
  dom.emptyHint.hidden = !isEmpty || state.loading;

  // 渲染文件夹行
  folders.forEach(folderPrefix => {
    const name = getFileName(folderPrefix) || folderPrefix;
    const isSelected = state.selectedKeys.has(folderPrefix);

    const tr = document.createElement('tr');
    tr.dataset.key = folderPrefix;
    if (isSelected) tr.classList.add('row-selected');

    tr.innerHTML = `
      <td class="col-checkbox">
        <input type="checkbox" class="custom-checkbox item-checkbox" data-key="${escapeHtml(folderPrefix)}" ${isSelected ? 'checked' : ''} aria-label="选择文件夹" />
      </td>
      <td class="col-name">
        <div class="file-name-cell">
          <div class="file-icon-box">
            ${renderSvgIcon('folder', 20)}
          </div>
          <div class="file-name-info">
            <span class="file-name-text folder" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
            <span class="file-meta-sub">文件夹</span>
          </div>
        </div>
      </td>
      <td class="col-size">—</td>
      <td class="col-date">—</td>`;

    // 勾选框事件（阻断行点击）
    const cb = tr.querySelector('.item-checkbox');
    cb.addEventListener('click', e => {
      e.stopPropagation();
      toggleItemSelection(folderPrefix);
    });

    // 点击行直达进入文件夹
    tr.addEventListener('click', e => {
      if (e.target.closest('.item-checkbox')) return;
      loadFiles(folderPrefix);
    });

    dom.fileTbody.appendChild(tr);
  });

  // 渲染文件行
  files.forEach(file => {
    const name = getFileName(file.key);
    const type = getFileType(file.key);
    const isSelected = state.selectedKeys.has(file.key);

    const tr = document.createElement('tr');
    tr.dataset.key = file.key;
    if (isSelected) tr.classList.add('row-selected');

    tr.innerHTML = `
      <td class="col-checkbox">
        <input type="checkbox" class="custom-checkbox item-checkbox" data-key="${escapeHtml(file.key)}" ${isSelected ? 'checked' : ''} aria-label="选择文件" />
      </td>
      <td class="col-name">
        <div class="file-name-cell">
          <div class="file-icon-box">
            ${renderSvgIcon(type, 20)}
          </div>
          <div class="file-name-info">
            <span class="file-name-text" title="${escapeHtml(file.key)}">${escapeHtml(name)}</span>
            <span class="file-meta-sub">${formatSize(file.size)} · ${formatDate(file.uploaded)}</span>
          </div>
        </div>
      </td>
      <td class="col-size">${formatSize(file.size)}</td>
      <td class="col-date">${formatDate(file.uploaded)}</td>`;

    // 勾选框事件（阻断行点击）
    const cb = tr.querySelector('.item-checkbox');
    cb.addEventListener('click', e => {
      e.stopPropagation();
      toggleItemSelection(file.key);
    });

    // 点击行直接唤起文件预览
    tr.addEventListener('click', e => {
      if (e.target.closest('.item-checkbox')) return;
      openPreview(file);
    });

    dom.fileTbody.appendChild(tr);
  });

  // 更新表头排序样式
  document.querySelectorAll('.file-table th[data-sort]').forEach(th => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.sort === state.sortKey) {
      th.classList.add(state.sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
    }
  });
}

/** 网格视图渲染 (卡片左上角复选框 · 点击卡片直达预览) */
function renderGridView(folders, files) {
  dom.fileGrid.innerHTML = '';
  const isEmpty = folders.length === 0 && files.length === 0;
  dom.emptyHintGrid.hidden = !isEmpty || state.loading;

  // 文件夹
  folders.forEach(folderPrefix => {
    const name = getFileName(folderPrefix) || folderPrefix;
    const isSelected = state.selectedKeys.has(folderPrefix);

    const item = document.createElement('div');
    item.className = 'grid-item';
    item.dataset.key = folderPrefix;
    if (isSelected) item.classList.add('card-selected');

    item.innerHTML = `
      <input type="checkbox" class="custom-checkbox grid-item-checkbox item-checkbox" data-key="${escapeHtml(folderPrefix)}" ${isSelected ? 'checked' : ''} />
      <div class="grid-icon-box">
        ${renderSvgIcon('folder', 32)}
      </div>
      <span class="grid-item-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
      <span class="grid-item-sub">文件夹</span>`;

    item.querySelector('.item-checkbox').addEventListener('click', e => {
      e.stopPropagation();
      toggleItemSelection(folderPrefix);
    });

    item.addEventListener('click', e => {
      if (e.target.closest('.item-checkbox')) return;
      loadFiles(folderPrefix);
    });

    dom.fileGrid.appendChild(item);
  });

  // 文件
  files.forEach(file => {
    const name = getFileName(file.key);
    const type = getFileType(file.key);
    const isSelected = state.selectedKeys.has(file.key);

    const item = document.createElement('div');
    item.className = 'grid-item';
    item.dataset.key = file.key;
    if (isSelected) item.classList.add('card-selected');

    item.innerHTML = `
      <input type="checkbox" class="custom-checkbox grid-item-checkbox item-checkbox" data-key="${escapeHtml(file.key)}" ${isSelected ? 'checked' : ''} />
      <div class="grid-icon-box">
        ${renderSvgIcon(type, 32)}
      </div>
      <span class="grid-item-name" title="${escapeHtml(file.key)}">${escapeHtml(name)}</span>
      <span class="grid-item-sub">${formatSize(file.size)}</span>`;

    item.querySelector('.item-checkbox').addEventListener('click', e => {
      e.stopPropagation();
      toggleItemSelection(file.key);
    });

    item.addEventListener('click', e => {
      if (e.target.closest('.item-checkbox')) return;
      openPreview(file);
    });

    dom.fileGrid.appendChild(item);
  });
}

// ─── 视图切换 ──────────────────────────────────────────────────────────────────
function applyViewMode() {
  const isList = state.viewMode === 'list';
  dom.fileListView.hidden = !isList;
  dom.fileGridView.hidden = isList;
  dom.btnViewList.classList.toggle('active', isList);
  dom.btnViewGrid.classList.toggle('active', !isList);
}

dom.btnViewList.addEventListener('click', () => {
  state.viewMode = 'list';
  localStorage.setItem('view_mode', 'list');
  applyViewMode();
  renderFileList();
});

dom.btnViewGrid.addEventListener('click', () => {
  state.viewMode = 'grid';
  localStorage.setItem('view_mode', 'grid');
  applyViewMode();
  renderFileList();
});

// ─── 表头排序 ──────────────────────────────────────────────────────────────────
document.querySelectorAll('.file-table th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortKey = key;
      state.sortDir = 'asc';
    }
    renderFileList();
  });
});

let lastRefreshTime = 0;
dom.btnRefresh.addEventListener('click', () => {
  const now = Date.now();
  if (now - lastRefreshTime < 1500) {
    showToast('操作过于频繁，请稍候再刷新', 'warning');
    return;
  }
  lastRefreshTime = now;
  clearDirCache();
  loadFiles(state.currentPrefix, true);
});

// ─── 新建文件夹 ────────────────────────────────────────────────────────────────
function openMkdirModal() {
  dom.mkdirInput.value = '';
  dom.mkdirError.hidden = true;
  dom.mkdirModal.hidden = false;
  setTimeout(() => dom.mkdirInput.focus(), 80);
}

dom.btnMkdir.addEventListener('click', openMkdirModal);

dom.btnMkdirCancel.addEventListener('click', () => {
  dom.mkdirModal.hidden = true;
});

dom.mkdirForm.addEventListener('submit', async e => {
  e.preventDefault();
  const name = dom.mkdirInput.value.trim();
  if (!name || name.includes('/') || name.includes('\\')) {
    dom.mkdirError.textContent = '文件夹名称不能包含 / 或 \\';
    dom.mkdirError.hidden = false;
    return;
  }

  const key = state.currentPrefix + name + '/';
  dom.mkdirError.hidden = true;

  try {
    const res = await apiFetch(`${API.file}?key=${encodeURIComponent(key)}&action=mkdir`, {
      method: 'PUT',
    });
    if (res.ok) {
      dom.mkdirModal.hidden = true;
      showToast('文件夹创建成功', 'success');
      // 乐观更新：推入本地状态与缓存并重绘，省去 1 次 R2.list Class A 消耗！
      optimisticAddFolder(key);
    } else {
      const data = await res.json().catch(() => ({}));
      dom.mkdirError.textContent = data.error || '创建失败';
      dom.mkdirError.hidden = false;
    }
  } catch (err) {
    dom.mkdirError.textContent = '网络错误：' + err.message;
    dom.mkdirError.hidden = false;
  }
});

// ─── 工具栏集中操作：批量下载 & 批量删除 (原子批量接口，省 98% 请求) ─────────────
dom.btnBatchDownload?.addEventListener('click', () => {
  if (state.selectedKeys.size === 0) return;

  // 筛选出选中的文件（文件夹不支持打包下载）
  const filesToDownload = state.files.filter(f => state.selectedKeys.has(f.key));
  if (filesToDownload.length === 0) {
    showToast('选中的项目中没有可下载的文件（文件夹不支持直接下载）', 'warning');
    return;
  }

  showToast(`正在开始下载 ${filesToDownload.length} 个文件...`, 'info');
  filesToDownload.forEach((f, index) => {
    // 间隔微延迟避免浏览器阻止多弹窗下载
    setTimeout(() => {
      downloadFile(f.key);
    }, index * 200);
  });
});

dom.btnBatchDelete?.addEventListener('click', async () => {
  const count = state.selectedKeys.size;
  if (count === 0) return;

  const confirmed = await showConfirm(
    '确认批量删除',
    `确定要删除已选中的 ${count} 个项目吗？注意：非空文件夹无法删除。此操作无法撤销。`
  );
  if (!confirmed) return;

  const keysToDelete = Array.from(state.selectedKeys);
  showToast(`正在批量删除 ${keysToDelete.length} 个项目...`, 'info');

  try {
    // 单次原子批量请求，彻底替代原先多次循环请求
    const res = await apiFetch(`${API.file}?action=batchDelete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: keysToDelete }),
    });

    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      showToast(`成功批量删除 ${data.deletedCount || keysToDelete.length} 个项目`, 'success');
      // 乐观更新：从本地与缓存剔除被删项目，无需发起额外的 /api/files 请求！
      optimisticRemoveItems(keysToDelete);
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || '批量删除失败', 'error');
    }
  } catch (err) {
    showToast('批量删除异常：' + err.message, 'error');
  }
});

// ─── 文件下载工具 ──────────────────────────────────────────────────────────────
function downloadFile(key) {
  const url = buildDownloadUrl(key);
  const a = document.createElement('a');
  a.href = url;
  a.download = getFileName(key);
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ─── 多格式全端高清预览引擎 ──────────────────────────────────────────────────
let currentPdfCleanup = null;

async function renderPdfPreview(file, mediaUrl) {
  dom.previewBody.innerHTML = `
    <div class="preview-loading-tip">
      <div class="spinner-modern"></div>
      <p>正在载入 PDF 高清引擎...</p>
    </div>`;

  try {
    await loadScript('/vendor/pdfjs/pdf.min.js');
    if (window.pdfjsLib) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
    }

    const res = await apiFetch(mediaUrl);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.arrayBuffer();

    const loadingTask = window.pdfjsLib.getDocument({ data });
    const pdfDoc = await loadingTask.promise;

    let currentPageNum = 1;
    const totalPages = pdfDoc.numPages;
    let currentScale = 1.25;
    let isRendering = false;
    let pendingPageNum = null;

    dom.previewBody.innerHTML = `
      <div class="preview-pdf-container">
        <div class="pdf-canvas-wrap" id="pdf-canvas-wrap">
          <canvas id="pdf-canvas"></canvas>
        </div>
        <div class="pdf-controls-pill">
          <button class="btn-icon" id="btn-pdf-prev" title="上一页" ${currentPageNum <= 1 ? 'disabled' : ''}>◀</button>
          <span class="pdf-page-indicator" id="pdf-page-indicator">${currentPageNum} / ${totalPages}</span>
          <button class="btn-icon" id="btn-pdf-next" title="下一页" ${currentPageNum >= totalPages ? 'disabled' : ''}>▶</button>
          <div class="pdf-divider"></div>
          <button class="btn-icon" id="btn-pdf-zoom-out" title="缩小">-</button>
          <button class="btn-icon" id="btn-pdf-fit" title="自适应宽度" style="font-size:11px;width:auto;padding:0 6px">适应</button>
          <button class="btn-icon" id="btn-pdf-zoom-in" title="放大">+</button>
        </div>
      </div>`;

    const canvas = dom.previewBody.querySelector('#pdf-canvas');
    const ctx = canvas.getContext('2d');
    const wrap = dom.previewBody.querySelector('#pdf-canvas-wrap');
    const indicator = dom.previewBody.querySelector('#pdf-page-indicator');
    const btnPrev = dom.previewBody.querySelector('#btn-pdf-prev');
    const btnNext = dom.previewBody.querySelector('#btn-pdf-next');
    const btnZoomOut = dom.previewBody.querySelector('#btn-pdf-zoom-out');
    const btnZoomIn = dom.previewBody.querySelector('#btn-pdf-zoom-in');
    const btnFit = dom.previewBody.querySelector('#btn-pdf-fit');

    async function renderPage(num) {
      isRendering = true;
      const page = await pdfDoc.getPage(num);
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: currentScale });

      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = Math.floor(viewport.width) + 'px';
      canvas.style.height = Math.floor(viewport.height) + 'px';

      const renderContext = {
        canvasContext: ctx,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
        viewport,
      };

      await page.render(renderContext).promise;
      isRendering = false;

      if (pendingPageNum !== null) {
        const next = pendingPageNum;
        pendingPageNum = null;
        renderPage(next);
      }

      indicator.textContent = `${num} / ${totalPages}`;
      btnPrev.disabled = num <= 1;
      btnNext.disabled = num >= totalPages;
    }

    function queueRenderPage(num) {
      if (isRendering) {
        pendingPageNum = num;
      } else {
        renderPage(num);
      }
    }

    btnPrev.addEventListener('click', () => {
      if (currentPageNum <= 1) return;
      currentPageNum--;
      queueRenderPage(currentPageNum);
    });

    btnNext.addEventListener('click', () => {
      if (currentPageNum >= totalPages) return;
      currentPageNum++;
      queueRenderPage(currentPageNum);
    });

    btnZoomIn.addEventListener('click', () => {
      if (currentScale >= 3.0) return;
      currentScale += 0.25;
      queueRenderPage(currentPageNum);
    });

    btnZoomOut.addEventListener('click', () => {
      if (currentScale <= 0.5) return;
      currentScale = Math.max(0.5, currentScale - 0.25);
      queueRenderPage(currentPageNum);
    });

    btnFit.addEventListener('click', async () => {
      const page = await pdfDoc.getPage(currentPageNum);
      const vp = page.getViewport({ scale: 1 });
      const wrapWidth = wrap.clientWidth - 48;
      if (wrapWidth > 0 && vp.width > 0) {
        currentScale = Math.max(0.4, wrapWidth / vp.width);
        queueRenderPage(currentPageNum);
      }
    });

    const onKeydown = e => {
      if (dom.previewModal.hidden) return;
      if (e.key === 'ArrowLeft') {
        if (currentPageNum > 1) { currentPageNum--; queueRenderPage(currentPageNum); }
      } else if (e.key === 'ArrowRight') {
        if (currentPageNum < totalPages) { currentPageNum++; queueRenderPage(currentPageNum); }
      }
    };
    window.addEventListener('keydown', onKeydown);

    currentPdfCleanup = () => {
      window.removeEventListener('keydown', onKeydown);
    };

    renderPage(currentPageNum);

  } catch (err) {
    console.error('PDF.js render error:', err);
    dom.previewBody.innerHTML = '';
    const iframe = document.createElement('iframe');
    iframe.className = 'preview-pdf';
    iframe.src = mediaUrl;
    iframe.title = file.key;
    dom.previewBody.appendChild(iframe);
  }
}

async function renderDocxPreview(file, mediaUrl) {
  dom.previewBody.innerHTML = `
    <div class="preview-loading-tip">
      <div class="spinner-modern"></div>
      <p>正在解析 Word 高保真文档...</p>
    </div>`;

  try {
    await loadScript('/vendor/jszip.min.js');
    await loadScript('/vendor/docx-preview.min.js');

    const res = await apiFetch(mediaUrl);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();

    const wrap = document.createElement('div');
    wrap.className = 'preview-docx-wrap';
    dom.previewBody.innerHTML = '';
    dom.previewBody.appendChild(wrap);

    await window.docx.renderAsync(blob, wrap, null, {
      className: 'docx',
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: false,
      breakPages: true,
    });
  } catch (err) {
    dom.previewBody.innerHTML = `
      <div style="text-align:center;padding:48px 20px;color:#86868b">
        <div style="margin-bottom:16px">${renderSvgIcon('word', 56)}</div>
        <p style="font-size:15px;color:#ff3b30;margin-bottom:8px">Word 文档解析失败</p>
        <p style="font-size:13px;margin-bottom:20px">${escapeHtml(err.message)}</p>
        <button class="btn btn-primary" id="btn-modal-dl">⬇️ 立即下载该文件查看</button>
      </div>`;
    dom.previewBody.querySelector('#btn-modal-dl')?.addEventListener('click', () => downloadFile(file.key));
  }
}

async function renderHeicPreview(file, mediaUrl) {
  if (heicPreviewCache.has(file.key)) {
    const img = document.createElement('img');
    img.alt = getFileName(file.key);
    img.src = heicPreviewCache.get(file.key);
    dom.previewBody.innerHTML = '';
    dom.previewBody.appendChild(img);
    return;
  }

  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  if (isSafari) {
    const img = document.createElement('img');
    img.alt = getFileName(file.key);
    img.src = mediaUrl;
    img.style.opacity = '0';
    img.style.transition = 'opacity 0.25s ease';
    img.onload = () => { img.style.opacity = '1'; };
    dom.previewBody.innerHTML = '';
    dom.previewBody.appendChild(img);
    return;
  }

  dom.previewBody.innerHTML = `
    <div class="preview-loading-tip">
      <div class="spinner-modern"></div>
      <p>正在解码 HEIC 高清图像...</p>
    </div>`;

  try {
    await loadScript('/vendor/heic2any.min.js');
    const res = await apiFetch(mediaUrl);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();

    const conversionResult = await window.heic2any({
      blob,
      toType: 'image/jpeg',
      quality: 0.85,
    });
    const resultBlob = Array.isArray(conversionResult) ? conversionResult[0] : conversionResult;
    const objectUrl = URL.createObjectURL(resultBlob);
    heicPreviewCache.set(file.key, objectUrl);

    const img = document.createElement('img');
    img.alt = getFileName(file.key);
    img.src = objectUrl;
    img.style.opacity = '0';
    img.style.transition = 'opacity 0.25s ease';
    img.onload = () => { img.style.opacity = '1'; };

    dom.previewBody.innerHTML = '';
    dom.previewBody.appendChild(img);
  } catch (err) {
    dom.previewBody.innerHTML = `
      <div style="text-align:center;padding:48px 20px;color:#86868b">
        <div style="margin-bottom:16px">${renderSvgIcon('image', 56)}</div>
        <p style="font-size:15px;color:#ff3b30;margin-bottom:8px">HEIC 图像解码失败</p>
        <p style="font-size:13px;margin-bottom:20px">${escapeHtml(err.message)}</p>
        <button class="btn btn-primary" id="btn-modal-dl">⬇️ 立即下载该文件</button>
      </div>`;
    dom.previewBody.querySelector('#btn-modal-dl')?.addEventListener('click', () => downloadFile(file.key));
  }
}

async function renderExcelPreview(file, mediaUrl) {
  dom.previewBody.innerHTML = `
    <div class="preview-loading-tip">
      <div class="spinner-modern"></div>
      <p>正在解析 Excel 表格数据...</p>
    </div>`;

  try {
    await loadScript('/vendor/xlsx.full.min.js');

    let buffer = xlsxPreviewCache.get(file.key);
    if (!buffer) {
      const res = await apiFetch(mediaUrl);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      buffer = await res.arrayBuffer();
      xlsxPreviewCache.set(file.key, buffer);
    }

    const workbook = window.XLSX.read(buffer, { type: 'array' });
    const sheetNames = workbook.SheetNames || [];
    if (sheetNames.length === 0) throw new Error('工作簿中无有效表格');

    dom.previewBody.innerHTML = `
      <div class="preview-xlsx-wrap">
        <div class="xlsx-sheet-tabs" id="xlsx-sheet-tabs"></div>
        <div class="xlsx-table-container" id="xlsx-table-container"></div>
        <div class="xlsx-table-footer" id="xlsx-table-footer"></div>
      </div>`;

    const tabsWrap = dom.previewBody.querySelector('#xlsx-sheet-tabs');
    const tableWrap = dom.previewBody.querySelector('#xlsx-table-container');
    const footerWrap = dom.previewBody.querySelector('#xlsx-table-footer');

    function showSheet(name) {
      tabsWrap.querySelectorAll('.xlsx-sheet-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.name === name);
      });

      const worksheet = workbook.Sheets[name];
      if (!worksheet) {
        tableWrap.innerHTML = '<div style="padding:20px;color:#86868b">该工作表为空</div>';
        footerWrap.textContent = '';
        return;
      }

      const data = window.XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
      const maxRows = 500;
      const displayRows = data.slice(0, maxRows);

      let html = '<table class="xlsx-table"><tbody>';
      displayRows.forEach((row, rIdx) => {
        html += '<tr>';
        const isHeader = rIdx === 0;
        row.forEach(cell => {
          const tag = isHeader ? 'th' : 'td';
          html += `<${tag}>${escapeHtml(String(cell != null ? cell : ''))}</${tag}>`;
        });
        html += '</tr>';
      });
      html += '</tbody></table>';

      tableWrap.innerHTML = html;
      footerWrap.textContent = data.length > maxRows
        ? `当前展示前 ${maxRows} 行（共 ${data.length} 行），如需完整编辑请下载文件`
        : `共 ${data.length} 行`;
    }

    sheetNames.forEach((sName, idx) => {
      const tab = document.createElement('button');
      tab.className = `xlsx-sheet-tab ${idx === 0 ? 'active' : ''}`;
      tab.textContent = sName;
      tab.dataset.name = sName;
      tab.addEventListener('click', () => showSheet(sName));
      tabsWrap.appendChild(tab);
    });

    showSheet(sheetNames[0]);

  } catch (err) {
    dom.previewBody.innerHTML = `
      <div style="text-align:center;padding:48px 20px;color:#86868b">
        <div style="margin-bottom:16px">${renderSvgIcon('excel', 56)}</div>
        <p style="font-size:15px;color:#ff3b30;margin-bottom:8px">Excel 表格解析失败</p>
        <p style="font-size:13px;margin-bottom:20px">${escapeHtml(err.message)}</p>
        <button class="btn btn-primary" id="btn-modal-dl">⬇️ 立即下载该文件</button>
      </div>`;
    dom.previewBody.querySelector('#btn-modal-dl')?.addEventListener('click', () => downloadFile(file.key));
  }
}

async function renderZipPreview(file, mediaUrl) {
  dom.previewBody.innerHTML = `
    <div class="preview-loading-tip">
      <div class="spinner-modern"></div>
      <p>正在读取压缩包目录树...</p>
    </div>`;

  try {
    await loadScript('/vendor/jszip.min.js');
    const res = await apiFetch(mediaUrl);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();

    const zip = await window.JSZip.loadAsync(blob);
    const entries = [];
    let totalUncompressed = 0;
    let fileCount = 0;
    let folderCount = 0;

    zip.forEach((relPath, entry) => {
      const isDir = entry.dir || relPath.endsWith('/');
      const size = entry._data ? (entry._data.uncompressedSize || 0) : 0;
      if (isDir) {
        folderCount++;
      } else {
        fileCount++;
        totalUncompressed += size;
      }
      entries.push({
        path: relPath,
        isDir,
        size,
        date: entry.date,
      });
    });

    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.path.localeCompare(b.path);
    });

    dom.previewBody.innerHTML = `
      <div class="preview-zip-wrap">
        <div class="zip-summary-header">
          <span class="zip-summary-badge">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 8v13H3V8"/>
              <path d="M1 3h22v5H1z"/>
              <path d="M10 12h4"/>
            </svg>
            包含 ${fileCount} 个文件，${folderCount} 个目录 · 解压约 ${formatSize(totalUncompressed)}
          </span>
          <button class="btn btn-secondary btn-xs" id="btn-zip-dl">下载整包</button>
        </div>
        <div class="zip-list-container" id="zip-list-container"></div>
      </div>`;

    dom.previewBody.querySelector('#btn-zip-dl')?.addEventListener('click', () => downloadFile(file.key));

    const listWrap = dom.previewBody.querySelector('#zip-list-container');
    let listHtml = '';
    entries.forEach(e => {
      const icon = e.isDir ? renderSvgIcon('folder', 16) : renderSvgIcon(getFileType(e.path), 16);
      const sizeText = e.isDir ? '文件夹' : formatSize(e.size);
      const dateText = e.date ? formatDate(e.date.toISOString()) : '';
      listHtml += `
        <div class="zip-entry-row">
          <div class="zip-entry-left">
            ${icon}
            <span title="${escapeHtml(e.path)}">${escapeHtml(e.path)}</span>
          </div>
          <div class="zip-entry-meta">
            <span>${sizeText}</span>
            ${dateText ? `<span style="margin-left:12px">${dateText}</span>` : ''}
          </div>
        </div>`;
    });
    listWrap.innerHTML = listHtml;

  } catch (err) {
    dom.previewBody.innerHTML = `
      <div style="text-align:center;padding:48px 20px;color:#86868b">
        <div style="margin-bottom:16px">${renderSvgIcon('zip', 56)}</div>
        <p style="font-size:15px;color:#ff3b30;margin-bottom:8px">压缩包解析失败</p>
        <p style="font-size:13px;margin-bottom:20px">${escapeHtml(err.message)}</p>
        <button class="btn btn-primary" id="btn-modal-dl">⬇️ 立即下载该文件</button>
      </div>`;
    dom.previewBody.querySelector('#btn-modal-dl')?.addEventListener('click', () => downloadFile(file.key));
  }
}

// ─── 文件在线预览 Modal (支持全端多格式解析) ──────────────────────────────────
async function openPreview(file) {
  state.previewItem = file;
  const name = getFileName(file.key);
  const type = getFileType(file.key);
  const ext = getExt(file.key);

  dom.previewIcon.innerHTML = renderSvgIcon(type, 26);
  dom.previewFilename.textContent = name;
  dom.previewMeta.textContent = `${formatSize(file.size)}${file.uploaded ? ' · ' + formatDate(file.uploaded) : ''}`;
  dom.previewBody.innerHTML = '';

  dom.previewModal.hidden = false;
  document.body.style.overflow = 'hidden';

  const mediaUrl = buildMediaUrl(file.key);

  if (ext === 'heic' || ext === 'heif') {
    await renderHeicPreview(file, mediaUrl);

  } else if (type === 'image') {
    const img = document.createElement('img');
    img.alt = name;
    img.src = mediaUrl;
    img.style.opacity = '0';
    img.style.transition = 'opacity 0.25s ease';
    img.onload = () => { img.style.opacity = '1'; };
    dom.previewBody.appendChild(img);

  } else if (type === 'video') {
    const video = document.createElement('video');
    video.controls = true;
    video.autoplay = false;
    video.preload = 'metadata';
    video.src = mediaUrl;
    dom.previewBody.appendChild(video);

  } else if (type === 'audio') {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:40px;color:#fff;';
    wrap.innerHTML = `${renderSvgIcon('audio', 64)}<p style="font-size:15px;font-weight:600">${escapeHtml(name)}</p>`;
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = mediaUrl;
    audio.style.width = 'min(440px, 90vw)';
    wrap.appendChild(audio);
    dom.previewBody.appendChild(wrap);

  } else if (type === 'text' || type === 'code') {
    if (textPreviewCache.has(file.key)) {
      const wrap = document.createElement('div');
      wrap.className = 'preview-text-wrap';
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = textPreviewCache.get(file.key);
      pre.appendChild(code);
      wrap.appendChild(pre);
      dom.previewBody.innerHTML = '';
      dom.previewBody.appendChild(wrap);
    } else {
      dom.previewBody.innerHTML = '<div style="color:#86868b;padding:24px">正在加载文本内容...</div>';
      try {
        const res = await apiFetch(mediaUrl);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text();
        textPreviewCache.set(file.key, text);
        const wrap = document.createElement('div');
        wrap.className = 'preview-text-wrap';
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = text;
        pre.appendChild(code);
        wrap.appendChild(pre);
        dom.previewBody.innerHTML = '';
        dom.previewBody.appendChild(wrap);
      } catch (err) {
        dom.previewBody.innerHTML = `<div style="color:#ff3b30;padding:24px">加载失败：${escapeHtml(err.message)}</div>`;
      }
    }

  } else if (type === 'pdf') {
    await renderPdfPreview(file, mediaUrl);

  } else if (type === 'word') {
    if (ext === 'docx') {
      await renderDocxPreview(file, mediaUrl);
    } else {
      dom.previewBody.innerHTML = `
        <div style="text-align:center;padding:48px 20px;color:#86868b">
          <div style="margin-bottom:16px">${renderSvgIcon('word', 56)}</div>
          <p style="font-size:16px;color:#e5e5ea;font-weight:600;margin-bottom:8px">旧版 Word (.doc) 格式暂不支持在线直接预览</p>
          <p style="font-size:13px;color:#86868b;margin-bottom:24px">.doc 属于早期复合二进制格式，建议另存为新版 .docx 格式上传预览，或直接下载在本地查看。</p>
          <button class="btn btn-primary" id="btn-modal-dl">⬇️ 立即下载该文件</button>
        </div>`;
      dom.previewBody.querySelector('#btn-modal-dl')?.addEventListener('click', () => downloadFile(file.key));
    }

  } else if (type === 'excel') {
    await renderExcelPreview(file, mediaUrl);

  } else if (type === 'zip') {
    await renderZipPreview(file, mediaUrl);

  } else {
    dom.previewBody.innerHTML = `
      <div style="text-align:center;padding:48px 20px;color:#86868b">
        <div style="margin-bottom:16px">${renderSvgIcon(type, 56)}</div>
        <p style="font-size:15px;color:#e5e5ea;margin-bottom:6px">此文件暂不支持在线直接预览</p>
        <p style="font-size:13px;margin-bottom:20px">${escapeHtml(name)}</p>
        <button class="btn btn-primary" id="btn-modal-dl">⬇️ 立即下载该文件</button>
      </div>`;
    dom.previewBody.querySelector('#btn-modal-dl')?.addEventListener('click', () => downloadFile(file.key));
  }
}

function closePreview() {
  if (currentPdfCleanup) {
    currentPdfCleanup();
    currentPdfCleanup = null;
  }
  dom.previewModal.hidden = true;
  document.body.style.overflow = '';
  dom.previewBody.querySelectorAll('video, audio').forEach(el => {
    el.pause();
    el.src = '';
  });
  dom.previewBody.innerHTML = '';
  state.previewItem = null;
}

dom.btnPreviewClose.addEventListener('click', closePreview);
dom.previewModal.addEventListener('click', e => {
  if (e.target === dom.previewModal) closePreview();
});

dom.btnPreviewDl.addEventListener('click', () => {
  if (state.previewItem) downloadFile(state.previewItem.key);
});

dom.btnPreviewDel.addEventListener('click', async () => {
  if (!state.previewItem) return;
  const key = state.previewItem.key;
  const confirmed = await showConfirm('确认删除', `确定要删除 "${getFileName(key)}" 吗？`);
  if (!confirmed) return;

  try {
    const res = await apiFetch(`${API.file}?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
    if (res.ok) {
      showToast('文件已彻底删除', 'success');
      closePreview();
      // 乐观更新：本地移除已删文件，无需触发额外的 /api/files 请求
      optimisticRemoveItems([key]);
    } else {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || '删除失败', 'error');
    }
  } catch (err) {
    showToast('网络错误：' + err.message, 'error');
  }
});

// ─── 文件与文件夹重命名系统 ──────────────────────────────────────────────────
let currentRenamingKey = null;

function openRenameModal() {
  if (state.selectedKeys.size !== 1) return;
  const key = Array.from(state.selectedKeys)[0];
  currentRenamingKey = key;
  const isFolder = key.endsWith('/');
  const curName = isFolder ? getFileName(key.slice(0, -1)) : getFileName(key);

  dom.renameTitle.textContent = isFolder ? '重命名文件夹' : '重命名文件';
  dom.renameInput.value = curName;
  dom.renameError.hidden = true;
  dom.renameModal.hidden = false;
  document.body.style.overflow = 'hidden';

  setTimeout(() => {
    dom.renameInput.focus();
    if (!isFolder && curName.includes('.')) {
      const dotIdx = curName.lastIndexOf('.');
      dom.renameInput.setSelectionRange(0, dotIdx);
    } else {
      dom.renameInput.select();
    }
  }, 50);
}

function closeRenameModal() {
  dom.renameModal.hidden = true;
  document.body.style.overflow = '';
  currentRenamingKey = null;
  dom.renameError.hidden = true;
}

async function submitRename(e) {
  if (e) e.preventDefault();
  if (!currentRenamingKey) return;

  const key = currentRenamingKey;
  const isFolder = key.endsWith('/');
  const curName = isFolder ? getFileName(key.slice(0, -1)) : getFileName(key);
  const newName = dom.renameInput.value.trim();

  if (!newName) {
    dom.renameError.textContent = '名称不能为空';
    dom.renameError.hidden = false;
    return;
  }
  if (/[/\\:*?"<>|]/.test(newName)) {
    dom.renameError.textContent = '名称不能包含 / \\ : * ? " < > | 等非法字符';
    dom.renameError.hidden = false;
    return;
  }
  if (newName === curName) {
    closeRenameModal();
    return;
  }

  let toKey = '';
  let items = [];
  if (isFolder) {
    const parentPrefix = key.slice(0, key.lastIndexOf('/', key.length - 2) + 1);
    toKey = parentPrefix + newName + '/';

    // 检查当前目录下是否已存在同名文件夹
    if (state.folders.includes(toKey)) {
      dom.renameError.textContent = '当前目录下已存在同名文件夹';
      dom.renameError.hidden = false;
      return;
    }

    if (state.allObjects) {
      items = state.allObjects
        .filter(o => o.key.startsWith(key))
        .map(o => ({ from: o.key, to: toKey + o.key.slice(key.length) }));
    }
    if (items.length === 0) {
      items = [{ from: key, to: toKey }];
    }
  } else {
    const parentPrefix = key.includes('/') ? key.slice(0, key.lastIndexOf('/') + 1) : '';
    toKey = parentPrefix + newName;

    // 检查当前目录下是否已存在同名文件
    if (state.files.some(f => f.key === toKey)) {
      dom.renameError.textContent = '当前目录下已存在同名文件';
      dom.renameError.hidden = false;
      return;
    }

    items = [{ from: key, to: toKey }];
  }

  dom.btnRenameSubmit.disabled = true;
  dom.btnRenameSubmit.textContent = '重命名中...';

  try {
    const res = await apiFetch(`${API.file}?action=move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || '重命名失败');
    }

    optimisticMoveItems([{ from: key, to: toKey, isFolder }]);
    showToast('重命名成功', 'success');
    closeRenameModal();
  } catch (err) {
    dom.renameError.textContent = err.message;
    dom.renameError.hidden = false;
  } finally {
    dom.btnRenameSubmit.disabled = false;
    dom.btnRenameSubmit.textContent = '确认修改';
  }
}

dom.btnBatchRename?.addEventListener('click', openRenameModal);
dom.btnRenameCancel?.addEventListener('click', closeRenameModal);
dom.renameForm?.addEventListener('submit', submitRename);
dom.renameModal?.addEventListener('click', e => {
  if (e.target === dom.renameModal) closeRenameModal();
});

// ─── 文件与文件夹移动系统 ──────────────────────────────────────────────────
let selectedMoveDest = null;

function getAllFolderPaths() {
  const folders = new Set();
  folders.add(''); // 根目录
  if (state.allObjects) {
    for (const obj of state.allObjects) {
      const parts = obj.key.split('/');
      let cur = '';
      const limit = obj.key.endsWith('/') ? parts.length - 1 : parts.length - 1;
      for (let i = 0; i < limit; i++) {
        cur += parts[i] + '/';
        folders.add(cur);
      }
    }
  }
  state.folders.forEach(f => {
    folders.add(f.endsWith('/') ? f : f + '/');
  });
  return Array.from(folders).sort();
}

function openMoveModal() {
  if (state.selectedKeys.size === 0) return;
  const selected = Array.from(state.selectedKeys);
  selectedMoveDest = null;

  dom.moveSubtitle.textContent = `将移动选中的 ${selected.length} 个项目至目标目录`;

  let totalFiles = 0;
  selected.forEach(k => {
    if (k.endsWith('/')) {
      if (state.allObjects) {
        totalFiles += state.allObjects.filter(o => o.key.startsWith(k)).length;
      } else {
        totalFiles += 1;
      }
    } else {
      totalFiles += 1;
    }
  });

  dom.moveQuotaTip.innerHTML = `💡 该操作将移动 ${totalFiles} 个对象（预计物理消耗 ${totalFiles} 次写入额度，额外 List 扫描消耗严格为 0）`;

  const allFolders = getAllFolderPaths();
  let treeHtml = '';

  allFolders.forEach(f => {
    const isRoot = f === '';
    const depth = isRoot ? 0 : f.split('/').filter(Boolean).length;
    const displayName = isRoot ? '根目录 /' : getFileName(f.slice(0, -1));
    const padLeft = 12 + depth * 16;

    const isCurrent = f === state.currentPrefix;
    let isSelfOrChild = false;
    for (const sel of selected) {
      if (sel.endsWith('/') && (f === sel || f.startsWith(sel))) {
        isSelfOrChild = true;
        break;
      }
    }

    const disabled = isCurrent || isSelfOrChild;
    const badge = isCurrent ? ' (当前目录)' : (isSelfOrChild ? ' (不可移入自身)' : '');

    treeHtml += `
      <div class="move-tree-item ${disabled ? 'disabled' : ''}" data-path="${escapeHtml(f)}" style="padding-left:${padLeft}px">
        ${renderSvgIcon('folder', 16)}
        <span>${escapeHtml(displayName)}</span>
        <span style="font-size:12px;color:#86868b;margin-left:4px">${badge}</span>
      </div>`;
  });

  dom.moveFolderTree.innerHTML = treeHtml;
  dom.btnMoveConfirm.disabled = true;
  dom.moveModal.hidden = false;
  document.body.style.overflow = 'hidden';

  dom.moveFolderTree.querySelectorAll('.move-tree-item:not(.disabled)').forEach(el => {
    el.addEventListener('click', () => {
      dom.moveFolderTree.querySelectorAll('.move-tree-item').forEach(i => i.classList.remove('selected'));
      el.classList.add('selected');
      selectedMoveDest = el.dataset.path;
      dom.btnMoveConfirm.disabled = false;
    });
  });
}

function closeMoveModal() {
  dom.moveModal.hidden = true;
  document.body.style.overflow = '';
  selectedMoveDest = null;
}

async function submitMove() {
  if (selectedMoveDest === null || state.selectedKeys.size === 0) return;
  const destPrefix = selectedMoveDest;
  const selected = Array.from(state.selectedKeys);

  const items = [];
  const mappings = [];

  for (const k of selected) {
    const isFolder = k.endsWith('/');
    if (isFolder) {
      const folderName = getFileName(k.slice(0, -1)) + '/';
      const toKey = destPrefix + folderName;
      mappings.push({ from: k, to: toKey, isFolder: true });

      if (state.allObjects) {
        state.allObjects
          .filter(o => o.key.startsWith(k))
          .forEach(o => {
            items.push({ from: o.key, to: toKey + o.key.slice(k.length) });
          });
      }
      if (!items.some(i => i.from === k)) {
        items.push({ from: k, to: toKey });
      }
    } else {
      const fileName = getFileName(k);
      const toKey = destPrefix + fileName;
      mappings.push({ from: k, to: toKey, isFolder: false });
      items.push({ from: k, to: toKey });
    }
  }

  dom.btnMoveConfirm.disabled = true;
  dom.btnMoveConfirm.textContent = '移动中...';

  try {
    const res = await apiFetch(`${API.file}?action=move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || '移动失败');
    }

    optimisticMoveItems(mappings);
    showToast(`成功移动 ${selected.length} 个项目`, 'success');
    closeMoveModal();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    dom.btnMoveConfirm.disabled = false;
    dom.btnMoveConfirm.textContent = '确认移动';
  }
}

dom.btnBatchMove?.addEventListener('click', openMoveModal);
dom.btnMoveCancel?.addEventListener('click', closeMoveModal);
dom.btnMoveConfirm?.addEventListener('click', submitMove);
dom.moveModal?.addEventListener('click', e => {
  if (e.target === dom.moveModal) closeMoveModal();
});

// ─── 文件上传系统 ──────────────────────────────────────────────────────────────
dom.btnUpload.addEventListener('click', () => dom.fileInput.click());

dom.fileInput.addEventListener('change', e => {
  const files = Array.from(e.target.files || []);
  if (files.length) enqueueFiles(files);
  dom.fileInput.value = '';
});

// 拖拽事件监听
let dragCounter = 0;
document.addEventListener('dragenter', e => {
  if (dom.loginModal.hidden === false) return;
  dragCounter++;
  if (e.dataTransfer?.types?.includes('Files')) {
    dom.dropOverlay.hidden = false;
  }
});

document.addEventListener('dragleave', () => {
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    dom.dropOverlay.hidden = true;
  }
});

document.addEventListener('dragover', e => { e.preventDefault(); });
document.addEventListener('drop', e => {
  e.preventDefault();
  dragCounter = 0;
  dom.dropOverlay.hidden = true;
  if (dom.loginModal.hidden === false) return;
  const files = Array.from(e.dataTransfer?.files || []);
  if (files.length) enqueueFiles(files);
});

function enqueueFiles(files) {
  const items = files.map(file => ({
    id:       uid(),
    file,
    name:     file.name,
    size:     file.size,
    status:   'pending',
    progress: 0,
    error:    null,
    abort:    null,
  }));
  state.uploadQueue.push(...items);
  dom.uploadPanel.hidden = false;
  renderUploadPanel();
  processUploadQueue();
}

function cancelUpload(id) {
  const item = state.uploadQueue.find(i => i.id === id);
  if (!item) return;

  if (item.status === 'pending') {
    item.status = 'canceled';
    updateUploadItemUI(item);
    showToast(`已取消 ${item.name} 的上传`, 'info');
    processUploadQueue();
    return;
  }

  if (item.status === 'uploading') {
    item.status = 'canceled';
    if (typeof item.abort === 'function') {
      try { item.abort(); } catch (_) {}
    }
    updateUploadItemUI(item);
    showToast(`已取消 ${item.name} 的上传`, 'info');
    processUploadQueue();
  }
}

// 事件委托：监听上传面板中的取消按钮点击
dom.uploadList.addEventListener('click', e => {
  const cancelBtn = e.target.closest('[data-cancel-id]');
  if (cancelBtn) {
    e.stopPropagation();
    cancelUpload(cancelBtn.dataset.cancelId);
  }
});

function renderUploadPanel() {
  dom.uploadList.innerHTML = '';
  state.uploadQueue.forEach(item => {
    const div = document.createElement('div');
    div.className = 'upload-item';
    div.id = `upload-item-${item.id}`;

    const statusText = {
      pending:   '排队中',
      uploading: `${Math.round(item.progress)}%`,
      done:      '已完成',
      error:     `上传失败: ${item.error || '未知错误'}`,
      canceled:  '已取消',
    }[item.status] || '';

    const isCancellable = item.status === 'pending' || item.status === 'uploading';

    div.innerHTML = `
      <div style="flex-shrink:0;width:28px;height:28px;display:flex;align-items:center;justify-content:center">
        ${renderSvgIcon(getFileType(item.name), 22)}
      </div>
      <div class="upload-item-info">
        <div class="upload-item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
        <div class="upload-item-meta">${formatSize(item.size)}</div>
        ${item.status === 'uploading' ? `
          <div class="upload-progress-bar">
            <div class="upload-progress-fill" style="width:${item.progress}%"></div>
          </div>` : ''}
      </div>
      <div class="upload-item-actions">
        <span class="upload-item-status status-${item.status}">${statusText}</span>
        ${isCancellable ? `
          <button type="button" class="btn-cancel-upload" data-cancel-id="${item.id}" title="取消上传" aria-label="取消上传">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>` : ''}
      </div>`;

    dom.uploadList.appendChild(div);
  });
}

function updateUploadItemUI(item) {
  const el = $(`upload-item-${item.id}`);
  if (!el) return;

  const statusText = {
    pending:   '排队中',
    uploading: `${Math.round(item.progress)}%`,
    done:      '已完成',
    error:     `上传失败: ${item.error || '未知错误'}`,
    canceled:  '已取消',
  }[item.status] || '';

  const statusEl = el.querySelector('.upload-item-status');
  if (statusEl) {
    statusEl.textContent = statusText;
    statusEl.className = `upload-item-status status-${item.status}`;
  }

  const cancelBtn = el.querySelector('.btn-cancel-upload');
  const isCancellable = item.status === 'pending' || item.status === 'uploading';
  if (!isCancellable && cancelBtn) {
    cancelBtn.remove();
  }

  const info = el.querySelector('.upload-item-info');
  if (info) {
    let bar = info.querySelector('.upload-progress-bar');
    if (item.status === 'uploading') {
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'upload-progress-bar';
        bar.innerHTML = '<div class="upload-progress-fill"></div>';
        info.appendChild(bar);
      }
      const fill = bar.querySelector('.upload-progress-fill');
      if (fill) fill.style.width = item.progress + '%';
    } else {
      bar?.remove();
    }
  }
}

async function processUploadQueue() {
  const uploadingCount = state.uploadQueue.filter(i => i.status === 'uploading').length;
  if (uploadingCount >= MAX_CONCURRENT_FILES) return;

  const pending = state.uploadQueue.filter(i => i.status === 'pending');
  const toStart = pending.slice(0, MAX_CONCURRENT_FILES - uploadingCount);

  for (const item of toStart) {
    item.status = 'uploading';
    updateUploadItemUI(item);
    uploadFile(item).then(() => {
      processUploadQueue();
    });
  }
}

async function uploadFile(item) {
  if (item.status === 'canceled') return;
  const key = state.currentPrefix + item.name;
  try {
    if (item.size >= MULTIPART_THRESHOLD) {
      await uploadMultipart(item, key);
    } else {
      await uploadSimple(item, key);
    }
    if (item.status === 'canceled') return;
    item.status = 'done';
    item.progress = 100;
    showToast(`${item.name} 上传成功`, 'success');
    // 乐观更新：将新上传的文件直接合入本地列表与缓存，免去额外的 /api/files 列表请求！
    optimisticAddFile(key, item.size, item.file.type);
  } catch (err) {
    if (item.status === 'canceled' || err.name === 'AbortError' || err.message === 'Upload aborted') {
      item.status = 'canceled';
      return;
    }
    item.status = 'error';
    item.error = err.message;
    showToast(`${item.name} 上传失败：${err.message}`, 'error');
  } finally {
    updateUploadItemUI(item);
  }
}

async function uploadSimple(item, key) {
  const contentType = item.file.type || 'application/octet-stream';
  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    item.abort = () => {
      xhr.abort();
    };

    xhr.open('PUT', `${API.file}?key=${encodeURIComponent(key)}`);
    xhr.setRequestHeader('Content-Type', contentType);
    if (state.password) xhr.setRequestHeader('X-Drive-Password', state.password);

    xhr.upload.onprogress = e => {
      if (item.status === 'canceled') return;
      if (e.lengthComputable) {
        item.progress = (e.loaded / e.total) * 100;
        updateUploadItemUI(item);
      }
    };

    xhr.onload = () => {
      if (item.status === 'canceled') return resolve();
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`HTTP ${xhr.status}: ${xhr.responseText}`));
    };
    xhr.onerror = () => {
      if (item.status === 'canceled') return resolve();
      reject(new Error('网络中断，上传失败'));
    };
    xhr.onabort = () => {
      item.status = 'canceled';
      resolve();
    };
    xhr.send(item.file);
  });
}

async function uploadMultipart(item, key) {
  const contentType = item.file.type || 'application/octet-stream';
  const abortController = new AbortController();
  item.abort = () => {
    abortController.abort();
  };

  const createRes = await apiFetch(
    `${API.file}?key=${encodeURIComponent(key)}&action=createMultipart`,
    {
      method: 'POST',
      headers: { 'X-Content-Type': contentType },
      signal: abortController.signal,
    }
  );
  if (!createRes.ok) {
    const d = await createRes.json().catch(() => ({}));
    throw new Error(d.error || '创建分块上传失败');
  }
  const { uploadId } = await createRes.json();

  try {
    const totalChunks = Math.ceil(item.size / CHUNK_SIZE);
    const parts = [];
    let uploadedBytes = 0;

    for (let batchStart = 0; batchStart < totalChunks; batchStart += MAX_CONCURRENT_CHUNKS) {
      if (item.status === 'canceled' || abortController.signal.aborted) {
        throw new Error('Upload aborted');
      }

      const batchEnd = Math.min(batchStart + MAX_CONCURRENT_CHUNKS, totalChunks);
      const batchPromises = [];

      for (let i = batchStart; i < batchEnd; i++) {
        const partNumber = i + 1;
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, item.size);
        const chunk = item.file.slice(start, end);

        batchPromises.push(
          (async () => {
            const res = await apiFetch(
              `${API.file}?key=${encodeURIComponent(key)}&action=uploadPart&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`,
              { method: 'PUT', body: chunk, signal: abortController.signal }
            );
            if (!res.ok) {
              const d = await res.json().catch(() => ({}));
              throw new Error(d.error || `第 ${partNumber} 块上传失败`);
            }
            const data = await res.json();
            uploadedBytes += (end - start);
            if (item.status === 'uploading') {
              item.progress = (uploadedBytes / item.size) * 100;
              updateUploadItemUI(item);
            }
            return { partNumber, etag: data.etag };
          })()
        );
      }

      const batchResults = await Promise.all(batchPromises);
      parts.push(...batchResults);
    }

    if (item.status === 'canceled' || abortController.signal.aborted) {
      throw new Error('Upload aborted');
    }

    parts.sort((a, b) => a.partNumber - b.partNumber);
    const completeRes = await apiFetch(
      `${API.file}?key=${encodeURIComponent(key)}&action=completeMultipart`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId, parts }),
        signal: abortController.signal,
      }
    );
    if (!completeRes.ok) {
      const d = await completeRes.json().catch(() => ({}));
      throw new Error(d.error || '完成分块合并失败');
    }
  } catch (err) {
    // 任何分块上传、合并异常或主动取消，自动中止并清理云端未完成的孤儿分块垃圾
    apiFetch(
      `${API.file}?key=${encodeURIComponent(key)}&action=abortMultipart&uploadId=${encodeURIComponent(uploadId)}`,
      { method: 'DELETE' }
    ).catch(() => {});
    throw err;
  }
}

dom.btnClearDone.addEventListener('click', () => {
  state.uploadQueue = state.uploadQueue.filter(i => i.status !== 'done' && i.status !== 'error' && i.status !== 'canceled');
  if (state.uploadQueue.length === 0) {
    dom.uploadPanel.hidden = true;
  } else {
    renderUploadPanel();
  }
});

dom.btnClosePanel.addEventListener('click', () => {
  dom.uploadPanel.hidden = true;
});

// ─── 键盘快捷键支持 ────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!dom.previewModal.hidden) { closePreview(); return; }
    if (!dom.renameModal.hidden)  { closeRenameModal(); return; }
    if (!dom.moveModal.hidden)    { closeMoveModal(); return; }
    if (!dom.mkdirModal.hidden)   { dom.mkdirModal.hidden = true; return; }
    if (!dom.confirmModal.hidden) { dom.confirmModal.hidden = true; return; }
  }
  if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r' && !e.shiftKey)) {
    if (!dom.app.hidden) {
      e.preventDefault();
      clearDirCache();
      loadFiles(state.currentPrefix, true);
    }
  }
});

// ─── 页面关闭防误触保护 (上传途中提示拦截) ──────────────────────────────────
window.addEventListener('beforeunload', e => {
  const hasActiveUploads = state.uploadQueue.some(i => i.status === 'uploading');
  if (hasActiveUploads) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ─── 启动应用 ──────────────────────────────────────────────────────────────────
initAuth();
