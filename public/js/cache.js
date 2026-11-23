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
  MAX_HEIC_CACHE_ITEMS,
  formatSize,
  getFileCategory,
  escapeHtml,
} from './config.js';
import { state, dom, saveVirtualTreeToStorage } from './state.js';

const STORAGE_CATEGORIES = [
  { key: 'image',   label: '图片',   color: '#34C759' },
  { key: 'video',   label: '视频',   color: '#AF52DE' },
  { key: 'doc',     label: '文档',   color: '#007AFF' },
  { key: 'archive', label: '压缩包', color: '#FF9500' },
  { key: 'other',   label: '其他',   color: '#AEAEB2' },
];

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
export const heicPreviewCache = new Map(); // key -> ObjectUrl (LRU <= MAX_HEIC_CACHE_ITEMS)
export const xlsxPreviewCache = new Map(); // key -> ArrayBuffer

export function getHeicCache(key) {
  if (!heicPreviewCache.has(key)) return null;
  const url = heicPreviewCache.get(key);
  // 命中后移至队尾维持 LRU 顺序
  heicPreviewCache.delete(key);
  heicPreviewCache.set(key, url);
  return url;
}

export function setHeicCache(key, objectUrl) {
  if (!objectUrl) return;
  if (heicPreviewCache.has(key)) {
    const old = heicPreviewCache.get(key);
    if (old && old !== objectUrl) {
      try { URL.revokeObjectURL(old); } catch (_) {}
    }
    heicPreviewCache.delete(key);
  }
  heicPreviewCache.set(key, objectUrl);
  while (heicPreviewCache.size > MAX_HEIC_CACHE_ITEMS) {
    const oldestKey = heicPreviewCache.keys().next().value;
    revokeHeicCacheKey(oldestKey);
  }
}

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
  if (dom.storageBarFill) {
    dom.storageBarFill.style.width = pct.toFixed(1) + '%';
    dom.storageBarFill.classList.toggle('warning', pct >= 80 && pct < 95);
    dom.storageBarFill.classList.toggle('danger', pct >= 95);
  }
  if (dom.storageText) {
    dom.storageText.textContent = `${formatSize(state.totalUsedBytes)} / 10 GB`;
  }

  // 基于本地虚拟树计算分类容量分段，零新增接口请求
  if (dom.storageBarSegments && dom.storageLegend) {
    if (Array.isArray(state.allObjects) && state.totalUsedBytes > 0) {
      const counts = { image: 0, video: 0, doc: 0, archive: 0, other: 0 };
      let accounted = 0;
      for (const obj of state.allObjects) {
        if (!obj || !obj.key || obj.key.endsWith('/')) continue;
        const size = Number(obj.size) || 0;
        if (size <= 0) continue;
        const cat = getFileCategory(obj.key);
        counts[cat] = (counts[cat] || 0) + size;
        accounted += size;
      }
      if (accounted > 0) {
        dom.storageBarSegments.hidden = false;
        if (dom.storageBarFill) dom.storageBarFill.hidden = true;
        dom.storageBarSegments.innerHTML = STORAGE_CATEGORIES
          .filter(c => counts[c.key] > 0)
          .map(c => {
            const segPct = Math.min(100, (counts[c.key] / TOTAL_CAPACITY_BYTES) * 100);
            const title = `${c.label}: ${formatSize(counts[c.key])}`;
            return `<span class="storage-bar-seg" style="width:${segPct.toFixed(3)}%;background:${c.color}" title="${escapeHtml(title)}"></span>`;
          }).join('');
        dom.storageLegend.innerHTML = STORAGE_CATEGORIES
          .filter(c => counts[c.key] > 0)
          .map(c => `<span class="storage-legend-item"><i class="storage-dot" style="background:${c.color}"></i><span>${c.label} ${escapeHtml(formatSize(counts[c.key]))}</span></span>`)
          .join('');
        return;
      }
    }
    dom.storageBarSegments.hidden = true;
    dom.storageBarSegments.innerHTML = '';
    if (dom.storageBarFill) dom.storageBarFill.hidden = false;
    dom.storageLegend.innerHTML = '';
  }
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
  state.typeFilter = 'all';
  state.sidebarExpanded = new Set(['']);
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

export function optimisticAddFile(key, size, mimeType, etag = null) {
  textPreviewCache.delete(key);
  revokeHeicCacheKey(key);
  xlsxPreviewCache.delete(key);

  const filePrefix = key.includes('/') ? key.slice(0, key.lastIndexOf('/') + 1) : '';
  const oldFile = (state.allObjects && state.allObjects.find(o => o.key === key))
    || (filePrefix === state.currentPrefix ? state.files.find(f => f.key === key) : null);
  const diff = size - (oldFile ? (oldFile.size || 0) : 0);

  const newFile = {
    key,
    size,
    uploaded: new Date().toISOString(),
    httpMetadata: { contentType: mimeType || 'application/octet-stream' },
    etag: etag || null,
  };

  if (state.allObjects) {
    state.allObjects = state.allObjects.filter(o => o.key !== key);
    state.allObjects.push(newFile);
    saveVirtualTreeToStorage();
  }

  if (filePrefix === state.currentPrefix) {
    state.files = state.files.filter(f => f.key !== key);
    state.files.push(newFile);
  }

  const cached = dirCache.get(filePrefix);
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
