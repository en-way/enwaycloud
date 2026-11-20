/**
 * public/js/ui.js
 * 面包屑导航、多选与工具栏动态控制、列表与网格视图渲染
 */

import {
  formatSize,
  formatDate,
  getFileName,
  getFileType,
  escapeHtml,
  renderSvgIcon,
} from './config.js';
import { state, dom } from './state.js';

let itemHandlers = {
  onOpenFolder: () => {},
  onOpenPreview: () => {},
};

export function registerUiItemHandlers(handlers) {
  itemHandlers = { ...itemHandlers, ...handlers };
}

export function setLoading(loading) {
  dom.loadingHint.hidden = !loading;
}

export function renderBreadcrumb(prefix) {
  dom.breadcrumb.innerHTML = '';

  const rootBtn = document.createElement('button');
  rootBtn.className = 'breadcrumb-item root';
  rootBtn.dataset.prefix = '';
  rootBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="bc-icon">
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>根目录`;
  rootBtn.addEventListener('click', () => itemHandlers.onOpenFolder(''));
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
      btn.addEventListener('click', () => itemHandlers.onOpenFolder(segPrefix));
    }
    dom.breadcrumb.appendChild(btn);
  });
}

export function toggleItemSelection(key) {
  if (state.selectedKeys.has(key)) {
    state.selectedKeys.delete(key);
  } else {
    state.selectedKeys.add(key);
  }
  updateSelectionUI();
  updateRowsSelectionClass();
}

export function updateSelectionUI() {
  const totalItems = state.folders.length + state.files.length;
  const count = state.selectedKeys.size;
  const hasSelection = count > 0;

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

export function updateRowsSelectionClass() {
  document.querySelectorAll('#file-tbody tr[data-key]').forEach(tr => {
    const key = tr.dataset.key;
    const isChecked = state.selectedKeys.has(key);
    tr.classList.toggle('row-selected', isChecked);
    const cb = tr.querySelector('.item-checkbox');
    if (cb) cb.checked = isChecked;
  });

  document.querySelectorAll('#file-grid .grid-item[data-key]').forEach(card => {
    const key = card.dataset.key;
    const isChecked = state.selectedKeys.has(key);
    card.classList.toggle('card-selected', isChecked);
    const cb = card.querySelector('.item-checkbox');
    if (cb) cb.checked = isChecked;
  });
}

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

export function renderFileList() {
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

function renderListView(folders, files) {
  dom.fileTbody.innerHTML = '';
  const isEmpty = folders.length === 0 && files.length === 0;
  dom.emptyHint.hidden = !isEmpty || state.loading;

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

    const cb = tr.querySelector('.item-checkbox');
    cb.addEventListener('click', e => {
      e.stopPropagation();
      toggleItemSelection(folderPrefix);
    });

    tr.addEventListener('click', e => {
      if (e.target.closest('.item-checkbox')) return;
      itemHandlers.onOpenFolder(folderPrefix);
    });

    dom.fileTbody.appendChild(tr);
  });

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

    const cb = tr.querySelector('.item-checkbox');
    cb.addEventListener('click', e => {
      e.stopPropagation();
      toggleItemSelection(file.key);
    });

    tr.addEventListener('click', e => {
      if (e.target.closest('.item-checkbox')) return;
      itemHandlers.onOpenPreview(file);
    });

    dom.fileTbody.appendChild(tr);
  });

  document.querySelectorAll('.file-table th[data-sort]').forEach(th => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.sort === state.sortKey) {
      th.classList.add(state.sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
    }
  });
}

function renderGridView(folders, files) {
  dom.fileGrid.innerHTML = '';
  const isEmpty = folders.length === 0 && files.length === 0;
  dom.emptyHintGrid.hidden = !isEmpty || state.loading;

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
      itemHandlers.onOpenFolder(folderPrefix);
    });

    dom.fileGrid.appendChild(item);
  });

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
      itemHandlers.onOpenPreview(file);
    });

    dom.fileGrid.appendChild(item);
  });
}

export function applyViewMode() {
  const isList = state.viewMode === 'list';
  dom.fileListView.hidden = !isList;
  dom.fileGridView.hidden = isList;
  dom.btnViewList.classList.toggle('active', isList);
  dom.btnViewGrid.classList.toggle('active', !isList);
}
