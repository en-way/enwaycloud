/**
 * app.js — R2 云盘前端核心逻辑
 * 纯原生 JS，无任何框架依赖
 *
 * 功能：
 *  - 密码鉴权（localStorage 缓存）
 *  - 目录浏览与面包屑导航
 *  - 文件列表（列表/网格双视图）、排序
 *  - 多文件并行分块上传（< 5MB 直接 PUT，>= 5MB Multipart Upload）
 *  - 拖拽上传
 *  - 在线预览（图片/视频/音频/文本/PDF）
 *  - 新建文件夹、删除文件（带二次确认）
 *  - Toast 通知
 */

'use strict';

// ─── 常量 ──────────────────────────────────────────────────────────────────────
const CHUNK_SIZE = 8 * 1024 * 1024;        // 8 MB 每块
const MULTIPART_THRESHOLD = 5 * 1024 * 1024; // ≥ 5MB 使用分块上传
const MAX_CONCURRENT_CHUNKS = 3;            // 最大并发分块数
const MAX_CONCURRENT_FILES = 3;             // 最大并发文件数

const API = {
  files: '/api/files',
  file:  '/api/file',
};

// 文件类型 → Emoji 图标
const FILE_ICONS = {
  folder: '📁',
  image:  '🖼️',
  video:  '🎬',
  audio:  '🎵',
  text:   '📄',
  code:   '💻',
  pdf:    '📕',
  zip:    '🗜️',
  excel:  '📊',
  word:   '📝',
  ppt:    '📊',
  default:'📎',
};

// 扩展名 → 文件类型
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

// 可预览的类型
const PREVIEW_TYPES = new Set(['image','video','audio','text','code','pdf']);

// ─── 应用状态 ──────────────────────────────────────────────────────────────────
const state = {
  password:      localStorage.getItem('drive_password') || '',
  currentPrefix: '',
  files:         [],
  folders:       [],
  viewMode:      localStorage.getItem('view_mode') || 'list',
  sortKey:       'name',
  sortDir:       'asc',
  uploadQueue:   [],          // { id, file, name, size, status, progress, error }
  previewItem:   null,
  loading:       false,
};

// ─── DOM 引用 ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const dom = {
  loginModal:      $('login-modal'),
  loginForm:       $('login-form'),
  passwordInput:   $('password-input'),
  togglePassword:  $('toggle-password'),
  eyeIcon:         $('eye-icon'),
  loginError:      $('login-error'),
  loginBtnText:    $('login-btn-text'),
  loginSpinner:    $('login-spinner'),

  app:             $('app'),
  breadcrumb:      $('breadcrumb'),

  btnViewList:     $('btn-view-list'),
  btnViewGrid:     $('btn-view-grid'),
  btnLogout:       $('btn-logout'),
  btnUpload:       $('btn-upload'),
  fileInput:       $('file-input'),
  btnMkdir:        $('btn-mkdir'),
  btnRefresh:      $('btn-refresh'),
  fileCount:       $('file-count'),

  dropOverlay:     $('drop-overlay'),

  uploadPanel:     $('upload-panel'),
  uploadList:      $('upload-list'),
  btnClearDone:    $('btn-clear-done'),
  btnClosePanel:   $('btn-close-panel'),

  listContainer:   $('list-container'),
  fileListView:    $('file-list-view'),
  fileGridView:    $('file-grid-view'),
  fileTbody:       $('file-tbody'),
  fileGrid:        $('file-grid'),
  emptyHint:       $('empty-hint'),
  emptyHintGrid:   $('empty-hint-grid'),
  loadingHint:     $('loading-hint'),

  previewModal:    $('preview-modal'),
  previewIcon:     $('preview-icon'),
  previewFilename: $('preview-filename'),
  previewMeta:     $('preview-meta'),
  previewBody:     $('preview-body'),
  btnPreviewDl:    $('btn-preview-download'),
  btnPreviewDel:   $('btn-preview-delete'),
  btnPreviewClose: $('btn-preview-close'),

  mkdirModal:      $('mkdir-modal'),
  mkdirForm:       $('mkdir-form'),
  mkdirInput:      $('mkdir-input'),
  mkdirError:      $('mkdir-error'),
  btnMkdirCancel:  $('btn-mkdir-cancel'),

  confirmModal:    $('confirm-modal'),
  confirmTitle:    $('confirm-title'),
  confirmMessage:  $('confirm-message'),
  btnConfirmCancel:$('btn-confirm-cancel'),
  btnConfirmOk:    $('btn-confirm-ok'),

  toastContainer:  $('toast-container'),
};

// ─── 工具函数 ──────────────────────────────────────────────────────────────────

/** 格式化文件大小 */
function formatSize(bytes) {
  if (bytes == null) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

/** 格式化日期时间 */
function formatDate(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  return d.toLocaleString('zh-CN', {
    year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit',
  });
}

/** 从 key 获取文件名 */
function getFileName(key) {
  return key.split('/').filter(Boolean).pop() || key;
}

/** 从 key 获取扩展名 */
function getExt(key) {
  const name = getFileName(key);
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

/** 获取文件类型 */
function getFileType(key) {
  return EXT_TYPE_MAP[getExt(key)] || 'default';
}

/** 获取文件图标 Emoji */
function getFileIcon(key, isFolder = false) {
  if (isFolder) return FILE_ICONS.folder;
  return FILE_ICONS[getFileType(key)] || FILE_ICONS.default;
}

/** 生成唯一 ID */
function uid() {
  return Math.random().toString(36).slice(2);
}

/** 构建 API URL（自动附加鉴权 query 参数，用于媒体直链） */
function buildMediaUrl(key) {
  const url = new URL(API.file, location.origin);
  url.searchParams.set('key', key);
  if (state.password) url.searchParams.set('auth', state.password);
  return url.toString();
}

/** 构建下载 URL */
function buildDownloadUrl(key) {
  const url = new URL(API.file, location.origin);
  url.searchParams.set('key', key);
  url.searchParams.set('download', '1');
  if (state.password) url.searchParams.set('auth', state.password);
  return url.toString();
}

/** 统一 API fetch（自动附加鉴权 Header） */
async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.password) {
    headers.set('X-Drive-Password', state.password);
  }
  const res = await fetch(url, { ...options, headers });
  return res;
}

// ─── Toast 通知 ────────────────────────────────────────────────────────────────
function showToast(message, type = 'info', duration = 3000) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const icons = { success:'✅', error:'❌', warning:'⚠️', info:'ℹ️' };
  toast.innerHTML = `<span>${icons[type] || ''}</span><span>${escapeHtml(message)}</span>`;

  dom.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('removing');
    toast.addEventListener('animationend', () => toast.remove());
  }, duration);
}

/** HTML 转义 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

// ─── 确认弹窗 ──────────────────────────────────────────────────────────────────
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

// ─── 登录逻辑 ──────────────────────────────────────────────────────────────────

/** 尝试用当前 state.password 验证 */
async function tryAuth(password) {
  const res = await apiFetch(`${API.files}?prefix=`, {
    headers: { 'X-Drive-Password': password },
  });
  return res.status !== 401;
}

/** 初始化：检查是否已有保存的密码 */
async function initAuth() {
  if (state.password) {
    const ok = await tryAuth(state.password);
    if (ok) {
      showApp();
      return;
    }
    // 密码失效，清除
    state.password = '';
    localStorage.removeItem('drive_password');
  }
  showLogin();
}

function showLogin() {
  dom.loginModal.hidden = false;
  dom.app.hidden = true;
  setTimeout(() => dom.passwordInput.focus(), 100);
}

function showApp() {
  dom.loginModal.hidden = true;
  dom.app.hidden = false;
  applyViewMode();
  loadFiles(state.currentPrefix);
}

// 登录表单提交
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
      dom.loginError.textContent = '密码错误，请重试';
      dom.loginError.hidden = false;
      dom.passwordInput.select();
    }
  } catch (err) {
    dom.loginError.textContent = '网络错误，请检查连接后重试';
    dom.loginError.hidden = false;
  } finally {
    dom.loginBtnText.textContent = '进入云盘';
    dom.loginSpinner.hidden = true;
  }
});

// 显示/隐藏密码
dom.togglePassword.addEventListener('click', () => {
  const isText = dom.passwordInput.type === 'text';
  dom.passwordInput.type = isText ? 'password' : 'text';
  dom.eyeIcon.textContent = isText ? '👁️' : '🙈';
});

// 退出登录
dom.btnLogout.addEventListener('click', () => {
  state.password = '';
  localStorage.removeItem('drive_password');
  state.currentPrefix = '';
  state.files = [];
  state.folders = [];
  showLogin();
});

// ─── 文件列表加载 ──────────────────────────────────────────────────────────────

async function loadFiles(prefix = '') {
  state.loading = true;
  state.currentPrefix = prefix;
  setLoading(true);
  renderBreadcrumb(prefix);

  try {
    const res = await apiFetch(`${API.files}?prefix=${encodeURIComponent(prefix)}`);
    if (res.status === 401) {
      showLogin();
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || '加载文件列表失败', 'error');
      return;
    }
    const data = await res.json();
    state.folders = data.folders || [];
    state.files = data.files || [];
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

// ─── 面包屑渲染 ────────────────────────────────────────────────────────────────

function renderBreadcrumb(prefix) {
  dom.breadcrumb.innerHTML = '';

  // 根目录按钮
  const rootBtn = document.createElement('button');
  rootBtn.className = 'breadcrumb-item root';
  rootBtn.dataset.prefix = '';
  rootBtn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:middle;margin-right:4px">
      <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>
    </svg>根目录`;
  rootBtn.addEventListener('click', () => loadFiles(''));
  dom.breadcrumb.appendChild(rootBtn);

  if (!prefix) {
    rootBtn.classList.add('current');
    return;
  }

  // 拆解路径段
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

// ─── 文件列表渲染 ──────────────────────────────────────────────────────────────

/** 获取排序后的文件夹+文件列表 */
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
    ? `${sortedFolders.length} 个文件夹，${sortedFiles.length} 个文件`
    : '';

  if (state.viewMode === 'list') {
    renderListView(sortedFolders, sortedFiles);
  } else {
    renderGridView(sortedFolders, sortedFiles);
  }
}

/** 列表视图渲染 */
function renderListView(folders, files) {
  dom.fileTbody.innerHTML = '';
  const isEmpty = folders.length === 0 && files.length === 0;
  dom.emptyHint.hidden = !isEmpty || state.loading;

  // 渲染文件夹行
  folders.forEach(folderPrefix => {
    const name = getFileName(folderPrefix) || folderPrefix;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <div class="file-name-cell">
          <span class="file-icon">📁</span>
          <span class="file-name-text folder-name-text" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        </div>
      </td>
      <td class="file-size">—</td>
      <td class="file-date">—</td>
      <td>
        <div class="action-group">
          <button class="btn btn-ghost btn-sm btn-delete-folder" data-key="${escapeHtml(folderPrefix)}" title="删除文件夹">🗑️</button>
        </div>
      </td>`;
    tr.querySelector('.file-name-cell').addEventListener('click', () => loadFiles(folderPrefix));
    tr.querySelector('.btn-delete-folder').addEventListener('click', e => {
      e.stopPropagation();
      handleDeleteFolder(folderPrefix);
    });
    dom.fileTbody.appendChild(tr);
  });

  // 渲染文件行
  files.forEach(file => {
    const name = getFileName(file.key);
    const icon = getFileIcon(file.key);
    const type = getFileType(file.key);
    const canPreview = PREVIEW_TYPES.has(type);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <div class="file-name-cell">
          <span class="file-icon">${icon}</span>
          <span class="file-name-text" title="${escapeHtml(file.key)}">${escapeHtml(name)}</span>
        </div>
      </td>
      <td class="file-size">${formatSize(file.size)}</td>
      <td class="file-date">${formatDate(file.uploaded)}</td>
      <td>
        <div class="action-group">
          ${canPreview ? `<button class="btn btn-ghost btn-sm btn-preview" data-key="${escapeHtml(file.key)}" title="预览">👁️</button>` : ''}
          <button class="btn btn-ghost btn-sm btn-download" data-key="${escapeHtml(file.key)}" title="下载">⬇️</button>
          <button class="btn btn-ghost btn-sm btn-delete" data-key="${escapeHtml(file.key)}" title="删除">🗑️</button>
        </div>
      </td>`;

    tr.querySelector('.file-name-cell').addEventListener('click', () => {
      if (canPreview) openPreview(file);
      else downloadFile(file.key);
    });
    tr.querySelector('.btn-download')?.addEventListener('click', e => {
      e.stopPropagation(); downloadFile(file.key);
    });
    tr.querySelector('.btn-preview')?.addEventListener('click', e => {
      e.stopPropagation(); openPreview(file);
    });
    tr.querySelector('.btn-delete')?.addEventListener('click', e => {
      e.stopPropagation(); handleDeleteFile(file.key);
    });

    dom.fileTbody.appendChild(tr);
  });

  // 排序表头高亮
  document.querySelectorAll('.file-table th[data-sort]').forEach(th => {
    th.classList.remove('sorted-asc','sorted-desc');
    if (th.dataset.sort === state.sortKey) {
      th.classList.add(state.sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
    }
  });
}

/** 网格视图渲染 */
function renderGridView(folders, files) {
  dom.fileGrid.innerHTML = '';
  const isEmpty = folders.length === 0 && files.length === 0;
  dom.emptyHintGrid.hidden = !isEmpty || state.loading;

  // 文件夹
  folders.forEach(folderPrefix => {
    const name = getFileName(folderPrefix) || folderPrefix;
    const item = document.createElement('div');
    item.className = 'grid-item';
    item.innerHTML = `
      <span class="grid-item-icon">📁</span>
      <span class="grid-item-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
      <div class="grid-item-actions">
        <button class="btn-icon" data-key="${escapeHtml(folderPrefix)}" title="删除文件夹">🗑️</button>
      </div>`;
    item.addEventListener('click', e => {
      if (!e.target.closest('.grid-item-actions')) loadFiles(folderPrefix);
    });
    item.querySelector('.grid-item-actions button').addEventListener('click', e => {
      e.stopPropagation(); handleDeleteFolder(folderPrefix);
    });
    dom.fileGrid.appendChild(item);
  });

  // 文件
  files.forEach(file => {
    const name = getFileName(file.key);
    const icon = getFileIcon(file.key);
    const type = getFileType(file.key);
    const canPreview = PREVIEW_TYPES.has(type);

    const item = document.createElement('div');
    item.className = 'grid-item';
    item.innerHTML = `
      <span class="grid-item-icon">${icon}</span>
      <span class="grid-item-name" title="${escapeHtml(file.key)}">${escapeHtml(name)}</span>
      <div class="grid-item-actions">
        ${canPreview ? `<button class="btn-icon" data-action="preview" title="预览">👁️</button>` : ''}
        <button class="btn-icon" data-action="download" title="下载">⬇️</button>
        <button class="btn-icon" data-action="delete" title="删除">🗑️</button>
      </div>`;

    item.addEventListener('click', e => {
      if (e.target.closest('.grid-item-actions')) return;
      if (canPreview) openPreview(file); else downloadFile(file.key);
    });

    item.querySelectorAll('.grid-item-actions button').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const action = btn.dataset.action;
        if (action === 'preview') openPreview(file);
        else if (action === 'download') downloadFile(file.key);
        else if (action === 'delete') handleDeleteFile(file.key);
      });
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

// ─── 排序 ──────────────────────────────────────────────────────────────────────

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

// ─── 刷新 ──────────────────────────────────────────────────────────────────────
dom.btnRefresh.addEventListener('click', () => loadFiles(state.currentPrefix));

// ─── 新建文件夹 ────────────────────────────────────────────────────────────────

dom.btnMkdir.addEventListener('click', () => {
  dom.mkdirInput.value = '';
  dom.mkdirError.hidden = true;
  dom.mkdirModal.hidden = false;
  setTimeout(() => dom.mkdirInput.focus(), 50);
});

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
      loadFiles(state.currentPrefix);
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

// ─── 删除操作 ──────────────────────────────────────────────────────────────────

async function handleDeleteFile(key) {
  const name = getFileName(key);
  const confirmed = await showConfirm('删除文件', `确定要删除文件 "${name}" 吗？此操作不可撤销。`);
  if (!confirmed) return;

  try {
    const res = await apiFetch(`${API.file}?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
    if (res.ok) {
      showToast('文件已删除', 'success');
      // 如果预览中的文件被删除，关闭预览
      if (state.previewItem?.key === key) closePreview();
      loadFiles(state.currentPrefix);
    } else {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || '删除失败', 'error');
    }
  } catch (err) {
    showToast('网络错误：' + err.message, 'error');
  }
}

async function handleDeleteFolder(folderKey) {
  const name = getFileName(folderKey) || folderKey;
  const confirmed = await showConfirm('删除文件夹', `确定要删除文件夹 "${name}" 吗？只能删除空文件夹。`);
  if (!confirmed) return;

  try {
    const res = await apiFetch(`${API.file}?key=${encodeURIComponent(folderKey)}`, { method: 'DELETE' });
    if (res.ok) {
      showToast('文件夹已删除', 'success');
      loadFiles(state.currentPrefix);
    } else {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || '删除失败（文件夹可能不为空）', 'error');
    }
  } catch (err) {
    showToast('网络错误：' + err.message, 'error');
  }
}

// ─── 下载文件 ──────────────────────────────────────────────────────────────────

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

// ─── 文件预览 ──────────────────────────────────────────────────────────────────

async function openPreview(file) {
  state.previewItem = file;
  const name = getFileName(file.key);
  const type = getFileType(file.key);
  const icon = getFileIcon(file.key);

  dom.previewIcon.textContent = icon;
  dom.previewFilename.textContent = name;
  dom.previewMeta.textContent = `${formatSize(file.size)}${file.uploaded ? '  ·  ' + formatDate(file.uploaded) : ''}`;
  dom.previewBody.innerHTML = '';

  dom.previewModal.hidden = false;
  document.body.style.overflow = 'hidden';

  const mediaUrl = buildMediaUrl(file.key);

  if (type === 'image') {
    const img = document.createElement('img');
    img.alt = name;
    img.src = mediaUrl;
    img.onload = () => img.style.opacity = '1';
    img.style.opacity = '0';
    img.style.transition = 'opacity 0.2s';
    dom.previewBody.appendChild(img);
    img.onload = () => { img.style.opacity = '1'; };

  } else if (type === 'video') {
    const video = document.createElement('video');
    video.controls = true;
    video.autoplay = false;
    video.preload = 'metadata';
    video.src = mediaUrl;
    video.style.maxWidth = '100%';
    video.style.maxHeight = '70vh';
    dom.previewBody.appendChild(video);

  } else if (type === 'audio') {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'width:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px;background:#1a1a1a;color:#fff;gap:20px';
    wrap.innerHTML = `<div style="font-size:72px">🎵</div><p style="font-size:16px;font-weight:500">${escapeHtml(name)}</p>`;
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = mediaUrl;
    audio.style.width = 'min(480px, 90%)';
    wrap.appendChild(audio);
    dom.previewBody.appendChild(wrap);

  } else if (type === 'text' || type === 'code') {
    dom.previewBody.innerHTML = '<div style="color:#9aa0a6;padding:24px">加载中...</div>';
    dom.previewBody.style.justifyContent = 'flex-start';
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
      dom.previewBody.innerHTML = `<div style="color:#f44336;padding:24px">加载文本失败：${escapeHtml(err.message)}</div>`;
    }

  } else if (type === 'pdf') {
    const iframe = document.createElement('iframe');
    iframe.className = 'preview-pdf';
    iframe.src = mediaUrl;
    iframe.title = name;
    dom.previewBody.appendChild(iframe);

  } else {
    dom.previewBody.innerHTML = `
      <div class="preview-unsupported">
        <div class="preview-unsupported-icon">${icon}</div>
        <p>该文件类型暂不支持在线预览</p>
        <p style="font-size:13px">${escapeHtml(name)}</p>
        <button class="btn btn-primary" style="margin-top:16px" onclick="downloadFile('${escapeHtml(file.key)}')">⬇️ 立即下载</button>
      </div>`;
  }
}

function closePreview() {
  dom.previewModal.hidden = true;
  document.body.style.overflow = '';
  // 停止媒体播放
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

dom.btnPreviewDel.addEventListener('click', () => {
  if (state.previewItem) handleDeleteFile(state.previewItem.key);
});

// ─── 上传系统 ──────────────────────────────────────────────────────────────────

/** 触发文件选择对话框 */
dom.btnUpload.addEventListener('click', () => dom.fileInput.click());

dom.fileInput.addEventListener('change', e => {
  const files = Array.from(e.target.files || []);
  if (files.length) enqueueFiles(files);
  dom.fileInput.value = ''; // 清空，允许重复选同一文件
});

/** 拖拽事件 */
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

/** 将文件加入上传队列 */
function enqueueFiles(files) {
  const items = files.map(file => ({
    id:       uid(),
    file,
    name:     file.name,
    size:     file.size,
    status:   'pending',  // pending | uploading | done | error
    progress: 0,
    error:    null,
  }));
  state.uploadQueue.push(...items);
  dom.uploadPanel.hidden = false;
  renderUploadPanel();
  processUploadQueue();
}

/** 渲染上传面板 */
function renderUploadPanel() {
  dom.uploadList.innerHTML = '';
  state.uploadQueue.forEach(item => {
    const div = document.createElement('div');
    div.className = 'upload-item';
    div.id = `upload-item-${item.id}`;

    const statusText = {
      pending:   '等待中',
      uploading: `${Math.round(item.progress)}%`,
      done:      '完成 ✓',
      error:     `失败: ${item.error || '未知错误'}`,
    }[item.status] || '';

    const statusClass = `status-${item.status}`;

    div.innerHTML = `
      <span class="upload-item-icon">${getFileIcon(item.name)}</span>
      <div class="upload-item-info">
        <div class="upload-item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
        <div class="upload-item-meta">${formatSize(item.size)}</div>
        ${item.status === 'uploading' ? `
          <div class="upload-progress-bar">
            <div class="upload-progress-fill" style="width:${item.progress}%"></div>
          </div>` : ''}
      </div>
      <span class="upload-item-status ${statusClass}">${statusText}</span>`;

    dom.uploadList.appendChild(div);
  });
}

/** 更新单个上传项的 UI */
function updateUploadItemUI(item) {
  const el = $(`upload-item-${item.id}`);
  if (!el) return;

  const statusText = {
    pending:   '等待中',
    uploading: `${Math.round(item.progress)}%`,
    done:      '完成 ✓',
    error:     `失败: ${item.error || '未知错误'}`,
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

/** 并发处理上传队列 */
async function processUploadQueue() {
  const uploadingCount = state.uploadQueue.filter(i => i.status === 'uploading').length;
  if (uploadingCount >= MAX_CONCURRENT_FILES) return;

  const pending = state.uploadQueue.filter(i => i.status === 'pending');
  const toStart = pending.slice(0, MAX_CONCURRENT_FILES - uploadingCount);

  for (const item of toStart) {
    item.status = 'uploading';
    updateUploadItemUI(item);
    uploadFile(item).then(() => {
      processUploadQueue(); // 完成一个后继续处理队列
    });
  }
}

/** 上传单个文件（自动选择普通/分块方式） */
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
    loadFiles(state.currentPrefix);
  } catch (err) {
    item.status = 'error';
    item.error = err.message;
    showToast(`${item.name} 上传失败：${err.message}`, 'error');
  } finally {
    updateUploadItemUI(item);
  }
}

/** 普通 PUT 上传（小文件） */
async function uploadSimple(item, key) {
  const contentType = item.file.type || 'application/octet-stream';

  // 使用 XMLHttpRequest 以便追踪进度
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
    xhr.onerror = () => reject(new Error('网络错误'));
    xhr.send(item.file);
  });
}

/** 分块上传（大文件） */
async function uploadMultipart(item, key) {
  const contentType = item.file.type || 'application/octet-stream';

  // 1. 创建 Multipart Upload
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

  // 2. 分块并发上传
  const totalChunks = Math.ceil(item.size / CHUNK_SIZE);
  const parts = [];
  let uploadedBytes = 0;

  // 按批次并发上传
  for (let batchStart = 0; batchStart < totalChunks; batchStart += MAX_CONCURRENT_CHUNKS) {
    const batchEnd = Math.min(batchStart + MAX_CONCURRENT_CHUNKS, totalChunks);
    const batchPromises = [];

    for (let i = batchStart; i < batchEnd; i++) {
      const partNumber = i + 1; // R2 partNumber 从 1 开始
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

  // 按 partNumber 排序（必须有序）
  parts.sort((a, b) => a.partNumber - b.partNumber);

  // 3. 完成上传
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
    // 尝试中止上传
    apiFetch(
      `${API.file}?key=${encodeURIComponent(key)}&action=abortMultipart&uploadId=${encodeURIComponent(uploadId)}`,
      { method: 'DELETE' }
    ).catch(() => {});
    throw new Error(d.error || '完成分块上传失败');
  }
}

// 清除已完成的上传任务
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

// ─── 键盘快捷键 ────────────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  // ESC 关闭 Modal
  if (e.key === 'Escape') {
    if (!dom.previewModal.hidden) { closePreview(); return; }
    if (!dom.mkdirModal.hidden)   { dom.mkdirModal.hidden = true; return; }
    if (!dom.confirmModal.hidden) {
      dom.confirmModal.hidden = true;
      return;
    }
  }
  // F5 / Ctrl+R 刷新列表
  if (e.key === 'F5' || (e.ctrlKey && e.key === 'r')) {
    if (!dom.app.hidden) {
      e.preventDefault();
      loadFiles(state.currentPrefix);
    }
  }
});

// ─── 启动 ──────────────────────────────────────────────────────────────────────
initAuth();
