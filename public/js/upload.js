/**
 * public/js/upload.js
 * 文件上传队列、50MB 分块并发上传、随时取消上传与 R2 孤儿分块回收
 */

import {
  API,
  CHUNK_SIZE,
  MULTIPART_THRESHOLD,
  MAX_CONCURRENT_CHUNKS,
  MAX_CONCURRENT_FILES,
  formatSize,
  getFileType,
  uid,
  escapeHtml,
  renderSvgIcon,
} from './config.js';
import { state, dom, $ } from './state.js';
import { apiFetch, showToast } from './api.js';
import { optimisticAddFile } from './cache.js';

dom.btnUpload.addEventListener('click', () => dom.fileInput.click());

dom.fileInput.addEventListener('change', e => {
  const files = Array.from(e.target.files || []);
  if (files.length) enqueueFiles(files);
  dom.fileInput.value = '';
});

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

function syncUploadPanelSummary() {
  const total = state.uploadQueue.length;
  const active = state.uploadQueue.filter(i => i.status === 'pending' || i.status === 'uploading').length;
  if (dom.uploadPanelBadge) {
    dom.uploadPanelBadge.textContent = active > 0 ? `${active}/${total}` : `${total}`;
  }
  if (dom.uploadPanel) {
    dom.uploadPanel.classList.toggle('is-collapsed', state.uploadPanelCollapsed);
  }
  if (dom.btnToggleUploadPanel) {
    dom.btnToggleUploadPanel.setAttribute('aria-expanded', String(!state.uploadPanelCollapsed));
  }
}

export function enqueueFiles(files) {
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
  state.uploadPanelCollapsed = false;
  dom.uploadPanel.hidden = false;
  renderUploadPanel();
  processUploadQueue();
}

export function cancelUpload(id) {
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

dom.uploadList.addEventListener('click', e => {
  const cancelBtn = e.target.closest('[data-cancel-id]');
  if (cancelBtn) {
    e.stopPropagation();
    cancelUpload(cancelBtn.dataset.cancelId);
  }
});

function renderUploadPanel() {
  dom.uploadList.innerHTML = '';
  syncUploadPanelSummary();
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
        <span class="upload-item-status status-${item.status}">${escapeHtml(statusText)}</span>
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
  syncUploadPanelSummary();
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
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', contentType);

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
      else reject(new Error(`HTTP ${xhr.status}`));
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
  const abortController = new AbortController();
  item.abort = () => {
    abortController.abort();
  };

  const createRes = await apiFetch(
    `${API.file}?key=${encodeURIComponent(key)}&action=createMultipart`,
    {
      method: 'POST',
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
    apiFetch(
      `${API.file}?key=${encodeURIComponent(key)}&action=abortMultipart&uploadId=${encodeURIComponent(uploadId)}`,
      { method: 'DELETE' }
    ).catch(() => {});
    throw err;
  }
}

dom.btnToggleUploadPanel?.addEventListener('click', () => {
  state.uploadPanelCollapsed = !state.uploadPanelCollapsed;
  syncUploadPanelSummary();
});

dom.btnClearDone?.addEventListener('click', () => {
  state.uploadQueue = state.uploadQueue.filter(i => i.status !== 'done' && i.status !== 'error' && i.status !== 'canceled');
  if (state.uploadQueue.length === 0) {
    state.uploadPanelCollapsed = false;
    dom.uploadPanel.hidden = true;
    syncUploadPanelSummary();
  } else {
    renderUploadPanel();
  }
});

dom.btnClosePanel?.addEventListener('click', () => {
  dom.uploadPanel.hidden = true;
});

window.addEventListener('beforeunload', e => {
  const hasActiveUploads = state.uploadQueue.some(i => i.status === 'uploading');
  if (hasActiveUploads) {
    e.preventDefault();
    e.returnValue = '';
  }
});
