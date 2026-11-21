/**
 * public/js/preview.js
 * 全端多格式在线预览引擎（PDF / Word / HEIC / Excel / ZIP / 文本 / 音视频），带会话并发取消与安全沙箱
 */

import {
  API,
  MAX_TEXT_PREVIEW_BYTES,
  formatSize,
  formatDate,
  getFileName,
  getExt,
  getFileType,
  escapeHtml,
  renderSvgIcon,
} from './config.js';
import { state, dom } from './state.js';
import { apiFetch, buildMediaUrl, downloadFile, showToast, showConfirm } from './api.js';
import {
  textPreviewCache,
  heicPreviewCache,
  xlsxPreviewCache,
  optimisticRemoveItems,
} from './cache.js';

const loadedScripts = new Set();
export function loadScript(src) {
  if (loadedScripts.has(src)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => { loadedScripts.add(src); resolve(); };
    s.onerror = () => reject(new Error('无法加载本地依赖库：' + src));
    document.head.appendChild(s);
  });
}

let currentPdfCleanup = null;
let previewSessionId = 0;
let currentPreviewAbort = null;

function isPreviewSessionActive(sessionId) {
  return sessionId === previewSessionId && !dom.previewModal.hidden;
}

async function renderPdfPreview(file, mediaUrl, sessionId, signal) {
  dom.previewBody.innerHTML = `
    <div class="preview-loading-tip">
      <div class="spinner-modern"></div>
      <p>正在载入 PDF 高清引擎...</p>
    </div>`;

  try {
    await loadScript('/vendor/pdfjs/pdf.min.js');
    if (!isPreviewSessionActive(sessionId)) return;

    if (window.pdfjsLib) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
    }

    const res = await apiFetch(mediaUrl, { signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.arrayBuffer();
    if (!isPreviewSessionActive(sessionId)) return;

    const loadingTask = window.pdfjsLib.getDocument({ data });
    const pdfDoc = await loadingTask.promise;
    if (!isPreviewSessionActive(sessionId)) {
      pdfDoc.destroy?.();
      return;
    }

    let currentPageNum = 1;
    const totalPages = pdfDoc.numPages;
    let currentScale = 1.25;
    let isRendering = false;
    let pendingPageNum = null;

    dom.previewBody.innerHTML = `
      <div class="preview-pdf-container">
        <div class="pdf-canvas-wrap" id="pdf-canvas-wrap">
          <canvas id="pdf-canvas"></canvas>
        </div>
        <div class="pdf-controls-pill">
          <button class="btn-icon" id="btn-pdf-prev" title="上一页" ${currentPageNum <= 1 ? 'disabled' : ''}>◀</button>
          <span class="pdf-page-indicator" id="pdf-page-indicator">${currentPageNum} / ${totalPages}</span>
          <button class="btn-icon" id="btn-pdf-next" title="下一页" ${currentPageNum >= totalPages ? 'disabled' : ''}>▶</button>
          <div class="pdf-divider"></div>
          <button class="btn-icon" id="btn-pdf-zoom-out" title="缩小">-</button>
          <button class="btn-icon" id="btn-pdf-fit" title="自适应宽度" style="font-size:11px;width:auto;padding:0 6px">适应</button>
          <button class="btn-icon" id="btn-pdf-zoom-in" title="放大">+</button>
        </div>
      </div>`;

    const canvas = dom.previewBody.querySelector('#pdf-canvas');
    const ctx = canvas.getContext('2d');
    const wrap = dom.previewBody.querySelector('#pdf-canvas-wrap');
    const indicator = dom.previewBody.querySelector('#pdf-page-indicator');
    const btnPrev = dom.previewBody.querySelector('#btn-pdf-prev');
    const btnNext = dom.previewBody.querySelector('#btn-pdf-next');
    const btnZoomOut = dom.previewBody.querySelector('#btn-pdf-zoom-out');
    const btnZoomIn = dom.previewBody.querySelector('#btn-pdf-zoom-in');
    const btnFit = dom.previewBody.querySelector('#btn-pdf-fit');

    async function renderPage(num) {
      if (!isPreviewSessionActive(sessionId)) return;
      isRendering = true;
      const page = await pdfDoc.getPage(num);
      if (!isPreviewSessionActive(sessionId)) return;

      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: currentScale });

      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = Math.floor(viewport.width) + 'px';
      canvas.style.height = Math.floor(viewport.height) + 'px';

      const renderContext = {
        canvasContext: ctx,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
        viewport,
      };

      await page.render(renderContext).promise;
      isRendering = false;

      if (!isPreviewSessionActive(sessionId)) return;

      if (pendingPageNum !== null) {
        const next = pendingPageNum;
        pendingPageNum = null;
        renderPage(next);
      }

      indicator.textContent = `${num} / ${totalPages}`;
      btnPrev.disabled = num <= 1;
      btnNext.disabled = num >= totalPages;
    }

    function queueRenderPage(num) {
      if (isRendering) {
        pendingPageNum = num;
      } else {
        renderPage(num);
      }
    }

    btnPrev.addEventListener('click', () => {
      if (currentPageNum <= 1) return;
      currentPageNum--;
      queueRenderPage(currentPageNum);
    });

    btnNext.addEventListener('click', () => {
      if (currentPageNum >= totalPages) return;
      currentPageNum++;
      queueRenderPage(currentPageNum);
    });

    btnZoomIn.addEventListener('click', () => {
      if (currentScale >= 3.0) return;
      currentScale += 0.25;
      queueRenderPage(currentPageNum);
    });

    btnZoomOut.addEventListener('click', () => {
      if (currentScale <= 0.5) return;
      currentScale = Math.max(0.5, currentScale - 0.25);
      queueRenderPage(currentPageNum);
    });

    btnFit.addEventListener('click', async () => {
      const page = await pdfDoc.getPage(currentPageNum);
      const vp = page.getViewport({ scale: 1 });
      const wrapWidth = wrap.clientWidth - 48;
      if (wrapWidth > 0 && vp.width > 0) {
        currentScale = Math.max(0.4, wrapWidth / vp.width);
        queueRenderPage(currentPageNum);
      }
    });

    const onKeydown = e => {
      if (!isPreviewSessionActive(sessionId)) return;
      if (e.key === 'ArrowLeft') {
        if (currentPageNum > 1) { currentPageNum--; queueRenderPage(currentPageNum); }
      } else if (e.key === 'ArrowRight') {
        if (currentPageNum < totalPages) { currentPageNum++; queueRenderPage(currentPageNum); }
      }
    };
    window.addEventListener('keydown', onKeydown);

    currentPdfCleanup = () => {
      window.removeEventListener('keydown', onKeydown);
      pdfDoc.destroy?.();
    };

    renderPage(currentPageNum);
  } catch (err) {
    if (err.name === 'AbortError' || !isPreviewSessionActive(sessionId)) return;
    console.error('PDF.js render error:', err);
    dom.previewBody.innerHTML = '';
    const iframe = document.createElement('iframe');
    iframe.className = 'preview-pdf';
    iframe.setAttribute('sandbox', 'allow-same-origin');
    iframe.src = mediaUrl;
    iframe.title = getFileName(file.key);
    dom.previewBody.appendChild(iframe);
  }
}

async function renderDocxPreview(file, mediaUrl, sessionId, signal) {
  dom.previewBody.innerHTML = `
    <div class="preview-loading-tip">
      <div class="spinner-modern"></div>
      <p>正在解析 Word 高保真文档...</p>
    </div>`;

  try {
    await loadScript('/vendor/jszip.min.js');
    await loadScript('/vendor/docx-preview.min.js');
    if (!isPreviewSessionActive(sessionId)) return;

    const res = await apiFetch(mediaUrl, { signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    if (!isPreviewSessionActive(sessionId)) return;

    const wrap = document.createElement('div');
    wrap.className = 'preview-docx-wrap';
    dom.previewBody.innerHTML = '';
    dom.previewBody.appendChild(wrap);

    await window.docx.renderAsync(blob, wrap, null, {
      className: 'docx',
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: false,
      breakPages: true,
    });
  } catch (err) {
    if (err.name === 'AbortError' || !isPreviewSessionActive(sessionId)) return;
    dom.previewBody.innerHTML = `
      <div style="text-align:center;padding:48px 20px;color:#86868b">
        <div style="margin-bottom:16px">${renderSvgIcon('word', 56)}</div>
        <p style="font-size:15px;color:#ff3b30;margin-bottom:8px">Word 文档解析失败</p>
        <p style="font-size:13px;margin-bottom:20px">${escapeHtml(err.message)}</p>
        <button class="btn btn-primary" id="btn-modal-dl">⬇️ 立即下载该文件查看</button>
      </div>`;
    dom.previewBody.querySelector('#btn-modal-dl')?.addEventListener('click', () => downloadFile(file.key));
  }
}

async function renderHeicPreview(file, mediaUrl, sessionId, signal) {
  if (heicPreviewCache.has(file.key)) {
    const img = document.createElement('img');
    img.alt = getFileName(file.key);
    img.src = heicPreviewCache.get(file.key);
    dom.previewBody.innerHTML = '';
    dom.previewBody.appendChild(img);
    return;
  }

  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  if (isSafari) {
    const img = document.createElement('img');
    img.alt = getFileName(file.key);
    img.src = mediaUrl;
    img.style.opacity = '0';
    img.style.transition = 'opacity 0.25s ease';
    img.onload = () => { img.style.opacity = '1'; };
    dom.previewBody.innerHTML = '';
    dom.previewBody.appendChild(img);
    return;
  }

  dom.previewBody.innerHTML = `
    <div class="preview-loading-tip">
      <div class="spinner-modern"></div>
      <p>正在解码 HEIC 高清图像...</p>
    </div>`;

  try {
    await loadScript('/vendor/heic2any.min.js');
    if (!isPreviewSessionActive(sessionId)) return;

    const res = await apiFetch(mediaUrl, { signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    if (!isPreviewSessionActive(sessionId)) return;

    const conversionResult = await window.heic2any({
      blob,
      toType: 'image/jpeg',
      quality: 0.85,
    });
    const resultBlob = Array.isArray(conversionResult) ? conversionResult[0] : conversionResult;
    const objectUrl = URL.createObjectURL(resultBlob);
    heicPreviewCache.set(file.key, objectUrl);

    if (!isPreviewSessionActive(sessionId)) return;

    const img = document.createElement('img');
    img.alt = getFileName(file.key);
    img.src = objectUrl;
    img.style.opacity = '0';
    img.style.transition = 'opacity 0.25s ease';
    img.onload = () => { img.style.opacity = '1'; };

    dom.previewBody.innerHTML = '';
    dom.previewBody.appendChild(img);
  } catch (err) {
    if (err.name === 'AbortError' || !isPreviewSessionActive(sessionId)) return;
    dom.previewBody.innerHTML = `
      <div style="text-align:center;padding:48px 20px;color:#86868b">
        <div style="margin-bottom:16px">${renderSvgIcon('image', 56)}</div>
        <p style="font-size:15px;color:#ff3b30;margin-bottom:8px">HEIC 图像解码失败</p>
        <p style="font-size:13px;margin-bottom:20px">${escapeHtml(err.message)}</p>
        <button class="btn btn-primary" id="btn-modal-dl">⬇️ 立即下载该文件</button>
      </div>`;
    dom.previewBody.querySelector('#btn-modal-dl')?.addEventListener('click', () => downloadFile(file.key));
  }
}

async function renderExcelPreview(file, mediaUrl, sessionId, signal) {
  dom.previewBody.innerHTML = `
    <div class="preview-loading-tip">
      <div class="spinner-modern"></div>
      <p>正在解析 Excel 表格数据...</p>
    </div>`;

  try {
    await loadScript('/vendor/xlsx.full.min.js');
    if (!isPreviewSessionActive(sessionId)) return;

    let buffer = xlsxPreviewCache.get(file.key);
    if (!buffer) {
      const res = await apiFetch(mediaUrl, { signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      buffer = await res.arrayBuffer();
      xlsxPreviewCache.set(file.key, buffer);
    }
    if (!isPreviewSessionActive(sessionId)) return;

    const workbook = window.XLSX.read(buffer, { type: 'array' });
    const sheetNames = workbook.SheetNames || [];
    if (sheetNames.length === 0) throw new Error('工作簿中无有效表格');

    dom.previewBody.innerHTML = `
      <div class="preview-xlsx-wrap">
        <div class="xlsx-sheet-tabs" id="xlsx-sheet-tabs"></div>
        <div class="xlsx-table-container" id="xlsx-table-container"></div>
        <div class="xlsx-table-footer" id="xlsx-table-footer"></div>
      </div>`;

    const tabsWrap = dom.previewBody.querySelector('#xlsx-sheet-tabs');
    const tableWrap = dom.previewBody.querySelector('#xlsx-table-container');
    const footerWrap = dom.previewBody.querySelector('#xlsx-table-footer');

    function showSheet(name) {
      tabsWrap.querySelectorAll('.xlsx-sheet-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.name === name);
      });

      const worksheet = workbook.Sheets[name];
      if (!worksheet) {
        tableWrap.innerHTML = '<div style="padding:20px;color:#86868b">该工作表为空</div>';
        footerWrap.textContent = '';
        return;
      }

      const data = window.XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
      const maxRows = 500;
      const displayRows = data.slice(0, maxRows);

      let html = '<table class="xlsx-table"><tbody>';
      displayRows.forEach((row, rIdx) => {
        html += '<tr>';
        const isHeader = rIdx === 0;
        row.forEach(cell => {
          const tag = isHeader ? 'th' : 'td';
          html += `<${tag}>${escapeHtml(String(cell != null ? cell : ''))}</${tag}>`;
        });
        html += '</tr>';
      });
      html += '</tbody></table>';

      tableWrap.innerHTML = html;
      footerWrap.textContent = data.length > maxRows
        ? `当前展示前 ${maxRows} 行（共 ${data.length} 行），如需完整编辑请下载文件`
        : `共 ${data.length} 行`;
    }

    sheetNames.forEach((sName, idx) => {
      const tab = document.createElement('button');
      tab.className = `xlsx-sheet-tab ${idx === 0 ? 'active' : ''}`;
      tab.textContent = sName;
      tab.dataset.name = sName;
      tab.addEventListener('click', () => showSheet(sName));
      tabsWrap.appendChild(tab);
    });

    showSheet(sheetNames[0]);
  } catch (err) {
    if (err.name === 'AbortError' || !isPreviewSessionActive(sessionId)) return;
    dom.previewBody.innerHTML = `
      <div style="text-align:center;padding:48px 20px;color:#86868b">
        <div style="margin-bottom:16px">${renderSvgIcon('excel', 56)}</div>
        <p style="font-size:15px;color:#ff3b30;margin-bottom:8px">Excel 表格解析失败</p>
        <p style="font-size:13px;margin-bottom:20px">${escapeHtml(err.message)}</p>
        <button class="btn btn-primary" id="btn-modal-dl">⬇️ 立即下载该文件</button>
      </div>`;
    dom.previewBody.querySelector('#btn-modal-dl')?.addEventListener('click', () => downloadFile(file.key));
  }
}

async function renderZipPreview(file, mediaUrl, sessionId, signal) {
  dom.previewBody.innerHTML = `
    <div class="preview-loading-tip">
      <div class="spinner-modern"></div>
      <p>正在读取压缩包目录树...</p>
    </div>`;

  try {
    await loadScript('/vendor/jszip.min.js');
    if (!isPreviewSessionActive(sessionId)) return;

    const res = await apiFetch(mediaUrl, { signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    if (!isPreviewSessionActive(sessionId)) return;

    const zip = await window.JSZip.loadAsync(blob);
    if (!isPreviewSessionActive(sessionId)) return;

    const entries = [];
    let totalUncompressed = 0;
    let fileCount = 0;
    let folderCount = 0;

    zip.forEach((relPath, entry) => {
      const isDir = entry.dir || relPath.endsWith('/');
      const size = entry._data ? (entry._data.uncompressedSize || 0) : 0;
      if (isDir) {
        folderCount++;
      } else {
        fileCount++;
        totalUncompressed += size;
      }
      entries.push({
        path: relPath,
        isDir,
        size,
        date: entry.date,
      });
    });

    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.path.localeCompare(b.path);
    });

    dom.previewBody.innerHTML = `
      <div class="preview-zip-wrap">
        <div class="zip-summary-header">
          <span class="zip-summary-badge">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 8v13H3V8"/>
              <path d="M1 3h22v5H1z"/>
              <path d="M10 12h4"/>
            </svg>
            包含 ${fileCount} 个文件，${folderCount} 个目录 · 解压约 ${formatSize(totalUncompressed)}
          </span>
          <button class="btn btn-secondary btn-xs" id="btn-zip-dl">下载整包</button>
        </div>
        <div class="zip-list-container" id="zip-list-container"></div>
      </div>`;

    dom.previewBody.querySelector('#btn-zip-dl')?.addEventListener('click', () => downloadFile(file.key));

    const listWrap = dom.previewBody.querySelector('#zip-list-container');
    let listHtml = '';
    entries.forEach(e => {
      const icon = e.isDir ? renderSvgIcon('folder', 16) : renderSvgIcon(getFileType(e.path), 16);
      const sizeText = e.isDir ? '文件夹' : formatSize(e.size);
      const dateText = e.date ? formatDate(e.date.toISOString()) : '';
      listHtml += `
        <div class="zip-entry-row">
          <div class="zip-entry-left">
            ${icon}
            <span title="${escapeHtml(e.path)}">${escapeHtml(e.path)}</span>
          </div>
          <div class="zip-entry-meta">
            <span>${sizeText}</span>
            ${dateText ? `<span style="margin-left:12px">${dateText}</span>` : ''}
          </div>
        </div>`;
    });
    listWrap.innerHTML = listHtml;
  } catch (err) {
    if (err.name === 'AbortError' || !isPreviewSessionActive(sessionId)) return;
    dom.previewBody.innerHTML = `
      <div style="text-align:center;padding:48px 20px;color:#86868b">
        <div style="margin-bottom:16px">${renderSvgIcon('zip', 56)}</div>
        <p style="font-size:15px;color:#ff3b30;margin-bottom:8px">压缩包解析失败</p>
        <p style="font-size:13px;margin-bottom:20px">${escapeHtml(err.message)}</p>
        <button class="btn btn-primary" id="btn-modal-dl">⬇️ 立即下载该文件</button>
      </div>`;
    dom.previewBody.querySelector('#btn-modal-dl')?.addEventListener('click', () => downloadFile(file.key));
  }
}

export async function openPreview(file) {
  if (currentPreviewAbort) {
    try { currentPreviewAbort.abort(); } catch (_) {}
  }
  if (currentPdfCleanup) {
    try { currentPdfCleanup(); } catch (_) {}
    currentPdfCleanup = null;
  }

  const sessionId = ++previewSessionId;
  const abortController = new AbortController();
  currentPreviewAbort = abortController;

  state.previewItem = file;
  const name = getFileName(file.key);
  const type = getFileType(file.key);
  const ext = getExt(file.key);

  dom.previewIcon.innerHTML = renderSvgIcon(type, 26);
  dom.previewFilename.textContent = name;
  dom.previewMeta.textContent = `${formatSize(file.size)}${file.uploaded ? ' · ' + formatDate(file.uploaded) : ''}`;
  dom.previewBody.innerHTML = '';

  dom.previewModal.hidden = false;
  document.body.style.overflow = 'hidden';

  const mediaUrl = buildMediaUrl(file.key, file.etag || file.uploaded);

  if (ext === 'heic' || ext === 'heif') {
    await renderHeicPreview(file, mediaUrl, sessionId, abortController.signal);
  } else if (type === 'image') {
    const img = document.createElement('img');
    img.alt = name;
    img.src = mediaUrl;
    img.style.opacity = '0';
    img.style.transition = 'opacity 0.25s ease';
    img.onload = () => { img.style.opacity = '1'; };
    dom.previewBody.appendChild(img);
  } else if (type === 'video') {
    const video = document.createElement('video');
    video.controls = true;
    video.autoplay = false;
    video.preload = 'metadata';
    video.src = mediaUrl;
    dom.previewBody.appendChild(video);
  } else if (type === 'audio') {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:40px;color:#fff;';
    wrap.innerHTML = `${renderSvgIcon('audio', 64)}<p style="font-size:15px;font-weight:600">${escapeHtml(name)}</p>`;
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = mediaUrl;
    audio.style.width = 'min(440px, 90vw)';
    wrap.appendChild(audio);
    dom.previewBody.appendChild(wrap);
  } else if (type === 'text' || type === 'code') {
    if (file.size > MAX_TEXT_PREVIEW_BYTES) {
      dom.previewBody.innerHTML = `
        <div style="text-align:center;padding:48px 20px;color:#86868b">
          <div style="margin-bottom:16px">${renderSvgIcon(type, 56)}</div>
          <p style="font-size:16px;color:#e5e5ea;font-weight:600;margin-bottom:8px">文本文件较大 (${formatSize(file.size)})</p>
          <p style="font-size:13px;color:#86868b;margin-bottom:24px">为保障浏览器响应流畅度，超过 2 MB 的大文本暂不直接渲染全文，请下载后在本地查看。</p>
          <button class="btn btn-primary" id="btn-modal-dl">⬇️ 立即下载该文件</button>
        </div>`;
      dom.previewBody.querySelector('#btn-modal-dl')?.addEventListener('click', () => downloadFile(file.key));
    } else if (textPreviewCache.has(file.key)) {
      const wrap = document.createElement('div');
      wrap.className = 'preview-text-wrap';
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = textPreviewCache.get(file.key);
      pre.appendChild(code);
      wrap.appendChild(pre);
      dom.previewBody.innerHTML = '';
      dom.previewBody.appendChild(wrap);
    } else {
      dom.previewBody.innerHTML = '<div style="color:#86868b;padding:24px">正在加载文本内容...</div>';
      try {
        const res = await apiFetch(mediaUrl, { signal: abortController.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text();
        textPreviewCache.set(file.key, text);
        if (!isPreviewSessionActive(sessionId)) return;
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
        if (err.name === 'AbortError' || !isPreviewSessionActive(sessionId)) return;
        dom.previewBody.innerHTML = `<div style="color:#ff3b30;padding:24px">加载失败：${escapeHtml(err.message)}</div>`;
      }
    }
  } else if (type === 'pdf') {
    await renderPdfPreview(file, mediaUrl, sessionId, abortController.signal);
  } else if (type === 'word') {
    if (ext === 'docx') {
      await renderDocxPreview(file, mediaUrl, sessionId, abortController.signal);
    } else {
      dom.previewBody.innerHTML = `
        <div style="text-align:center;padding:48px 20px;color:#86868b">
          <div style="margin-bottom:16px">${renderSvgIcon('word', 56)}</div>
          <p style="font-size:16px;color:#e5e5ea;font-weight:600;margin-bottom:8px">旧版 Word (.doc) 格式暂不支持在线直接预览</p>
          <p style="font-size:13px;color:#86868b;margin-bottom:24px">.doc 属于早期复合二进制格式，建议另存为新版 .docx 格式上传预览，或直接下载在本地查看。</p>
          <button class="btn btn-primary" id="btn-modal-dl">⬇️ 立即下载该文件</button>
        </div>`;
      dom.previewBody.querySelector('#btn-modal-dl')?.addEventListener('click', () => downloadFile(file.key));
    }
  } else if (type === 'excel') {
    await renderExcelPreview(file, mediaUrl, sessionId, abortController.signal);
  } else if (type === 'zip') {
    await renderZipPreview(file, mediaUrl, sessionId, abortController.signal);
  } else {
    dom.previewBody.innerHTML = `
      <div style="text-align:center;padding:48px 20px;color:#86868b">
        <div style="margin-bottom:16px">${renderSvgIcon(type, 56)}</div>
        <p style="font-size:15px;color:#e5e5ea;margin-bottom:6px">此文件暂不支持在线直接预览</p>
        <p style="font-size:13px;margin-bottom:20px">${escapeHtml(name)}</p>
        <button class="btn btn-primary" id="btn-modal-dl">⬇️ 立即下载该文件</button>
      </div>`;
    dom.previewBody.querySelector('#btn-modal-dl')?.addEventListener('click', () => downloadFile(file.key));
  }
}

export function closePreview() {
  previewSessionId++;
  if (currentPreviewAbort) {
    try { currentPreviewAbort.abort(); } catch (_) {}
    currentPreviewAbort = null;
  }
  if (currentPdfCleanup) {
    try { currentPdfCleanup(); } catch (_) {}
    currentPdfCleanup = null;
  }
  dom.previewModal.hidden = true;
  document.body.style.overflow = '';
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

dom.btnPreviewDel.addEventListener('click', async () => {
  if (!state.previewItem) return;
  const key = state.previewItem.key;
  const confirmed = await showConfirm('确认删除', `确定要删除 "${getFileName(key)}" 吗？`);
  if (!confirmed) return;

  try {
    const res = await apiFetch(`${API.file}?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
    if (res.ok) {
      showToast('文件已彻底删除', 'success');
      closePreview();
      optimisticRemoveItems([key]);
    } else {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || '删除失败', 'error');
    }
  } catch (err) {
    showToast('网络错误：' + err.message, 'error');
  }
});
