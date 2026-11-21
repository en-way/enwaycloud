/**
 * public/js/cache.js
 * localStorage 目录/虚拟树持久化缓存、预览内存池、容量状态同步与本地乐观更新
 */

import {
  DIR_CACHE_TTL,
  STORAGE_CACHE_KEY,
  STORAGE_TREE_KEY,
  STORAGE_USAGE_KEY,
  TOTAL_CAPACITY_BYTES,
  formatSize,
} from './config.js';
import { state, dom, saveVirtualTreeToStorage } from './state.js';

let uiCallbacks = {
  renderFileList: () => {},
  updateSelectionUI: () => {},
};

export function registerCacheUiCallbacks(callbacks) {
  uiCallbacks = { ...uiCallbacks, ...callbacks };
}

function loadDirCacheFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_CACHE_KEY);
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

export const dirCache = loadDirCacheFromStorage();

export function saveDirCacheToStorage() {
  try {
    const obj = Object.fromEntries(dirCache);
    localStorage.setItem(STORAGE_CACHE_KEY, JSON.stringify(obj));
  } catch (_) {}
}

export const textPreviewCache = new Map(); // key -> text content
export const heicPreviewCache = new Map(); // key -> ObjectUrl
export const xlsxPreviewCache = new Map(); // key -> ArrayBuffer

export function revokeHeicCacheKey(key) {
  const url = heicPreviewCache.get(key);
  if (url) {
    try { URL.revokeObjectURL(url); } catch (_) {}
    heicPreviewCache.delete(key);
  }
}

export function clearHeicCache() {
  for (const url of heicPreviewCache.values()) {
    try { URL.revokeObjectURL(url); } catch (_) {}
  }
  heicPreviewCache.clear();
}

export function updateStorageUI(usedBytes) {
  if (usedBytes != null) {
    state.totalUsedBytes = Math.max(0, usedBytes);
    try {
      localStorage.setItem(STORAGE_USAGE_KEY, String(state.totalUsedBytes));
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

export function clearDirCache() {
  dirCache.clear();
  textPreviewCache.clear();
  clearHeicCache();
  xlsxPreviewCache.clear();
  try {
    localStorage.removeItem(STORAGE_CACHE_KEY);
    localStorage.removeItem(STORAGE_TREE_KEY);
    localStorage.removeItem(STORAGE_USAGE_KEY);
    // 顺手清理旧版 sessionStorage 残留
    sessionStorage.removeItem(STORAGE_CACHE_KEY);
    sessionStorage.removeItem(STORAGE_TREE_KEY);
    sessionStorage.removeItem(STORAGE_USAGE_KEY);
  } catch (_) {}
  state.allObjects = null;
  state.isVirtualTree = false;
  state.totalUsedBytes = 0;
  updateStorageUI(0);
}

export function extractVirtualDir(prefix) {
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
      const folderName = rest.slice(0, slashIndex + 1);
      folderSet.add(prefix + folderName);
    } else if (!obj.key.endsWith('/') || obj.size > 0) {
      files.push(obj);
    }
  }

  return {
    folders: Array.from(folderSet).sort(),
    files,
  };
}

export function optimisticRemoveItems(keys) {
  const set = new Set(keys);
  const isRemoved = k => {
    if (set.has(k)) return true;
    for (const item of keys) {
      if (item.endsWith('/') && k.startsWith(item)) return true;
    }
    return false;
  };

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

  for (const k of removedSet) {
    textPreviewCache.delete(k);
    revokeHeicCacheKey(k);
    xlsxPreviewCache.delete(k);
  }
  keys.forEach(k => {
    textPreviewCache.delete(k);
    revokeHeicCacheKey(k);
    xlsxPreviewCache.delete(k);
  });

  state.files = state.files.filter(f => !isRemoved(f.key));
  state.folders = state.folders.filter(f => !isRemoved(f));

  if (state.allObjects) {
    state.allObjects = state.allObjects.filter(o => !isRemoved(o.key));
    saveVirtualTreeToStorage();
    const vData = extractVirtualDir(state.currentPrefix);
    if (vData) {
      state.folders = vData.folders;
      state.files = vData.files;
    }
  }

  for (const [pfx, cached] of dirCache.entries()) {
    if (isRemoved(pfx)) {
      dirCache.delete(pfx);
    } else {
      cached.files = cached.files.filter(f => !isRemoved(f.key));
      cached.folders = cached.folders.filter(f => !isRemoved(f));
    }
  }
  saveDirCacheToStorage();

  state.totalUsedBytes = Math.max(0, state.totalUsedBytes - deletedBytes);
  updateStorageUI(state.totalUsedBytes);

  state.selectedKeys.clear();
  uiCallbacks.updateSelectionUI();
  uiCallbacks.renderFileList();
}

export function optimisticAddFolder(folderKey) {
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
      saveVirtualTreeToStorage();
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
  uiCallbacks.renderFileList();
}

export function optimisticAddFile(key, size, mimeType) {
  textPreviewCache.delete(key);
  revokeHeicCacheKey(key);
  xlsxPreviewCache.delete(key);
  const oldFile = state.files.find(f => f.key === key) || (state.allObjects && state.allObjects.find(o => o.key === key));
  const diff = size - (oldFile ? (oldFile.size || 0) : 0);

  const newFile = {
    key,
    size,
    uploaded: new Date().toISOString(),
    httpMetadata: { contentType: mimeType || 'application/octet-stream' },
    etag: null,
  };

  if (state.allObjects) {
    state.allObjects = state.allObjects.filter(o => o.key !== key);
    state.allObjects.push(newFile);
    saveVirtualTreeToStorage();
  }

  state.files = state.files.filter(f => f.key !== key);
  state.files.push(newFile);

  const cached = dirCache.get(state.currentPrefix);
  if (cached) {
    cached.files = cached.files.filter(f => f.key !== key);
    cached.files.push(newFile);
  }
  saveDirCacheToStorage();

  state.totalUsedBytes = Math.max(0, state.totalUsedBytes + diff);
  updateStorageUI(state.totalUsedBytes);

  uiCallbacks.renderFileList();
}

export function optimisticMoveItems(mappings) {
  for (const m of mappings) {
    textPreviewCache.delete(m.from);
    revokeHeicCacheKey(m.from);
    xlsxPreviewCache.delete(m.from);

    if (m.isFolder) {
      if (state.allObjects) {
        state.allObjects.forEach(obj => {
          if (obj.key.startsWith(m.from)) {
            textPreviewCache.delete(obj.key);
            revokeHeicCacheKey(obj.key);
            xlsxPreviewCache.delete(obj.key);
            obj.key = m.to + obj.key.slice(m.from.length);
          }
        });
      }
    } else if (state.allObjects) {
      const target = state.allObjects.find(o => o.key === m.from);
      if (target) {
        target.key = m.to;
      }
    }
  }

  saveVirtualTreeToStorage();
  dirCache.clear();
  try { localStorage.removeItem(STORAGE_CACHE_KEY); } catch (_) {}

  if (state.isVirtualTree && state.allObjects) {
    const vData = extractVirtualDir(state.currentPrefix);
    if (vData) {
      state.folders = vData.folders;
      state.files = vData.files;
    }
  } else {
    for (const m of mappings) {
      const toPrefix = m.isFolder
        ? m.to.slice(0, m.to.lastIndexOf('/', m.to.length - 2) + 1)
        : (m.to.includes('/') ? m.to.slice(0, m.to.lastIndexOf('/') + 1) : '');
      if (toPrefix === state.currentPrefix) {
        if (m.isFolder) {
          state.folders = state.folders.map(f => f === m.from ? m.to : f).sort();
        } else {
          const fObj = state.files.find(f => f.key === m.from);
          if (fObj) fObj.key = m.to;
        }
      } else if (m.isFolder) {
        state.folders = state.folders.filter(f => f !== m.from);
      } else {
        state.files = state.files.filter(f => f.key !== m.from);
      }
    }
  }

  state.selectedKeys.clear();
  uiCallbacks.updateSelectionUI();
  uiCallbacks.renderFileList();
}
