/**
 * public/js/ui.js
 * 侧边栏导航/目录树/抽屉、本地分类筛选、面包屑、双端列表/网格与底部浮动选择栏渲染
 */

import {
  formatSize,
  formatDate,
  getFileName,
  getFileType,
  getFileCategory,
  isThumbnailSupported,
  escapeHtml,
  renderSvgIcon,
  renderFileBadge,
} from './config.js';
import { state, dom } from './state.js';
import { buildMediaUrl } from './api.js';
import { dirCache, updateStorageUI } from './cache.js';

const TYPE_FILTER_LABELS = {
  all:     '全部文件',
  image:   '图片',
  video:   '视频',
  doc:     '文档',
  archive: '压缩包',
};

const ROW_ACTION_ICONS = {
  preview: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`,
  download: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>`,
  rename: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`,
  move: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><polyline points="12 11 15 14 12 17"/><line x1="9" x2="15" y1="14" y2="14"/></svg>`,
  delete: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`,
  more: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="19" r="1.3" fill="currentColor"/></svg>`,
};

let itemHandlers = {
  onOpenFolder: () => {},
  onOpenPreview: () => {},
  onItemAction: () => {},
  onOpenRowSheet: () => {},
};

/** key -> { isFolder, key, file } */
const renderedItemMap = new Map();

export function registerUiItemHandlers(handlers) {
  itemHandlers = { ...itemHandlers, ...handlers };
}

// ─── 手机端抽屉控制 ──────────────────────────────────────────────────────────
export function isDrawerOpen() {
  return Boolean(dom.sidebar && dom.sidebar.classList.contains('drawer-open'));
}

export function openDrawer() {
  if (!dom.sidebar || !dom.drawerBackdrop) return;
  dom.drawerBackdrop.hidden = false;
  requestAnimationFrame(() => {
    dom.sidebar.classList.add('drawer-open');
    dom.drawerBackdrop.classList.add('is-open');
  });
  dom.btnMenu?.setAttribute('aria-expanded', 'true');
  document.body.style.overflow = 'hidden';
}

export function closeDrawer() {
  if (!dom.sidebar || !dom.drawerBackdrop) return;
  dom.sidebar.classList.remove('drawer-open');
  dom.drawerBackdrop.classList.remove('is-open');
  dom.btnMenu?.setAttribute('aria-expanded', 'false');
  document.body.style.overflow = '';
  setTimeout(() => {
    if (!dom.sidebar.classList.contains('drawer-open')) {
      dom.drawerBackdrop.hidden = true;
    }
  }, 240);
}

// ─── 骨架屏加载态 ──────────────────────────────────────────────────────────────
export function setLoading(loading) {
  if (dom.btnRefresh) {
    dom.btnRefresh.classList.toggle('is-spinning', loading);
    dom.btnRefresh.disabled = loading;
  }
  if (!dom.loadingHint) return;
  dom.loadingHint.hidden = !loading;
  if (loading) {
    if (dom.fileListView) dom.fileListView.hidden = true;
    if (dom.fileGridView) dom.fileGridView.hidden = true;
    if (dom.emptyHint) dom.emptyHint.hidden = true;
    if (dom.emptyHintGrid) dom.emptyHintGrid.hidden = true;
  } else {
    applyViewMode();
  }
}

// ─── 侧边栏快捷分类（零新增 API） ─────────────────────────────────────────────
export function renderTypeNav() {
  if (!dom.typeNav) return;
  const degraded = !state.loading && !state.isVirtualTree;
  if (degraded && state.typeFilter !== 'all') {
    state.typeFilter = 'all';
  }

  dom.typeNav.querySelectorAll('[data-type]').forEach(btn => {
    const t = btn.dataset.type;
    const isAll = t === 'all';
    const disabled = !isAll && degraded;
    btn.disabled = disabled;
    btn.classList.toggle('is-disabled', disabled);
    btn.classList.toggle('active', state.typeFilter === t);
  });

  if (dom.typeNavHint) {
    dom.typeNavHint.hidden = !degraded;
  }
}

export function setTypeFilter(type) {
  if (!TYPE_FILTER_LABELS[type]) type = 'all';
  if (type !== 'all' && !state.isVirtualTree) {
    return;
  }
  state.typeFilter = type;
  state.selectedKeys.clear();
  closeDrawer();
  renderFileList();
}

dom.typeNav?.addEventListener('click', e => {
  const btn = e.target.closest('[data-type]');
  if (!btn || btn.disabled) return;
  setTypeFilter(btn.dataset.type);
});

dom.btnClearFilter?.addEventListener('click', () => {
  setTypeFilter('all');
});

// ─── 侧边栏虚拟目录树（纯本地推导） ───────────────────────────────────────────
export function expandAncestors(prefix) {
  state.sidebarExpanded.add('');
  if (!prefix) return;
  const parts = prefix.split('/').filter(Boolean);
  let cur = '';
  for (const part of parts) {
    cur += part + '/';
    state.sidebarExpanded.add(cur);
  }
}

function collectSidebarFolderChildren() {
  const childrenMap = new Map();
  childrenMap.set('', new Set());

  const addFolderPrefix = folderPrefix => {
    if (!folderPrefix) return;
    const parts = folderPrefix.split('/').filter(Boolean);
    let parent = '';
    for (const part of parts) {
      const next = parent + part + '/';
      if (!childrenMap.has(parent)) childrenMap.set(parent, new Set());
      childrenMap.get(parent).add(next);
      if (!childrenMap.has(next)) childrenMap.set(next, new Set());
      parent = next;
    }
  };

  if (Array.isArray(state.allObjects)) {
    for (const obj of state.allObjects) {
      if (!obj?.key) continue;
      const idx = obj.key.lastIndexOf('/');
      if (idx > 0) {
        addFolderPrefix(obj.key.slice(0, idx + 1));
      }
    }
  } else {
    for (const [pfx, cached] of dirCache.entries()) {
      if (pfx) addFolderPrefix(pfx);
      (cached.folders || []).forEach(f => addFolderPrefix(f.endsWith('/') ? f : f + '/'));
    }
    state.folders.forEach(f => addFolderPrefix(f.endsWith('/') ? f : f + '/'));
  }

  return childrenMap;
}

export function renderSidebarTree() {
  if (!dom.sidebarTree) return;
  const childrenMap = collectSidebarFolderChildren();

  const renderNodes = (parentPrefix, depth) => {
    if (depth > 8) return '';
    const children = Array.from(childrenMap.get(parentPrefix) || []).sort((a, b) =>
      getFileName(a.slice(0, -1)).localeCompare(getFileName(b.slice(0, -1)))
    );
    if (children.length === 0) return '';

    return children.map(folderPrefix => {
      const subChildren = childrenMap.get(folderPrefix);
      const hasChildren = Boolean(subChildren && subChildren.size > 0);
      const expanded = state.sidebarExpanded.has(folderPrefix);
      const isActive = state.typeFilter === 'all' && state.currentPrefix === folderPrefix;
      const label = getFileName(folderPrefix.slice(0, -1));
      const indent = 10 + depth * 14;

      return `
        <div class="tree-node ${hasChildren && expanded ? 'is-expanded' : ''}" data-tree-node="${escapeHtml(folderPrefix)}" role="treeitem" aria-expanded="${hasChildren ? String(expanded) : 'false'}">
          <div class="tree-row ${isActive ? 'active' : ''}" style="padding-left:${indent}px">
            ${hasChildren
              ? `<button type="button" class="tree-toggle ${expanded ? 'is-expanded' : ''}" data-tree-toggle="${escapeHtml(folderPrefix)}" aria-label="展开或收起目录">
                   <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                 </button>`
              : `<span class="tree-toggle-spacer" aria-hidden="true"></span>`}
            <button type="button" class="tree-label-btn" data-tree-prefix="${escapeHtml(folderPrefix)}" title="${escapeHtml(folderPrefix)}">
              <span class="tree-folder-icon">${renderSvgIcon('folder', 15)}</span>
              <span class="tree-label-text">${escapeHtml(label)}</span>
            </button>
          </div>
          ${hasChildren
            ? `<div class="tree-children" role="group"><div class="tree-children-inner">${renderNodes(folderPrefix, depth + 1)}</div></div>`
            : ''}
        </div>`;
    }).join('');
  };

  const rootChildren = childrenMap.get('');
  const hasRootChildren = Boolean(rootChildren && rootChildren.size > 0);
  const rootExpanded = state.sidebarExpanded.has('');
  const rootActive = state.typeFilter === 'all' && state.currentPrefix === '';

  dom.sidebarTree.innerHTML = `
    <div class="tree-node ${hasRootChildren && rootExpanded ? 'is-expanded' : ''}" data-tree-node="" role="treeitem" aria-expanded="${hasRootChildren ? String(rootExpanded) : 'false'}">
      <div class="tree-row ${rootActive ? 'active' : ''}" style="padding-left:10px">
        ${hasRootChildren
          ? `<button type="button" class="tree-toggle ${rootExpanded ? 'is-expanded' : ''}" data-tree-toggle="" aria-label="展开或收起根目录">
               <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
             </button>`
          : `<span class="tree-toggle-spacer" aria-hidden="true"></span>`}
        <button type="button" class="tree-label-btn" data-tree-prefix="">
          <span class="tree-folder-icon">${renderSvgIcon('folder', 15)}</span>
          <span class="tree-label-text">根目录</span>
        </button>
      </div>
      ${hasRootChildren
        ? `<div class="tree-children" role="group"><div class="tree-children-inner">${renderNodes('', 1)}</div></div>`
        : ''}
    </div>`;
}

dom.sidebarTree?.addEventListener('click', e => {
  const toggleBtn = e.target.closest('[data-tree-toggle]');
  if (toggleBtn) {
    e.stopPropagation();
    const pfx = toggleBtn.dataset.treeToggle || '';
    const isExpanded = state.sidebarExpanded.has(pfx);
    if (isExpanded) {
      state.sidebarExpanded.delete(pfx);
    } else {
      state.sidebarExpanded.add(pfx);
    }
    const nextExpanded = !isExpanded;
    const node = toggleBtn.closest('.tree-node');
    if (node) {
      node.classList.toggle('is-expanded', nextExpanded);
      node.setAttribute('aria-expanded', String(nextExpanded));
    }
    toggleBtn.classList.toggle('is-expanded', nextExpanded);
    return;
  }

  const navBtn = e.target.closest('[data-tree-prefix]');
  if (navBtn) {
    const pfx = navBtn.dataset.treePrefix || '';
    closeDrawer();
    itemHandlers.onOpenFolder(pfx);
  }
});

// ─── 顶部标题与面包屑 ──────────────────────────────────────────────────────────
function updateTopbarTitle() {
  if (!dom.topbarTitle) return;
  if (state.typeFilter !== 'all') {
    dom.topbarTitle.textContent = TYPE_FILTER_LABELS[state.typeFilter] || '全部文件';
    return;
  }
  if (!state.currentPrefix) {
    dom.topbarTitle.textContent = '全部文件';
    return;
  }
  dom.topbarTitle.textContent = getFileName(state.currentPrefix.slice(0, -1)) || '全部文件';
}

export function renderBreadcrumb(prefix) {
  if (!dom.breadcrumb) return;
  dom.breadcrumb.innerHTML = '';

  const rootBtn = document.createElement('button');
  rootBtn.type = 'button';
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
    btn.type = 'button';
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

  // 手机端路径很长时自动滚到最右侧查看当前目录
  requestAnimationFrame(() => {
    if (dom.breadcrumb) {
      dom.breadcrumb.scrollLeft = dom.breadcrumb.scrollWidth;
    }
  });
}

// ─── 视图数据过滤与排序 ────────────────────────────────────────────────────────
function getDisplayedItems() {
  if (state.typeFilter === 'all' || !Array.isArray(state.allObjects)) {
    return {
      folders: state.folders,
      files: state.files,
      isFiltered: false,
    };
  }
  const matched = state.allObjects.filter(
    obj => obj?.key && !obj.key.endsWith('/') && getFileCategory(obj.key) === state.typeFilter
  );
  return {
    folders: [],
    files: matched,
    isFiltered: true,
  };
}

function getSortedItems() {
  const { folders, files, isFiltered } = getDisplayedItems();
  const { sortKey, sortDir } = state;

  const sortedFolders = [...folders].sort((a, b) => {
    const nameA = getFileName(a).toLowerCase();
    const nameB = getFileName(b).toLowerCase();
    return sortKey === 'name'
      ? (sortDir === 'asc' ? nameA.localeCompare(nameB) : nameB.localeCompare(nameA))
      : 0;
  });

  const sortedFiles = [...files].sort((a, b) => {
    if (sortKey === 'name') {
      const na = getFileName(a.key).toLowerCase();
      const nb = getFileName(b.key).toLowerCase();
      return sortDir === 'asc' ? na.localeCompare(nb) : nb.localeCompare(na);
    }
    if (sortKey === 'size') {
      return sortDir === 'asc' ? (a.size || 0) - (b.size || 0) : (b.size || 0) - (a.size || 0);
    }
    if (sortKey === 'date') {
      const da = a.uploaded ? new Date(a.uploaded) : 0;
      const db = b.uploaded ? new Date(b.uploaded) : 0;
      return sortDir === 'asc' ? da - db : db - da;
    }
    return 0;
  });

  return { sortedFolders, sortedFiles, isFiltered };
}

// ─── 选择联动 & 底部毛玻璃浮动操作条 ───────────────────────────────────────────
export function toggleItemSelection(key) {
  if (state.selectedKeys.has(key)) {
    state.selectedKeys.delete(key);
  } else {
    state.selectedKeys.add(key);
  }
  updateSelectionUI();
  updateRowsSelectionClass();
}

export function clearSelection() {
  if (state.selectedKeys.size === 0) return;
  state.selectedKeys.clear();
  updateSelectionUI();
  updateRowsSelectionClass();
}

export function updateSelectionUI() {
  const { folders, files } = getDisplayedItems();
  const totalItems = folders.length + files.length;
  const count = state.selectedKeys.size;
  const hasSelection = count > 0;

  if (dom.selectAllCheckbox) {
    dom.selectAllCheckbox.checked = totalItems > 0 && count === totalItems;
    dom.selectAllCheckbox.indeterminate = count > 0 && count < totalItems;
  }

  if (dom.selectionBar) {
    dom.selectionBar.hidden = !hasSelection;
    document.body.classList.toggle('has-selection', hasSelection);
  }
  if (dom.selectionCount) {
    dom.selectionCount.textContent = `已选择 ${count} 项`;
  }

  // 顺序严格锁定：下载 → 删除 → 移动 → 重命名（重命名仅选 1 项时显示）
  if (dom.btnBatchDownload) {
    dom.btnBatchDownload.disabled = !hasSelection;
    dom.textBatchDownload.textContent = count > 1 ? `下载 (${count})` : '下载';
  }
  if (dom.btnBatchDelete) {
    dom.btnBatchDelete.disabled = !hasSelection;
    dom.textBatchDelete.textContent = count > 1 ? `删除 (${count})` : '删除';
  }
  if (dom.btnBatchMove) {
    dom.btnBatchMove.disabled = !hasSelection;
    dom.textBatchMove.textContent = count > 1 ? `移动 (${count})` : '移动';
  }
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
  const { folders, files } = getDisplayedItems();
  state.selectedKeys.clear();
  if (shouldSelectAll) {
    folders.forEach(f => state.selectedKeys.add(f));
    files.forEach(f => state.selectedKeys.add(f.key));
  }
  updateSelectionUI();
  updateRowsSelectionClass();
});

// ─── 列表与网格主渲染 ──────────────────────────────────────────────────────────
function syncEmptyHintCopy(hintEl, isFiltered) {
  if (!hintEl) return;
  const titleEl = hintEl.querySelector('.empty-title');
  const subEl = hintEl.querySelector('.empty-sub');
  if (isFiltered) {
    const label = TYPE_FILTER_LABELS[state.typeFilter] || '该分类';
    if (titleEl) titleEl.textContent = `暂无「${label}」文件`;
    if (subEl) subEl.textContent = '可切换左侧其他分类，或返回目录浏览全部内容';
  } else {
    if (titleEl) titleEl.textContent = '当前目录为空';
    if (subEl) subEl.textContent = '拖拽文件到此处，或点击上传按钮添加文件';
  }
}

export function renderFileList() {
  const { sortedFolders, sortedFiles, isFiltered } = getSortedItems();
  const totalCount = sortedFolders.length + sortedFiles.length;

  renderTypeNav();
  renderSidebarTree();
  updateTopbarTitle();
  updateStorageUI();

  if (dom.filterBanner && dom.filterBannerText) {
    dom.filterBanner.hidden = !isFiltered;
    if (isFiltered) {
      const label = TYPE_FILTER_LABELS[state.typeFilter] || '';
      dom.filterBannerText.textContent = `正在全盘筛选「${label}」· 共 ${sortedFiles.length} 个文件`;
    }
  }

  if (dom.fileCount) {
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
  }

  renderedItemMap.clear();

  if (state.viewMode === 'list') {
    renderListView(sortedFolders, sortedFiles, isFiltered);
  } else {
    renderGridView(sortedFolders, sortedFiles, isFiltered);
  }
  updateSelectionUI();
}

function buildRowActionsHtml(isFolder) {
  return `
    <div class="row-actions-wrap">
      <div class="row-hover-actions">
        <button type="button" class="row-action-btn" data-item-action="preview" title="${isFolder ? '打开文件夹' : '预览'}">${ROW_ACTION_ICONS.preview}</button>
        ${isFolder ? '' : `<button type="button" class="row-action-btn" data-item-action="download" title="下载">${ROW_ACTION_ICONS.download}</button>`}
        <button type="button" class="row-action-btn" data-item-action="rename" title="重命名">${ROW_ACTION_ICONS.rename}</button>
        <button type="button" class="row-action-btn" data-item-action="move" title="移动">${ROW_ACTION_ICONS.move}</button>
        <button type="button" class="row-action-btn is-danger" data-item-action="delete" title="删除">${ROW_ACTION_ICONS.delete}</button>
      </div>
      <button type="button" class="btn-row-more" data-item-action="sheet" aria-label="更多操作" title="更多操作">
        ${ROW_ACTION_ICONS.more}
      </button>
    </div>`;
}

function renderListView(folders, files, isFiltered) {
  dom.fileTbody.innerHTML = '';
  const isEmpty = folders.length === 0 && files.length === 0;
  syncEmptyHintCopy(dom.emptyHint, isFiltered);
  dom.emptyHint.hidden = !isEmpty || state.loading;

  let animIndex = 0;

  folders.forEach(folderPrefix => {
    const name = getFileName(folderPrefix) || folderPrefix;
    const isSelected = state.selectedKeys.has(folderPrefix);
    renderedItemMap.set(folderPrefix, { isFolder: true, key: folderPrefix, file: null });

    const tr = document.createElement('tr');
    tr.dataset.key = folderPrefix;
    if (isSelected) tr.classList.add('row-selected');
    if (animIndex < 15) {
      tr.classList.add('stagger-in');
      tr.style.setProperty('--stagger-delay', `${animIndex * 15}ms`);
    }
    animIndex++;

    tr.innerHTML = `
      <td class="col-checkbox">
        <input type="checkbox" class="custom-checkbox item-checkbox" data-key="${escapeHtml(folderPrefix)}" ${isSelected ? 'checked' : ''} aria-label="选择文件夹" />
      </td>
      <td class="col-name">
        <div class="file-name-cell">
          ${renderFileBadge('folder', 'md')}
          <div class="file-name-info">
            <span class="file-name-text folder" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
            <span class="file-meta-sub">文件夹</span>
          </div>
        </div>
      </td>
      <td class="col-size">—</td>
      <td class="col-date">—</td>
      <td class="col-actions">${buildRowActionsHtml(true)}</td>`;

    dom.fileTbody.appendChild(tr);
  });

  files.forEach(file => {
    const name = getFileName(file.key);
    const type = getFileType(file.key);
    const isSelected = state.selectedKeys.has(file.key);
    renderedItemMap.set(file.key, { isFolder: false, key: file.key, file });

    const lastSlash = file.key.lastIndexOf('/');
    const parentDir = lastSlash >= 0 ? file.key.slice(0, lastSlash + 1) : '';
    const subLine = isFiltered && parentDir
      ? `${escapeHtml(parentDir)} · ${formatSize(file.size)} · ${formatDate(file.uploaded)}`
      : `${formatSize(file.size)} · ${formatDate(file.uploaded)}`;

    const tr = document.createElement('tr');
    tr.dataset.key = file.key;
    if (isSelected) tr.classList.add('row-selected');
    if (animIndex < 15) {
      tr.classList.add('stagger-in');
      tr.style.setProperty('--stagger-delay', `${animIndex * 15}ms`);
    }
    animIndex++;

    tr.innerHTML = `
      <td class="col-checkbox">
        <input type="checkbox" class="custom-checkbox item-checkbox" data-key="${escapeHtml(file.key)}" ${isSelected ? 'checked' : ''} aria-label="选择文件" />
      </td>
      <td class="col-name">
        <div class="file-name-cell">
          ${renderFileBadge(type, 'md')}
          <div class="file-name-info">
            <span class="file-name-text" title="${escapeHtml(file.key)}">${escapeHtml(name)}</span>
            <span class="file-meta-sub">${subLine}</span>
          </div>
        </div>
      </td>
      <td class="col-size">${formatSize(file.size)}</td>
      <td class="col-date">${formatDate(file.uploaded)}</td>
      <td class="col-actions">${buildRowActionsHtml(false)}</td>`;

    dom.fileTbody.appendChild(tr);
  });

  document.querySelectorAll('.file-table th[data-sort]').forEach(th => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.sort === state.sortKey) {
      th.classList.add(state.sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
    }
  });
}

function buildGridActionsHtml(isFolder) {
  return `
    <div class="grid-card-actions">
      <div class="grid-hover-actions">
        ${isFolder ? '' : `<button type="button" class="row-action-btn" data-item-action="download" title="下载">${ROW_ACTION_ICONS.download}</button>`}
        <button type="button" class="row-action-btn" data-item-action="rename" title="重命名">${ROW_ACTION_ICONS.rename}</button>
        <button type="button" class="row-action-btn" data-item-action="move" title="移动">${ROW_ACTION_ICONS.move}</button>
        <button type="button" class="row-action-btn is-danger" data-item-action="delete" title="删除">${ROW_ACTION_ICONS.delete}</button>
      </div>
      <button type="button" class="grid-more-btn" data-item-action="sheet" aria-label="更多操作" title="更多操作">
        ${ROW_ACTION_ICONS.more}
      </button>
    </div>`;
}

function renderGridView(folders, files, isFiltered) {
  dom.fileGrid.innerHTML = '';
  const isEmpty = folders.length === 0 && files.length === 0;
  syncEmptyHintCopy(dom.emptyHintGrid, isFiltered);
  dom.emptyHintGrid.hidden = !isEmpty || state.loading;

  let animIndex = 0;

  folders.forEach(folderPrefix => {
    const name = getFileName(folderPrefix) || folderPrefix;
    const isSelected = state.selectedKeys.has(folderPrefix);
    renderedItemMap.set(folderPrefix, { isFolder: true, key: folderPrefix, file: null });

    const item = document.createElement('div');
    item.className = 'grid-item';
    item.dataset.key = folderPrefix;
    if (isSelected) item.classList.add('card-selected');
    if (animIndex < 15) {
      item.classList.add('stagger-in');
      item.style.setProperty('--stagger-delay', `${animIndex * 15}ms`);
    }
    animIndex++;

    item.innerHTML = `
      <input type="checkbox" class="custom-checkbox grid-item-checkbox item-checkbox" data-key="${escapeHtml(folderPrefix)}" ${isSelected ? 'checked' : ''} aria-label="选择文件夹" />
      ${buildGridActionsHtml(true)}
      <div class="grid-media-box">
        ${renderFileBadge('folder', 'lg')}
      </div>
      <span class="grid-item-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
      <span class="grid-item-sub">文件夹</span>`;

    dom.fileGrid.appendChild(item);
  });

  files.forEach(file => {
    const name = getFileName(file.key);
    const type = getFileType(file.key);
    const isSelected = state.selectedKeys.has(file.key);
    renderedItemMap.set(file.key, { isFolder: false, key: file.key, file });

    const showThumb = isThumbnailSupported(file.key);
    const mediaHtml = showThumb
      ? `<div class="grid-thumb-wrap">
           <img class="grid-thumb" src="${escapeHtml(buildMediaUrl(file.key, file.etag || file.uploaded))}" alt="${escapeHtml(name)}" loading="lazy" decoding="async" />
           <div class="grid-thumb-fallback" hidden>${renderFileBadge(type, 'lg')}</div>
         </div>`
      : renderFileBadge(type, 'lg');

    const lastSlash = file.key.lastIndexOf('/');
    const parentDir = lastSlash >= 0 ? file.key.slice(0, lastSlash + 1) : '';
    const subText = isFiltered && parentDir
      ? `${escapeHtml(parentDir)} · ${formatSize(file.size)}`
      : formatSize(file.size);

    const item = document.createElement('div');
    item.className = 'grid-item';
    item.dataset.key = file.key;
    if (isSelected) item.classList.add('card-selected');
    if (animIndex < 15) {
      item.classList.add('stagger-in');
      item.style.setProperty('--stagger-delay', `${animIndex * 15}ms`);
    }
    animIndex++;

    item.innerHTML = `
      <input type="checkbox" class="custom-checkbox grid-item-checkbox item-checkbox" data-key="${escapeHtml(file.key)}" ${isSelected ? 'checked' : ''} aria-label="选择文件" />
      ${buildGridActionsHtml(false)}
      <div class="grid-media-box">
        ${mediaHtml}
      </div>
      <span class="grid-item-name" title="${escapeHtml(file.key)}">${escapeHtml(name)}</span>
      <span class="grid-item-sub">${subText}</span>`;

    dom.fileGrid.appendChild(item);
  });
}

// 网格缩略图加载失败时无声回退到文件类型彩色徽标（捕获阶段监听 error）
dom.fileGrid?.addEventListener('error', e => {
  const img = e.target;
  if (!img || !img.classList?.contains('grid-thumb')) return;
  img.hidden = true;
  const fallback = img.nextElementSibling;
  if (fallback && fallback.classList.contains('grid-thumb-fallback')) {
    fallback.hidden = false;
  }
}, true);

// 列表与网格统一事件委托
function handleContainerClick(e, rowSelector) {
  const containerEl = e.target.closest(rowSelector);
  if (!containerEl) return;
  const key = containerEl.dataset.key;
  const entry = renderedItemMap.get(key);
  if (!entry) return;

  const cb = e.target.closest('.item-checkbox');
  if (cb) {
    e.stopPropagation();
    toggleItemSelection(key);
    return;
  }

  const cbCell = e.target.closest('.col-checkbox');
  if (cbCell) {
    e.stopPropagation();
    toggleItemSelection(key);
    return;
  }

  const actionBtn = e.target.closest('[data-item-action]');
  if (actionBtn) {
    e.stopPropagation();
    const action = actionBtn.dataset.itemAction;
    if (action === 'sheet') {
      itemHandlers.onOpenRowSheet(entry);
    } else if (action === 'preview') {
      if (entry.isFolder) itemHandlers.onOpenFolder(entry.key);
      else itemHandlers.onOpenPreview(entry.file);
    } else {
      itemHandlers.onItemAction(action, key, entry);
    }
    return;
  }

  if (entry.isFolder) {
    itemHandlers.onOpenFolder(entry.key);
  } else {
    itemHandlers.onOpenPreview(entry.file);
  }
}

dom.fileTbody?.addEventListener('click', e => handleContainerClick(e, 'tr[data-key]'));
dom.fileGrid?.addEventListener('click', e => handleContainerClick(e, '.grid-item[data-key]'));

export function applyViewMode() {
  const isList = state.viewMode === 'list';
  dom.fileListView.hidden = !isList || state.loading;
  dom.fileGridView.hidden = isList || state.loading;
  dom.btnViewList.classList.toggle('active', isList);
  dom.btnViewGrid.classList.toggle('active', !isList);
}
