/**
 * public/js/preview.js
 * 全端多格式在线预览引擎（PDF Range 流式按页 / 图片相册缩放旋转 / Word / HEIC LRU / Excel / ZIP / 文本），带体积护栏与并发取消
 */

import {
  API,
  MAX_TEXT_PREVIEW_BYTES,
  MAX_RICH_PREVIEW_BYTES,
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
  getHeicCache,
  setHeicCache,
  xlsxPreviewCache,
  optimisticRemoveItems,
} from './cache.js';
import { getCurrentOrderedFiles } from './ui.js';

const scriptPromiseCache = new Map();
export function loadScript(src) {
  if (scriptPromiseCache.has(src)) return scriptPromiseCache.get(src);
  const promise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => {
      scriptPromiseCache.delete(src);
      reject(new Error('无法加载本地依赖库：' + src));
    };
    document.head.appendChild(s);
  });
  scriptPromiseCache.set(src, promise);
  return promise;
}

let currentPreviewCleanup = null;
let previewSessionId = 0;
let currentPreviewAbort = null;

function isPreviewSessionActive(sessionId) {
  return sessionId === previewSessionId && !dom.previewModal.hidden;
}

function renderPreviewFallback(file, iconType, title, desc, isError = false) {
  dom.previewBody.innerHTML = `
    <div class="preview-fallback-card">
      <div class="preview-fallback-icon">${renderSvgIcon(iconType, 56)}</div>
      <p class="preview-fallback-title ${isError ? 'is-error' : ''}">${escapeHtml(title)}</p>
      <p class="preview-fallback-desc">${escapeHtml(desc)}</p>
      <button class="btn btn-primary" id="btn-modal-dl" type="button">立即下载该文件</button>
    </div>`;
  dom.previewBody.querySelector('#btn-modal-dl')?.addEventListener('click', () => downloadFile(file.key));
}

// ─── PDF Range 流式按页预览 ────────────────────────────────────────────────────
async function renderPdfPreview(file, mediaUrl, sessionId) {
  dom.previewBody.innerHTML = `
    <div class="preview-loading-tip">
      <div class="spinner-modern"></div>
      <p>正在流式载入 PDF 首页...</p>
    </div>`;

  let loadingTask = null;
  let pdfDoc = null;
  let keydownHandler = null;

  currentPreviewCleanup = () => {
    if (keydownHandler) window.removeEventListener('keydown', keydownHandler);
    try { loadingTask?.destroy?.(); } catch (_) {}
    try { pdfDoc?.destroy?.(); } catch (_) {}
  };

  try {
    await loadScript('/vendor/pdfjs/pdf.min.js');
    if (!isPreviewSessionActive(sessionId)) return;

    if (window.pdfjsLib) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
    }

    loadingTask = window.pdfjsLib.getDocument({
      url: mediaUrl,
      withCredentials: true,
      disableAutoFetch: true,
      disableStream: false,
    });
    pdfDoc = await loadingTask.promise;
    if (!isPreviewSessionActive(sessionId)) {
      try { pdfDoc.destroy?.(); } catch (_) {}
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
          <button class="btn-icon" id="btn-pdf-prev" type="button" title="上一页" ${currentPageNum <= 1 ? 'disabled' : ''}>◀</button>
          <span class="pdf-page-indicator" id="pdf-page-indicator">${currentPageNum} / ${totalPages}</span>
          <button class="btn-icon" id="btn-pdf-next" type="button" title="下一页" ${currentPageNum >= totalPages ? 'disabled' : ''}>▶</button>
          <div class="pdf-divider"></div>
          <button class="btn-icon" id="btn-pdf-zoom-out" type="button" title="缩小">-</button>
          <button class="btn-icon" id="btn-pdf-fit" type="button" title="自适应宽度" style="font-size:11px;width:auto;padding:0 6px">适应</button>
          <button class="btn-icon" id="btn-pdf-zoom-in" type="button" title="放大">+</button>
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
      try {
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
        if (!isPreviewSessionActive(sessionId)) return;

        indicator.textContent = `${num} / ${totalPages}`;
        btnPrev.disabled = num <= 1;
        btnNext.disabled = num >= totalPages;
      } catch (renderErr) {
        if (isPreviewSessionActive(sessionId)) {
          console.error('PDF page render error:', renderErr);
        }
      } finally {
        isRendering = false;
        if (pendingPageNum !== null && isPreviewSessionActive(sessionId)) {
          const next = pendingPageNum;
          pendingPageNum = null;
          renderPage(next);
        }
      }
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
      try {
        const page = await pdfDoc.getPage(currentPageNum);
        const vp = page.getViewport({ scale: 1 });
        const wrapWidth = wrap.clientWidth - 48;
        if (wrapWidth > 0 && vp.width > 0) {
          currentScale = Math.max(0.4, wrapWidth / vp.width);
          queueRenderPage(currentPageNum);
        }
      } catch (_) {}
    });

    keydownHandler = e => {
      if (!isPreviewSessionActive(sessionId)) return;
      if (e.key === 'ArrowLeft') {
        if (currentPageNum > 1) { currentPageNum--; queueRenderPage(currentPageNum); }
      } else if (e.key === 'ArrowRight') {
        if (currentPageNum < totalPages) { currentPageNum++; queueRenderPage(currentPageNum); }
      }
    };
    window.addEventListener('keydown', keydownHandler);

    renderPage(currentPageNum);
  } catch (err) {
    if (err.name === 'AbortError' || !isPreviewSessionActive(sessionId)) return;
    console.error('PDF.js render error:', err);
    renderPreviewFallback(
      file,
      'pdf',
      'PDF 在线预览失败',
      err?.message || '文档流加载异常，建议直接下载后查看',
      true
    );
  }
}

// ─── 图片相册级预览（普通图片 + HEIC，支持左右切换 / 缩放 / 旋转 / 手势） ──────────
async function renderImageGallery(file, mediaUrl, sessionId, signal) {
  const allImages = getCurrentOrderedFiles().filter(f => getFileType(f.key) === 'image');
  let gallery = allImages.length > 0 ? allImages : [file];
  let currentIndex = gallery.findIndex(f => f.key === file.key);
  if (currentIndex < 0) {
    gallery = [file];
    currentIndex = 0;
  }

  const total = gallery.length;
  const hasMultiple = total > 1;
  const ext = getExt(file.key);
  const isHeic = ext === 'heic' || ext === 'heif';

  dom.previewBody.innerHTML = `
    <div class="preview-image-stage">
      ${hasMultiple ? `
        <button type="button" class="preview-nav-btn is-prev" id="btn-gallery-prev" title="上一张 (←)" aria-label="上一张" ${currentIndex <= 0 ? 'disabled' : ''}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>` : ''}
      <div class="preview-image-viewport" id="preview-image-viewport">
        <div class="preview-loading-tip">
          <div class="spinner-modern"></div>
          <p>${isHeic ? '正在解码 HEIC 高清图像...' : '正在加载图片...'}</p>
        </div>
      </div>
      ${hasMultiple ? `
        <button type="button" class="preview-nav-btn is-next" id="btn-gallery-next" title="下一张 (→)" aria-label="下一张" ${currentIndex >= total - 1 ? 'disabled' : ''}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>` : ''}
      <div class="image-controls-pill" id="image-controls-pill">
        <button type="button" class="btn-icon" id="btn-img-zoom-out" title="缩小" aria-label="缩小">-</button>
        <button type="button" class="btn-icon" id="btn-img-zoom-in" title="放大" aria-label="放大">+</button>
        <button type="button" class="btn-icon" id="btn-img-rotate" title="旋转 90°" aria-label="旋转 90°">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
        </button>
        <button type="button" class="btn-icon" id="btn-img-reset" title="复位" style="font-size:11px;width:auto;padding:0 6px">1:1</button>
        <div class="pdf-divider"></div>
        <span class="image-gallery-counter">${currentIndex + 1} / ${total}</span>
      </div>
    </div>`;

  const viewport = dom.previewBody.querySelector('#preview-image-viewport');
  const btnPrev = dom.previewBody.querySelector('#btn-gallery-prev');
  const btnNext = dom.previewBody.querySelector('#btn-gallery-next');
  const btnZoomOut = dom.previewBody.querySelector('#btn-img-zoom-out');
  const btnZoomIn = dom.previewBody.querySelector('#btn-img-zoom-in');
  const btnRotate = dom.previewBody.querySelector('#btn-img-rotate');
  const btnReset = dom.previewBody.querySelector('#btn-img-reset');

  let scale = 1;
  let rotation = 0;
  let activeImg = null;

  function applyTransform() {
    if (!activeImg) return;
    activeImg.style.transform = `scale(${scale}) rotate(${rotation}deg)`;
    activeImg.style.cursor = scale > 1 ? 'zoom-out' : 'zoom-in';
  }

  function goPrev() {
    if (currentIndex > 0) openPreview(gallery[currentIndex - 1]);
  }

  function goNext() {
    if (currentIndex < total - 1) openPreview(gallery[currentIndex + 1]);
  }

  btnPrev?.addEventListener('click', goPrev);
  btnNext?.addEventListener('click', goNext);
  btnZoomIn?.addEventListener('click', () => {
    scale = Math.min(3, +(scale + 0.25).toFixed(2));
    applyTransform();
  });
  btnZoomOut?.addEventListener('click', () => {
    scale = Math.max(0.5, +(scale - 0.25).toFixed(2));
    applyTransform();
  });
  btnRotate?.addEventListener('click', () => {
    rotation = (rotation + 90) % 360;
    applyTransform();
  });
  btnReset?.addEventListener('click', () => {
    scale = 1;
    rotation = 0;
    applyTransform();
  });

  const onKeydown = e => {
    if (!isPreviewSessionActive(sessionId)) return;
    if (e.key === 'ArrowLeft') goPrev();
    else if (e.key === 'ArrowRight') goNext();
  };
  window.addEventListener('keydown', onKeydown);

  let touchStartX = 0;
  let touchStartY = 0;
  const onTouchStart = e => {
    if (e.touches.length !== 1) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  };
  const onTouchEnd = e => {
    if (!hasMultiple || scale > 1.05 || e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      if (dx > 0) goPrev();
      else goNext();
    }
  };
  viewport?.addEventListener('touchstart', onTouchStart, { passive: true });
  viewport?.addEventListener('touchend', onTouchEnd, { passive: true });

  currentPreviewCleanup = () => {
    window.removeEventListener('keydown', onKeydown);
    viewport?.removeEventListener('touchstart', onTouchStart);
    viewport?.removeEventListener('touchend', onTouchEnd);
  };

  function mountImageElement(srcUrl) {
    if (!isPreviewSessionActive(sessionId)) return;
    const img = document.createElement('img');
    img.className = 'preview-stage-img';
    img.alt = getFileName(file.key);
    img.src = srcUrl;
    img.style.opacity = '0';
    img.onload = () => {
      if (!isPreviewSessionActive(sessionId)) return;
      img.style.opacity = '1';
    };
    img.onerror = () => {
      if (!isPreviewSessionActive(sessionId)) return;
      viewport.innerHTML = `
        <div class="preview-fallback-card">
          <div class="preview-fallback-icon">${renderSvgIcon('image', 56)}</div>
          <p class="preview-fallback-title is-error">图片加载失败</p>
          <p class="preview-fallback-desc">无法显示该图片，请尝试下载查看</p>
          <button class="btn btn-primary" id="btn-modal-dl" type="button">立即下载该文件</button>
        </div>`;
      viewport.querySelector('#btn-modal-dl')?.addEventListener('click', () => downloadFile(file.key));
    };
    img.addEventListener('dblclick', () => {
      scale = scale === 1 ? 2 : 1;
      applyTransform();
    });
    activeImg = img;
    viewport.innerHTML = '';
    viewport.appendChild(img);
    applyTransform();
  }

  if (!isHeic) {
    mountImageElement(mediaUrl);
    return;
  }

  const cachedUrl = getHeicCache(file.key);
  if (cachedUrl) {
    mountImageElement(cachedUrl);
    return;
  }

  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  if (isSafari) {
    mountImageElement(mediaUrl);
    return;
  }

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
    if (!isPreviewSessionActive(sessionId)) return;

    const resultBlob = Array.isArray(conversionResult) ? conversionResult[0] : conversionResult;
    const objectUrl = URL.createObjectURL(resultBlob);
    setHeicCache(file.key, objectUrl);
    mountImageElement(objectUrl);
  } catch (err) {
    if (err.name === 'AbortError' || !isPreviewSessionActive(sessionId)) return;
    renderPreviewFallback(
      file,
      'image',
      'HEIC 图像解码失败',
      err?.message || '解码异常，建议直接下载后查看',
      true
    );
  }
}

// ─── DOCX / Excel / ZIP 预览（带 30 MB 内存保护上限） ───────────────────────────
async function renderDocxPreview(file, mediaUrl, sessionId, signal) {
  if (file.size > MAX_RICH_PREVIEW_BYTES) {
    renderPreviewFallback(
      file,
      'word',
      `文档较大 (${formatSize(file.size)})`,
      '超过 30 MB 的 Word 文档建议直接下载查看，以避免浏览器内存溢出。'
    );
    return;
  }

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
    renderPreviewFallback(file, 'word', 'Word 文档解析失败', err.message, true);
  }
}

async function renderExcelPreview(file, mediaUrl, sessionId, signal) {
  if (file.size > MAX_RICH_PREVIEW_BYTES) {
    renderPreviewFallback(
      file,
      'excel',
      `表格较大 (${formatSize(file.size)})`,
      '超过 30 MB 的 Excel 表格建议直接下载查看，以避免浏览器卡顿或内存溢出。'
    );
    return;
  }

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
    renderPreviewFallback(file, 'excel', 'Excel 表格解析失败', err.message, true);
  }
}

async function renderZipPreview(file, mediaUrl, sessionId, signal) {
  if (file.size > MAX_RICH_PREVIEW_BYTES) {
    renderPreviewFallback(
      file,
      'zip',
      `压缩包较大 (${formatSize(file.size)})`,
      '超过 30 MB 的压缩包建议直接下载后在本地解压查看。'
    );
    return;
  }

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
          <button class="btn btn-secondary btn-xs" id="btn-zip-dl" type="button">下载整包</button>
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
    renderPreviewFallback(file, 'zip', '压缩包解析失败', err.message, true);
  }
}

// ─── 入口路由 ──────────────────────────────────────────────────────────────────
export async function openPreview(file) {
  if (currentPreviewAbort) {
    try { currentPreviewAbort.abort(); } catch (_) {}
  }
  if (currentPreviewCleanup) {
    try { currentPreviewCleanup(); } catch (_) {}
    currentPreviewCleanup = null;
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

  if (type === 'image') {
    await renderImageGallery(file, mediaUrl, sessionId, abortController.signal);
  } else if (type === 'video') {
    const video = document.createElement('video');
    video.controls = true;
    video.autoplay = false;
    video.preload = 'metadata';
    video.src = mediaUrl;
    dom.previewBody.appendChild(video);
  } else if (type === 'audio') {
    const wrap = document.createElement('div');
    wrap.className = 'preview-fallback-card';
    wrap.innerHTML = `<div class="preview-fallback-icon">${renderSvgIcon('audio', 64)}</div><p class="preview-fallback-title">${escapeHtml(name)}</p>`;
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = mediaUrl;
    audio.style.width = 'min(440px, 82vw)';
    wrap.appendChild(audio);
    dom.previewBody.appendChild(wrap);
  } else if (type === 'text' || type === 'code') {
    if (file.size > MAX_TEXT_PREVIEW_BYTES) {
      renderPreviewFallback(
        file,
        type,
        `文本文件较大 (${formatSize(file.size)})`,
        '为保障浏览器响应流畅度，超过 2 MB 的大文本暂不直接渲染全文，请下载后在本地查看。'
      );
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
      dom.previewBody.innerHTML = '<div class="preview-loading-tip"><div class="spinner-modern"></div><p>正在加载文本内容...</p></div>';
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
        renderPreviewFallback(file, type, '文本加载失败', err.message, true);
      }
    }
  } else if (type === 'pdf') {
    await renderPdfPreview(file, mediaUrl, sessionId);
  } else if (type === 'word') {
    if (ext === 'docx') {
      await renderDocxPreview(file, mediaUrl, sessionId, abortController.signal);
    } else {
      renderPreviewFallback(
        file,
        'word',
        '旧版 Word (.doc) 格式暂不支持在线直接预览',
        '.doc 属于早期复合二进制格式，建议另存为新版 .docx 格式上传预览，或直接下载在本地查看。'
      );
    }
  } else if (type === 'excel') {
    await renderExcelPreview(file, mediaUrl, sessionId, abortController.signal);
  } else if (type === 'zip') {
    await renderZipPreview(file, mediaUrl, sessionId, abortController.signal);
  } else {
    renderPreviewFallback(file, type, '此文件暂不支持在线直接预览', name);
  }
}

export function closePreview() {
  previewSessionId++;
  if (currentPreviewAbort) {
    try { currentPreviewAbort.abort(); } catch (_) {}
    currentPreviewAbort = null;
  }
  if (currentPreviewCleanup) {
    try { currentPreviewCleanup(); } catch (_) {}
    currentPreviewCleanup = null;
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
