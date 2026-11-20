/**
 * public/js/actions.js
 * 文件及文件夹批量操作：新建目录、批量下载、递归原子删除、重命名、目录树移动（含同名拦截）
 */

import { API, getFileName, escapeHtml, renderSvgIcon } from './config.js';
import { state, dom } from './state.js';
import { apiFetch, downloadFile, showToast, showConfirm } from './api.js';
import {
  dirCache,
  optimisticAddFolder,
  optimisticRemoveItems,
  optimisticMoveItems,
} from './cache.js';

// ─── 新建文件夹 ────────────────────────────────────────────────────────────────
export function openMkdirModal() {
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
  if (!name || /[/\\:*?"<>|]/.test(name)) {
    dom.mkdirError.textContent = '文件夹名称不能为空，且不能包含 / \\ : * ? " < > | 等非法字符';
    dom.mkdirError.hidden = false;
    return;
  }

  const key = state.currentPrefix + name + '/';
  if (state.folders.includes(key)) {
    dom.mkdirError.textContent = '当前目录下已存在同名文件夹';
    dom.mkdirError.hidden = false;
    return;
  }

  dom.mkdirError.hidden = true;

  try {
    const res = await apiFetch(`${API.file}?key=${encodeURIComponent(key)}&action=mkdir`, {
      method: 'PUT',
    });
    if (res.ok) {
      dom.mkdirModal.hidden = true;
      showToast('文件夹创建成功', 'success');
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

// ─── 批量下载 & 递归批量删除 ──────────────────────────────────────────────────
dom.btnBatchDownload?.addEventListener('click', () => {
  if (state.selectedKeys.size === 0) return;

  const filesToDownload = state.files.filter(f => state.selectedKeys.has(f.key));
  if (filesToDownload.length === 0) {
    showToast('选中的项目中没有可下载的文件（文件夹不支持直接下载）', 'warning');
    return;
  }

  showToast(`正在开始下载 ${filesToDownload.length} 个文件...`, 'info');
  filesToDownload.forEach((f, index) => {
    setTimeout(() => {
      downloadFile(f.key);
    }, index * 200);
  });
});

dom.btnBatchDelete?.addEventListener('click', async () => {
  const count = state.selectedKeys.size;
  if (count === 0) return;

  const selected = Array.from(state.selectedKeys);
  const expandedKeySet = new Set(selected);
  let subItemCount = 0;

  if (state.allObjects) {
    for (const selKey of selected) {
      if (selKey.endsWith('/')) {
        for (const obj of state.allObjects) {
          if (obj.key.startsWith(selKey) && obj.key !== selKey) {
            if (!expandedKeySet.has(obj.key)) {
              subItemCount++;
            }
            expandedKeySet.add(obj.key);
          }
        }
      }
    }
  }

  const confirmMsg = subItemCount > 0
    ? `确定要删除已选中的 ${count} 个项目吗？（其中包含文件夹内的 ${subItemCount} 个子文件/对象，将一并彻底删除，此操作不可撤销）`
    : `确定要删除已选中的 ${count} 个项目吗？此操作无法撤销。`;

  const confirmed = await showConfirm('确认删除', confirmMsg);
  if (!confirmed) return;

  const allKeysToDelete = Array.from(expandedKeySet);
  showToast(`正在删除 ${allKeysToDelete.length} 个对象...`, 'info');

  try {
    const BATCH_LIMIT = 1000;
    let totalDeleted = 0;

    for (let i = 0; i < allKeysToDelete.length; i += BATCH_LIMIT) {
      const chunk = allKeysToDelete.slice(i, i + BATCH_LIMIT);
      const res = await apiFetch(`${API.file}?action=batchDelete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keys: chunk,
          expandFolders: !state.allObjects,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || '批量删除失败');
      }
      const data = await res.json().catch(() => ({}));
      totalDeleted += (data.deletedCount || chunk.length);
    }

    showToast(`成功删除 ${totalDeleted} 个对象`, 'success');
    optimisticRemoveItems(allKeysToDelete);
  } catch (err) {
    showToast('批量删除异常：' + err.message, 'error');
  }
});

// ─── 文件与文件夹重命名系统 ──────────────────────────────────────────────────
let currentRenamingKey = null;

export function openRenameModal() {
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

export function closeRenameModal() {
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
      items = [{ from: key, to: toKey, expandFolder: !state.allObjects }];
    }
  } else {
    const parentPrefix = key.includes('/') ? key.slice(0, key.lastIndexOf('/') + 1) : '';
    toKey = parentPrefix + newName;

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
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
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

// ─── 文件与文件夹移动系统 (含同名冲突零成本拦截) ─────────────────────────────
let selectedMoveDest = null;

function getAllFolderPaths() {
  const folders = new Set();
  folders.add('');
  if (state.allObjects) {
    for (const obj of state.allObjects) {
      const parts = obj.key.split('/');
      let cur = '';
      const limit = parts.length - 1;
      for (let i = 0; i < limit; i++) {
        cur += parts[i] + '/';
        folders.add(cur);
      }
    }
  }
  for (const [pfx, cached] of dirCache.entries()) {
    if (pfx) folders.add(pfx);
    (cached.folders || []).forEach(f => folders.add(f.endsWith('/') ? f : f + '/'));
  }
  state.folders.forEach(f => {
    folders.add(f.endsWith('/') ? f : f + '/');
  });
  return Array.from(folders).sort();
}

function checkTargetExists(toKey, isFolder, destPrefix) {
  if (state.allObjects) {
    if (isFolder) {
      return state.allObjects.some(o => o.key === toKey || o.key.startsWith(toKey));
    }
    return state.allObjects.some(o => o.key === toKey);
  }
  const cached = dirCache.get(destPrefix);
  if (cached) {
    if (isFolder) {
      return (cached.folders || []).includes(toKey);
    }
    return (cached.files || []).some(f => f.key === toKey);
  }
  return false;
}

export function openMoveModal() {
  if (state.selectedKeys.size === 0) return;
  const selected = Array.from(state.selectedKeys);
  selectedMoveDest = null;

  dom.moveSubtitle.textContent = `将移动选中的 ${selected.length} 个项目至目标目录`;

  let totalFiles = 0;
  selected.forEach(k => {
    if (k.endsWith('/')) {
      if (state.allObjects) {
        const countInFolder = state.allObjects.filter(o => o.key.startsWith(k)).length;
        totalFiles += Math.max(1, countInFolder);
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
        <span class="move-tree-badge">${badge}</span>
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

export function closeMoveModal() {
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
      const folderDisplay = getFileName(k.slice(0, -1));
      const folderName = folderDisplay + '/';
      const toKey = destPrefix + folderName;

      if (checkTargetExists(toKey, true, destPrefix)) {
        showToast(`目标目录已存在同名文件夹 "${folderDisplay}"，已取消移动以避免覆盖`, 'error');
        return;
      }

      mappings.push({ from: k, to: toKey, isFolder: true });

      if (state.allObjects) {
        const subObjs = state.allObjects.filter(o => o.key.startsWith(k));
        subObjs.forEach(o => {
          items.push({ from: o.key, to: toKey + o.key.slice(k.length) });
        });
      }
      if (!items.some(i => i.from.startsWith(k))) {
        items.push({ from: k, to: toKey, expandFolder: !state.allObjects });
      }
    } else {
      const fileName = getFileName(k);
      const toKey = destPrefix + fileName;

      if (checkTargetExists(toKey, false, destPrefix)) {
        showToast(`目标目录已存在同名文件 "${fileName}"，已取消移动以避免覆盖`, 'error');
        return;
      }

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
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      throw new Error(data.error || '移动失败');
    }

    const results = data.results || [];
    const failedSet = new Set(results.filter(r => !r.success).map(r => r.from));
    const succeededMappings = mappings.filter(m => !failedSet.has(m.from));

    if (succeededMappings.length > 0) {
      optimisticMoveItems(succeededMappings);
    }

    if (failedSet.size > 0) {
      showToast(`部分项目移动失败（成功 ${succeededMappings.length} 项，失败 ${failedSet.size} 项）`, 'warning');
    } else {
      showToast(`成功移动 ${succeededMappings.length} 个项目`, 'success');
    }
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
