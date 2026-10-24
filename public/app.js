/**
 * app.js — R2 云盘前端核心逻辑 (Apple 现代微质感 · 复选框多选与集中操作版)
 * 纯原生 JavaScript | 零外部依赖 | 毫秒级首屏 | 全矢量 SVG 图标
 */

'use strict';

// ─── 常量与配置 (额度省流优化版) ────────────────────────────────────────────────
const CHUNK_SIZE = 20 * 1024 * 1024;           // 20 MB 分块大小（减少 60% Class A 与 Functions 请求）
const MULTIPART_THRESHOLD = 20 * 1024 * 1024;  // 超过 20MB 启用分块（<=20MB 走高效单次 PUT 直传，节省 66% 开销）
const MAX_CONCURRENT_CHUNKS = 3;               // 最大并发分块数
const MAX_CONCURRENT_FILES = 3;                // 最大并发文件数

// ─── 前端目录短期内存缓存 (SWR: 60 秒免重复请求，零 Class A / Functions 消耗) ────
const dirCache = new Map(); // prefix -> { folders, files, timestamp }
const DIR_CACHE_TTL = 60 * 1000; // 60 秒有效期

function clearDirCache() {
  dirCache.clear();
}

const API = {
  files: '/api/files',
  file:  '/api/file',
};

// 扩展名映射文件类型
const EXT_TYPE_MAP = {
  // 图片
  jpg:'image', jpeg:'image', png:'image', gif:'image', webp:'image',
  svg:'image', bmp:'image', ico:'image', tiff:'image', avif:'image',
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

// 支持直接在线预览的文件类型
const PREVIEW_TYPES = new Set(['image', 'video', 'audio', 'text', 'code', 'pdf']);

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

  btnViewList:        $('btn-view-list'),
  btnViewGrid:        $('btn-view-grid'),
  btnLogout:          $('btn-logout'),

  btnUpload:          $('btn-upload'),
  fileInput:          $('file-input'),
  btnMkdir:           $('btn-mkdir'),
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

  listContainer:      $('list-container'),
  fileListView:       $('file-list-view'),
  fileGridView:       $('file-grid-view'),
  fileTable:          $('file-table'),
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

  toastContainer:     $('toast-container'),
};

// ─── 基础工具函数 ──────────────────────────────────────────────────────────────
function formatSize(bytes) {
  if (bytes == null) return '—';
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

// ─── 鉴权与首屏流 ──────────────────────────────────────────────────────────────
async function tryAuth(password) {
  try {
    const res = await apiFetch(`${API.files}?prefix=`, {
      headers: { 'X-Drive-Password': password },
    });
    return res.status !== 401;
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

function showApp() {
  dom.loginModal.hidden = true;
  dom.app.hidden = false;
  applyViewMode();
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
  state.currentPrefix = '';
  state.files = [];
  state.folders = [];
  state.selectedKeys.clear();
  showLogin();
});

// ─── 文件数据加载 (集成前端 SWR 内存缓存) ──────────────────────────────────────────
async function loadFiles(prefix = '', forceRefresh = false) {
  state.loading = true;
  state.currentPrefix = prefix;
  state.selectedKeys.clear(); // 切换目录时清空勾选
  updateSelectionUI();
  renderBreadcrumb(prefix);

  // 1. 命中短期内存缓存：直接同步秒开，零网络延迟与零额度消耗
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

  try {
    const res = await apiFetch(`${API.files}?prefix=${encodeURIComponent(prefix)}`);
    if (res.status === 401) {
      showLogin();
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || '获取文件列表失败', 'error');
      return;
    }
    const data = await res.json();
    state.folders = data.folders || [];
    state.files = data.files || [];

    // 写入内存缓存
    dirCache.set(prefix, {
      folders: state.folders,
      files: state.files,
      timestamp: Date.now(),
    });

    renderFileList();
  } catch (err) {
    showToast('网络错误：' + err.message, 'error');
  } finally {
    state.loading = false;
    setLoading(false);
  }
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

  // 更新表头全选框状态
  if (dom.selectAllCheckbox) {
    dom.selectAllCheckbox.checked = totalItems > 0 && count === totalItems;
    dom.selectAllCheckbox.indeterminate = count > 0 && count < totalItems;
  }

  // 更新工具栏批量下载按钮
  if (dom.btnBatchDownload) {
    dom.btnBatchDownload.disabled = count === 0;
    dom.textBatchDownload.textContent = count > 0 ? `下载 (${count})` : '下载';
  }

  // 更新工具栏批量删除按钮
  if (dom.btnBatchDelete) {
    dom.btnBatchDelete.disabled = count === 0;
    dom.textBatchDelete.textContent = count > 0 ? `删除 (${count})` : '删除';
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

  dom.fileCount.textContent = totalCount > 0
    ? `${sortedFolders.length} 文件夹 · ${sortedFiles.length} 文件`
    : '';

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

dom.btnRefresh.addEventListener('click', () => {
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
      clearDirCache();
      loadFiles(state.currentPrefix, true);
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
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || '批量删除失败', 'error');
    }
  } catch (err) {
    showToast('批量删除异常：' + err.message, 'error');
  }

  state.selectedKeys.clear();
  clearDirCache();
  loadFiles(state.currentPrefix, true);
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

// ─── 文件在线预览 Modal (支持直接下载与删除) ───────────────────────────────────
async function openPreview(file) {
  state.previewItem = file;
  const name = getFileName(file.key);
  const type = getFileType(file.key);

  dom.previewIcon.innerHTML = renderSvgIcon(type, 26);
  dom.previewFilename.textContent = name;
  dom.previewMeta.textContent = `${formatSize(file.size)}${file.uploaded ? ' · ' + formatDate(file.uploaded) : ''}`;
  dom.previewBody.innerHTML = '';

  dom.previewModal.hidden = false;
  document.body.style.overflow = 'hidden';

  const mediaUrl = buildMediaUrl(file.key);

  if (type === 'image') {
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
    dom.previewBody.innerHTML = '<div style="color:#86868b;padding:24px">正在加载文本内容...</div>';
    try {
      const res = await apiFetch(mediaUrl);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
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

  } else if (type === 'pdf') {
    const iframe = document.createElement('iframe');
    iframe.className = 'preview-pdf';
    iframe.src = mediaUrl;
    iframe.title = name;
    dom.previewBody.appendChild(iframe);

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
      clearDirCache();
      loadFiles(state.currentPrefix, true);
    } else {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || '删除失败', 'error');
    }
  } catch (err) {
    showToast('网络错误：' + err.message, 'error');
  }
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
  }));
  state.uploadQueue.push(...items);
  dom.uploadPanel.hidden = false;
  renderUploadPanel();
  processUploadQueue();
}

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
    }[item.status] || '';

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
      <span class="upload-item-status status-${item.status}">${statusText}</span>`;

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
  }[item.status] || '';

  const statusEl = el.querySelector('.upload-item-status');
  if (statusEl) {
    statusEl.textContent = statusText;
    statusEl.className = `upload-item-status status-${item.status}`;
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
  const key = state.currentPrefix + item.name;
  try {
    if (item.size >= MULTIPART_THRESHOLD) {
      await uploadMultipart(item, key);
    } else {
      await uploadSimple(item, key);
    }
    item.status = 'done';
    item.progress = 100;
    showToast(`${item.name} 上传成功`, 'success');
    clearDirCache();
    loadFiles(state.currentPrefix, true);
  } catch (err) {
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
    xhr.open('PUT', `${API.file}?key=${encodeURIComponent(key)}`);
    xhr.setRequestHeader('Content-Type', contentType);
    if (state.password) xhr.setRequestHeader('X-Drive-Password', state.password);

    xhr.upload.onprogress = e => {
      if (e.lengthComputable) {
        item.progress = (e.loaded / e.total) * 100;
        updateUploadItemUI(item);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`HTTP ${xhr.status}: ${xhr.responseText}`));
    };
    xhr.onerror = () => reject(new Error('网络中断，上传失败'));
    xhr.send(item.file);
  });
}

async function uploadMultipart(item, key) {
  const contentType = item.file.type || 'application/octet-stream';

  const createRes = await apiFetch(
    `${API.file}?key=${encodeURIComponent(key)}&action=createMultipart`,
    {
      method: 'POST',
      headers: { 'X-Content-Type': contentType },
    }
  );
  if (!createRes.ok) {
    const d = await createRes.json().catch(() => ({}));
    throw new Error(d.error || '创建分块上传失败');
  }
  const { uploadId } = await createRes.json();

  const totalChunks = Math.ceil(item.size / CHUNK_SIZE);
  const parts = [];
  let uploadedBytes = 0;

  for (let batchStart = 0; batchStart < totalChunks; batchStart += MAX_CONCURRENT_CHUNKS) {
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
            { method: 'PUT', body: chunk }
          );
          if (!res.ok) {
            const d = await res.json().catch(() => ({}));
            throw new Error(d.error || `第 ${partNumber} 块上传失败`);
          }
          const data = await res.json();
          uploadedBytes += (end - start);
          item.progress = (uploadedBytes / item.size) * 100;
          updateUploadItemUI(item);
          return { partNumber, etag: data.etag };
        })()
      );
    }

    const batchResults = await Promise.all(batchPromises);
    parts.push(...batchResults);
  }

  parts.sort((a, b) => a.partNumber - b.partNumber);
  const completeRes = await apiFetch(
    `${API.file}?key=${encodeURIComponent(key)}&action=completeMultipart`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId, parts }),
    }
  );
  if (!completeRes.ok) {
    const d = await completeRes.json().catch(() => ({}));
    apiFetch(
      `${API.file}?key=${encodeURIComponent(key)}&action=abortMultipart&uploadId=${encodeURIComponent(uploadId)}`,
      { method: 'DELETE' }
    ).catch(() => {});
    throw new Error(d.error || '完成分块合并失败');
  }
}

dom.btnClearDone.addEventListener('click', () => {
  state.uploadQueue = state.uploadQueue.filter(i => i.status !== 'done' && i.status !== 'error');
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
    if (!dom.mkdirModal.hidden)   { dom.mkdirModal.hidden = true; return; }
    if (!dom.confirmModal.hidden) { dom.confirmModal.hidden = true; return; }
  }
  if (e.key === 'F5' || (e.ctrlKey && e.key === 'r')) {
    if (!dom.app.hidden) {
      e.preventDefault();
      clearDirCache();
      loadFiles(state.currentPrefix, true);
    }
  }
});

// ─── 启动应用 ──────────────────────────────────────────────────────────────────
initAuth();
