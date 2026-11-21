/**
 * public/js/api.js
 * 同源 Cookie 会话网络请求、媒体直链构造、Toast 通知与二次确认弹窗
 */

import { API, escapeHtml, getFileName } from './config.js';
import { dom } from './state.js';

export function buildMediaUrl(key, version) {
  const url = new URL(API.file, location.origin);
  url.searchParams.set('key', key);
  if (version) {
    url.searchParams.set('v', String(version));
  }
  return url.toString();
}

export function buildDownloadUrl(key) {
  const url = new URL(API.file, location.origin);
  url.searchParams.set('key', key);
  url.searchParams.set('download', '1');
  return url.toString();
}

export async function apiFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    credentials: 'same-origin',
  });
}

export function downloadFile(key) {
  const url = buildDownloadUrl(key);
  const a = document.createElement('a');
  a.href = url;
  a.download = getFileName(key);
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export function showToast(message, type = 'info', duration = 3000) {
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

export function showConfirm(title, message) {
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
