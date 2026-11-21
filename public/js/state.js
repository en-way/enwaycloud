/**
 * public/js/state.js
 * 全局应用状态、DOM 引用缓存与全盘虚拟树持久化读写
 */

import { DIR_CACHE_TTL, STORAGE_TREE_KEY, STORAGE_USAGE_KEY } from './config.js';

// 清理历史版本遗留在 localStorage 中的明文密码（安全迁移）
try {
  localStorage.removeItem('drive_password');
} catch (_) {}

export function loadVirtualTreeFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_TREE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (Date.now() - data.timestamp < DIR_CACHE_TTL && Array.isArray(data.allObjects)) {
      return data;
    }
  } catch (_) {}
  return null;
}

const initialTree = loadVirtualTreeFromStorage();

function loadInitialUsedBytes() {
  try {
    return parseInt(localStorage.getItem(STORAGE_USAGE_KEY) || '0', 10) || 0;
  } catch (_) {
    return 0;
  }
}

export const state = {
  currentPrefix:  '',
  files:          [],
  folders:        [],
  selectedKeys:   new Set(),
  viewMode:       localStorage.getItem('view_mode') || 'list',
  sortKey:        'name',
  sortDir:        'asc',
  uploadQueue:    [],
  previewItem:    null,
  loading:        false,
  allObjects:     initialTree ? initialTree.allObjects : null,
  isVirtualTree:  initialTree ? Boolean(initialTree.isVirtualTree) : false,
  totalUsedBytes: loadInitialUsedBytes(),
};

export function saveVirtualTreeToStorage() {
  try {
    if (state.allObjects) {
      localStorage.setItem(STORAGE_TREE_KEY, JSON.stringify({
        allObjects: state.allObjects,
        isVirtualTree: state.isVirtualTree,
        timestamp: Date.now(),
      }));
    } else {
      localStorage.removeItem(STORAGE_TREE_KEY);
    }
  } catch (_) {}
}

export const inFlightRequests = new Map();

export const $ = id => document.getElementById(id);

export const dom = {
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
