/**
 * public/app.js — R2 云盘前端入口协调模块 (原生 ES Modules · HttpOnly Cookie 会话版)
 */

import { API, DIR_CACHE_TTL } from './js/config.js';
import { state, dom, inFlightRequests, saveVirtualTreeToStorage } from './js/state.js';
import { apiFetch, showToast } from './js/api.js';
import {
  dirCache,
  saveDirCacheToStorage,
  clearDirCache,
  extractVirtualDir,
  updateStorageUI,
  registerCacheUiCallbacks,
} from './js/cache.js';
import {
  setLoading,
  renderBreadcrumb,
  updateSelectionUI,
  renderFileList,
  applyViewMode,
  registerUiItemHandlers,
} from './js/ui.js';
import { openPreview, closePreview } from './js/preview.js';
import './js/upload.js';
import { closeRenameModal, closeMoveModal } from './js/actions.js';

// 注册无环 UI 回调
registerCacheUiCallbacks({ renderFileList, updateSelectionUI });
registerUiItemHandlers({
  onOpenFolder: prefix => loadFiles(prefix),
  onOpenPreview: file => openPreview(file),
});

// ─── 会话鉴权流 (HttpOnly Cookie · 0 Class A 消耗) ────────────────────────────
async function checkSession() {
  try {
    const res = await apiFetch(API.auth);
    if (res.status === 503) {
      return { ok: false, status: 503 };
    }
    return { ok: res.status === 200, status: res.status };
  } catch (_) {
    return { ok: false, status: 0 };
  }
}

async function initAuth() {
  const result = await checkSession();
  hideLoader();
  if (result.ok) {
    showApp();
    return;
  }
  showLogin();
  if (result.status === 503) {
    dom.loginError.textContent = '服务端尚未配置访问密码 (DRIVE_PASSWORD)，请联系管理员配置';
    dom.loginError.hidden = false;
  }
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
    const res = await apiFetch(API.auth, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd }),
    });
    if (res.ok) {
      dom.passwordInput.value = '';
      showApp();
    } else {
      const data = await res.json().catch(() => ({}));
      dom.loginError.textContent = data.message || '密码错误，请重新输入';
      dom.loginError.hidden = false;
      dom.passwordInput.select();
    }
  } catch (_) {
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

dom.btnLogout.addEventListener('click', async () => {
  try {
    await apiFetch(API.auth, { method: 'DELETE' });
  } catch (_) {}
  clearDirCache();
  state.currentPrefix = '';
  state.files = [];
  state.folders = [];
  state.selectedKeys.clear();
  showLogin();
});

// ─── 文件数据加载 (全盘轻量虚拟树 + sessionStorage 持久化 + 请求合并) ─────────────
export async function loadFiles(prefix = '', forceRefresh = false) {
  state.loading = true;
  state.currentPrefix = prefix;
  state.selectedKeys.clear();
  updateSelectionUI();
  renderBreadcrumb(prefix);

  // 1. 全盘轻量虚拟树引擎：若已索引整盘且非强制刷新，直接在内存切分目录，0 网络请求，0 Class A
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
      if (res.status === 401 || res.status === 503) {
        clearDirCache();
        showLogin();
        if (res.status === 503) {
          dom.loginError.textContent = '服务端尚未配置访问密码 (DRIVE_PASSWORD)';
          dom.loginError.hidden = false;
        }
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || '获取文件列表失败', 'error');
        return;
      }
      const data = await res.json();

      if (data.all) {
        state.allObjects = data.objects || [];
        state.isVirtualTree = !data.truncated;
        saveVirtualTreeToStorage();

        const vData = extractVirtualDir(prefix);
        state.folders = vData ? vData.folders : [];
        state.files = vData ? vData.files : [];

        const total = data.totalSize != null
          ? data.totalSize
          : state.allObjects.reduce((acc, o) => acc + (o.size || 0), 0);
        updateStorageUI(total);
      } else {
        state.folders = data.folders || [];
        state.files = data.files || [];
      }

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

// ─── 视图切换、排序与防抖刷新 ─────────────────────────────────────────────────
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

// ─── 启动应用 ──────────────────────────────────────────────────────────────────
initAuth();
