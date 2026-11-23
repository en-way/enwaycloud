/**
 * functions/api/file.js
 * 处理单文件操作：获取/预览/下载、上传（普通 + 分块）、删除、批量删除、移动/重命名、新建文件夹
 *
 * 路由分发（通过 ?action= 参数区分）：
 *
 * GET    /api/file?key=xxx                              → 预览/下载文件（含 XSS 沙箱与 Edge Cache）
 * GET    /api/file?key=xxx&download=1                   → 强制下载
 * PUT    /api/file?key=xxx                              → 普通上传（<= 50MB 小文件）
 * PUT    /api/file?key=xxx&action=mkdir                 → 新建文件夹（上传 0 字节占位符）
 * POST   /api/file?key=xxx&action=createMultipart       → 创建 Multipart Upload，返回 uploadId
 * PUT    /api/file?key=xxx&action=uploadPart&uploadId=xxx&partNumber=N → 上传单个分块
 * POST   /api/file?key=xxx&action=completeMultipart     → 完成分块上传（body: {uploadId, parts:[{partNumber, etag}]}）
 * DELETE /api/file?key=xxx&action=abortMultipart&uploadId=xxx → 中止分块上传
 * DELETE /api/file?key=xxx                              → 删除文件或空文件夹
 * POST   /api/file?action=batchDelete                   → 批量原子删除
 * POST   /api/file?action=move                          → 移动/重命名
 */

import { sanitizeKey, jsonResponse, withHeaders } from './_utils.js';

// 高危可执行 MIME 类型（强制 attachment + 沙箱 CSP，杜绝同源存储型 XSS）
const DANGEROUS_MIME_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/xml',
  'text/xml',
  'text/javascript',
  'application/javascript',
]);

// MIME 类型映射表（根据文件扩展名推断）
const MIME_MAP = {
  // 图片
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  tiff: 'image/tiff', heic: 'image/heic', heif: 'image/heif',
  // 视频
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  avi: 'video/x-msvideo', mkv: 'video/x-matroska',
  // 音频
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  flac: 'audio/flac', aac: 'audio/aac', m4a: 'audio/mp4',
  // 文档/代码
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  xhtml: 'application/xhtml+xml',
  svgz: 'image/svg+xml',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  ts: 'text/typescript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8',
  yml: 'text/yaml; charset=utf-8',
  sh: 'text/x-sh; charset=utf-8',
  py: 'text/x-python; charset=utf-8',
  go: 'text/x-go; charset=utf-8',
  rs: 'text/x-rust; charset=utf-8',
  java: 'text/x-java; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  // 压缩包
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  '7z': 'application/x-7z-compressed',
  rar: 'application/x-rar-compressed',
};

/**
 * 根据文件 key 推断安全的 Content-Type（上传时不信任客户端声明）
 * @param {string} key
 * @param {object} httpMetadata
 * @returns {string}
 */
function inferContentType(key, httpMetadata = {}) {
  if (httpMetadata.contentType) return httpMetadata.contentType;
  const fileName = key.split('/').pop() || '';
  const dotIdx = fileName.lastIndexOf('.');
  if (dotIdx <= 0) return 'application/octet-stream';
  const ext = fileName.slice(dotIdx + 1).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

function isPlainObject(val) {
  return Boolean(val && typeof val === 'object' && !Array.isArray(val));
}

/**
 * 清除 Cloudflare Edge 边缘缓存 (支持单 key 或批量 key 数组，自动去重 URL)
 * 使用 context.waitUntil 守护异步淘汰，杜绝 Worker 实例提前休眠导致任务丢失
 * @param {object} context
 * @param {string} requestUrl
 * @param {string|string[]} keysOrKey
 */
function purgeEdgeCache(context, requestUrl, keysOrKey) {
  if (typeof caches === 'undefined') return;
  try {
    const cache = caches.default;
    const keys = Array.isArray(keysOrKey) ? keysOrKey : [keysOrKey];
    const urlSet = new Set();

    const baseAllUrl = new URL(requestUrl);
    baseAllUrl.pathname = '/api/files';
    baseAllUrl.search = '?all=1';
    urlSet.add(baseAllUrl.toString());

    for (const key of keys) {
      if (!key) continue;
      // 1. 单文件响应缓存
      const fileUrl = new URL(requestUrl);
      fileUrl.pathname = '/api/file';
      fileUrl.search = `?key=${encodeURIComponent(key)}`;
      urlSet.add(fileUrl.toString());

      // 2. 如果是目录 key（以 / 结尾），同时清理该目录自身的列表缓存
      if (key.endsWith('/')) {
        const selfDirUrl = new URL(requestUrl);
        selfDirUrl.pathname = '/api/files';
        selfDirUrl.search = `?prefix=${encodeURIComponent(key)}`;
        urlSet.add(selfDirUrl.toString());
      }

      // 3. 上级父目录缓存（目录 key 先剥离尾部 / 再计算父级 prefix）
      const dirUrl = new URL(requestUrl);
      dirUrl.pathname = '/api/files';
      const trimmed = key.endsWith('/') ? key.slice(0, -1) : key;
      const prefix = trimmed.includes('/') ? trimmed.substring(0, trimmed.lastIndexOf('/') + 1) : '';
      dirUrl.search = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
      urlSet.add(dirUrl.toString());
      if (!prefix) {
        dirUrl.search = '?prefix=';
        urlSet.add(dirUrl.toString());
      }
    }

    const promises = Array.from(urlSet).map(u =>
      cache.delete(new Request(u, { method: 'GET' }))
    );

    if (context && typeof context.waitUntil === 'function') {
      context.waitUntil(Promise.all(promises).catch(() => {}));
    }
  } catch (_) {}
}

/**
 * GET /api/file?key=xxx[&download=1]
 * 获取/预览/下载文件 (集成 Range 单次精确读取、ETag 304 协商缓存、XSS 沙箱头与 Cloudflare Edge 缓存)
 */
async function handleGet(request, env, context) {
  const url = new URL(request.url);
  const key = sanitizeKey(url.searchParams.get('key'));
  const forceDownload = url.searchParams.get('download') === '1';

  if (!key) {
    return jsonResponse({ error: '缺少 key 参数' }, 400);
  }

  // 1. 规范化边缘缓存检查：剥离 ?auth= 与 ?v=，确保 purgeEdgeCache 按 key 精准清理
  const rangeHeader = request.headers.get('Range');
  const versionParam = (url.searchParams.get('v') || '').trim();
  const clientCacheControl = (versionParam && !forceDownload)
    ? 'private, max-age=604800, immutable'
    : 'private, max-age=300';

  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheUrl = new URL(request.url);
  cacheUrl.searchParams.delete('auth');
  cacheUrl.searchParams.delete('v');
  const cacheKey = new Request(cacheUrl.toString(), {
    method: 'GET',
  });

  if (cache && !rangeHeader && !forceDownload) {
    try {
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        return withHeaders(cachedResponse, { 'Cache-Control': clientCacheControl });
      }
    } catch (_) {}
  }

  try {
    // 2. 原生透传 range 与 onlyIf 头（精确单次读取与 304 原生判定）
    const object = await env.R2_BUCKET.get(key, {
      range: request.headers,
      onlyIf: request.headers,
    });

    if (!object) {
      return jsonResponse({ error: '文件不存在', key }, 404);
    }

    const contentType = inferContentType(key, object.httpMetadata || {});
    const baseMime = contentType.split(';')[0].trim().toLowerCase();
    const isDangerousMime = DANGEROUS_MIME_TYPES.has(baseMime);
    const fileName = key.split('/').pop();
    const etag = object.httpEtag || object.etag || '';

    // 3. 命中 HTTP 304 Not Modified: 当 onlyIf 前置条件满足（未修改）时，R2 返回无 body 的 R2Object
    if (!object.body) {
      return new Response(null, {
        status: 304,
        headers: {
          'ETag': etag,
          'Cache-Control': clientCacheControl,
          'Last-Modified': object.uploaded ? object.uploaded.toUTCString() : '',
          'Accept-Ranges': 'bytes',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }

    const headers = new Headers({
      'Content-Type': contentType,
      'Cache-Control': clientCacheControl,
      'ETag': etag,
      'Last-Modified': object.uploaded ? object.uploaded.toUTCString() : '',
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });

    const safeAsciiName = fileName.replace(/[^\x20-\x7E]|["\\]/g, '_') || 'file';
    const encodedFileName = encodeURIComponent(fileName).replace(/'/g, '%27');
    if (forceDownload || isDangerousMime) {
      // 对下载或高危可执行文件（HTML/SVG/XML/JS）强制 attachment，杜绝同源 XSS
      headers.set(
        'Content-Disposition',
        `attachment; filename="${safeAsciiName}"; filename*=UTF-8''${encodedFileName}`
      );
    } else {
      headers.set(
        'Content-Disposition',
        `inline; filename="${safeAsciiName}"; filename*=UTF-8''${encodedFileName}`
      );
    }

    // 4. 处理 Range 206 Partial Content
    if (rangeHeader && object.range) {
      const offset = object.range.offset ?? 0;
      const length = object.range.length ?? object.size;
      const end = offset + length - 1;
      headers.set('Content-Range', `bytes ${offset}-${end}/${object.size}`);
      headers.set('Content-Length', length.toString());

      return new Response(object.body, { status: 206, headers });
    }

    // 5. 完整 200 响应
    headers.set('Content-Length', object.size.toString());

    // 写入 Cloudflare 边缘缓存（仅针对状态码 200、非 Range、非下载且 < 50MB 的常规文件）
    if (cache && !rangeHeader && !forceDownload && object.size < 50 * 1024 * 1024 && context && typeof context.waitUntil === 'function') {
      const [clientBody, cacheBody] = object.body.tee();
      const cacheHeaders = new Headers(headers);
      cacheHeaders.set('Cache-Control', 'public, max-age=300');
      const cacheResponse = new Response(cacheBody, { status: 200, headers: cacheHeaders });
      try {
        context.waitUntil(cache.put(cacheKey, cacheResponse));
      } catch (_) {}
      return new Response(clientBody, { status: 200, headers });
    }

    return new Response(object.body, { status: 200, headers });
  } catch (err) {
    if (err && err.message && (err.message.includes('Range') || err.message.includes('range'))) {
      return new Response('Range Not Satisfiable', {
        status: 416,
        headers: { 'Content-Range': 'bytes */*' },
      });
    }
    console.error('[file.js] GET error:', err);
    return jsonResponse({ error: '获取文件失败，请稍后重试' }, 500);
  }
}

/**
 * PUT /api/file?key=xxx
 * 普通上传（<= 50MB 小文件，服务端基于扩展名白名单安全推断 Content-Type）
 */
async function handlePut(request, env, context) {
  const url = new URL(request.url);
  const key = sanitizeKey(url.searchParams.get('key'));

  if (!key || key.endsWith('/')) {
    return jsonResponse({ error: '缺少有效的文件 key 参数（不能以 / 结尾）' }, 400);
  }

  try {
    const contentType = inferContentType(key);
    const putObj = await env.R2_BUCKET.put(key, request.body, {
      httpMetadata: { contentType },
    });
    purgeEdgeCache(context, request.url, key);
    return jsonResponse({ success: true, key, etag: putObj?.etag || null, message: '上传成功' });
  } catch (err) {
    console.error('[file.js] PUT error:', err);
    return jsonResponse({ error: '上传失败，请稍后重试' }, 500);
  }
}

/**
 * PUT /api/file?key=xxx&action=mkdir
 * 新建文件夹（在 R2 中上传一个 0 字节的占位对象，key 以 / 结尾）
 */
async function handleMkdir(request, env, context) {
  const url = new URL(request.url);
  let key = sanitizeKey(url.searchParams.get('key'));

  if (!key) {
    return jsonResponse({ error: '缺少 key 参数' }, 400);
  }

  // 确保 key 以 / 结尾
  if (!key.endsWith('/')) {
    key = key + '/';
  }

  try {
    await env.R2_BUCKET.put(key, new Uint8Array(0), {
      httpMetadata: { contentType: 'application/x-directory' },
    });
    purgeEdgeCache(context, request.url, key);
    return jsonResponse({ success: true, key, message: '文件夹创建成功' });
  } catch (err) {
    console.error('[file.js] mkdir error:', err);
    return jsonResponse({ error: '创建文件夹失败，请稍后重试' }, 500);
  }
}

/**
 * POST /api/file?key=xxx&action=createMultipart
 * 创建 Multipart Upload，返回 uploadId（服务端基于扩展名白名单推断 Content-Type）
 */
async function handleCreateMultipart(request, env) {
  const url = new URL(request.url);
  const key = sanitizeKey(url.searchParams.get('key'));

  if (!key || key.endsWith('/')) {
    return jsonResponse({ error: '缺少有效的文件 key 参数（不能以 / 结尾）' }, 400);
  }

  try {
    const contentType = inferContentType(key);

    const multipartUpload = await env.R2_BUCKET.createMultipartUpload(key, {
      httpMetadata: { contentType },
    });

    return jsonResponse({
      success: true,
      key,
      uploadId: multipartUpload.uploadId,
    });
  } catch (err) {
    console.error('[file.js] createMultipart error:', err);
    return jsonResponse({ error: '创建分块上传失败，请稍后重试' }, 500);
  }
}

/**
 * PUT /api/file?key=xxx&action=uploadPart&uploadId=xxx&partNumber=N
 * 上传单个分块
 */
async function handleUploadPart(request, env) {
  const url = new URL(request.url);
  const key = sanitizeKey(url.searchParams.get('key'));
  const uploadId = (url.searchParams.get('uploadId') || '').trim();
  const rawPart = (url.searchParams.get('partNumber') || '').trim();
  const partNumber = /^\d+$/.test(rawPart) ? Number(rawPart) : NaN;

  if (!key || key.endsWith('/') || !uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return jsonResponse({ error: '参数不合法: 需提供有效的 key、uploadId 及 1–10000 的整数 partNumber' }, 400);
  }

  try {
    const multipartUpload = env.R2_BUCKET.resumeMultipartUpload(key, uploadId);
    const uploadedPart = await multipartUpload.uploadPart(partNumber, request.body);

    return jsonResponse({
      success: true,
      partNumber,
      etag: uploadedPart.etag,
    });
  } catch (err) {
    console.error('[file.js] uploadPart error:', err);
    return jsonResponse({ error: `上传第 ${partNumber} 块失败，请稍后重试` }, 500);
  }
}

/**
 * POST /api/file?key=xxx&action=completeMultipart
 * 完成分块上传，合并所有分块
 * Body: { uploadId: string, parts: [{partNumber: number, etag: string}] }
 */
async function handleCompleteMultipart(request, env, context) {
  const url = new URL(request.url);
  const key = sanitizeKey(url.searchParams.get('key'));

  if (!key || key.endsWith('/')) {
    return jsonResponse({ error: '缺少有效的文件 key 参数（不能以 / 结尾）' }, 400);
  }

  let body = null;
  try {
    body = await request.json();
  } catch (_) {
    return jsonResponse({ error: '请求体必须为有效 JSON' }, 400);
  }

  if (!isPlainObject(body)) {
    return jsonResponse({ error: '请求体必须为 JSON 对象' }, 400);
  }

  const { uploadId, parts } = body;
  const validParts = Array.isArray(parts) && parts.length > 0 && parts.every(
    p => isPlainObject(p)
      && Number.isInteger(p.partNumber)
      && p.partNumber >= 1
      && p.partNumber <= 10000
      && typeof p.etag === 'string'
      && p.etag.trim().length > 0
  );

  if (typeof uploadId !== 'string' || !uploadId.trim() || !validParts) {
    return jsonResponse({ error: '缺少有效的 uploadId 或 parts 数据' }, 400);
  }

  try {
    const multipartUpload = env.R2_BUCKET.resumeMultipartUpload(key, uploadId.trim());
    const object = await multipartUpload.complete(parts);
    purgeEdgeCache(context, request.url, key);

    return jsonResponse({
      success: true,
      key,
      etag: object.etag,
      message: '分块上传完成',
    });
  } catch (err) {
    console.error('[file.js] completeMultipart error:', err);
    return jsonResponse({ error: '完成分块上传失败，请稍后重试' }, 500);
  }
}

/**
 * DELETE /api/file?key=xxx&action=abortMultipart&uploadId=xxx
 * 中止分块上传
 */
async function handleAbortMultipart(request, env) {
  const url = new URL(request.url);
  const key = sanitizeKey(url.searchParams.get('key'));
  const uploadId = url.searchParams.get('uploadId');

  if (!key || !uploadId) {
    return jsonResponse({ error: '缺少 key 或 uploadId 参数' }, 400);
  }

  try {
    const multipartUpload = env.R2_BUCKET.resumeMultipartUpload(key, uploadId);
    await multipartUpload.abort();
    return jsonResponse({ success: true, message: '分块上传已中止' });
  } catch (err) {
    console.error('[file.js] abortMultipart error:', err);
    return jsonResponse({ error: '中止分块上传失败，请稍后重试' }, 500);
  }
}

/**
 * DELETE /api/file?key=xxx
 * 删除文件或空文件夹
 */
async function handleDelete(request, env, context) {
  const url = new URL(request.url);
  const key = sanitizeKey(url.searchParams.get('key'));

  if (!key) {
    return jsonResponse({ error: '缺少 key 参数' }, 400);
  }

  try {
    // 检查是否为文件夹（以 / 结尾），若是则先验证是否为空
    if (key.endsWith('/')) {
      const listed = await env.R2_BUCKET.list({ prefix: key, limit: 2 });
      const nonPlaceholder = (listed.objects || []).filter(obj => obj.key !== key);
      if (nonPlaceholder.length > 0 || (listed.delimitedPrefixes || []).length > 0) {
        return jsonResponse({ error: '文件夹不为空，无法删除' }, 409);
      }
    }

    await env.R2_BUCKET.delete(key);
    purgeEdgeCache(context, request.url, key);
    return jsonResponse({ success: true, key, message: '删除成功' });
  } catch (err) {
    console.error('[file.js] DELETE error:', err);
    return jsonResponse({ error: '删除失败，请稍后重试' }, 500);
  }
}

/**
 * POST /api/file?action=batchDelete
 * 批量删除文件与递归删除非空文件夹（单次原子操作，0 额外 Class A list 开销）
 * Body: { keys: string[], expandFolders?: boolean }
 */
async function handleBatchDelete(request, env, context) {
  let body = null;
  try {
    body = await request.json();
  } catch (_) {
    return jsonResponse({ error: '请求体必须为有效 JSON' }, 400);
  }

  if (!isPlainObject(body)) {
    return jsonResponse({ error: '请求体必须为 JSON 对象' }, 400);
  }

  try {
    const { keys, expandFolders } = body;

    if (!Array.isArray(keys) || keys.length === 0) {
      return jsonResponse({ error: '缺少有效的 keys 数组' }, 400);
    }

    const keySet = new Set(
      keys
        .filter(k => typeof k === 'string')
        .map(sanitizeKey)
        .filter(k => k.length > 0)
    );

    if (keySet.size === 0) {
      return jsonResponse({ error: 'keys 列表中无有效项' }, 400);
    }

    // 仅在前端未持有全盘虚拟树（超大盘降级模式 expandFolders=true）且包含目录时，由后端展开目录子项
    if (expandFolders) {
      const folderKeys = Array.from(keySet).filter(k => k.endsWith('/'));
      for (const fKey of folderKeys) {
        const listed = await env.R2_BUCKET.list({ prefix: fKey, limit: 1000 });
        for (const obj of (listed.objects || [])) {
          keySet.add(obj.key);
        }
      }
    }

    const validKeys = Array.from(keySet).slice(0, 1000);

    // R2 原生批量原子删除：delete(keys: string[])，单次最高 1000 项，免费且原子执行
    await env.R2_BUCKET.delete(validKeys);

    // 批量去重清理边缘缓存
    purgeEdgeCache(context, request.url, validKeys);

    return jsonResponse({
      success: true,
      message: `成功批量删除 ${validKeys.length} 个项目`,
      deletedCount: validKeys.length,
      deletedKeys: validKeys,
    });
  } catch (err) {
    console.error('[file.js] batchDelete error:', err);
    return jsonResponse({ error: '批量删除失败，请稍后重试' }, 500);
  }
}

/**
 * POST /api/file?action=move
 * 移动/重命名文件或文件夹（单次或批量流式复制）
 * Body: { items: [{ from: string, to: string, expandFolder?: boolean }] }
 */
async function handleMove(request, env, context) {
  let body = null;
  try {
    body = await request.json();
  } catch (_) {
    return jsonResponse({ error: '请求体必须为有效 JSON' }, 400);
  }

  if (!isPlainObject(body)) {
    return jsonResponse({ error: '请求体必须为 JSON 对象' }, 400);
  }

  try {
    const { items } = body;
    const allowOverwrite = body.overwrite === true;

    if (!Array.isArray(items) || items.length === 0) {
      return jsonResponse({ error: '缺少有效的 items 数组' }, 400);
    }

    // 若存在降级模式下的未展开文件夹（expandFolder=true），后端自动按前缀展开
    const expandedItems = [];
    for (const item of items.slice(0, 500)) {
      if (!isPlainObject(item) || typeof item.from !== 'string' || typeof item.to !== 'string') {
        return jsonResponse({ error: 'items 中包含非法元素' }, 400);
      }

      const fromKey = sanitizeKey(item.from);
      const toKey = sanitizeKey(item.to);
      if (!fromKey || !toKey) {
        return jsonResponse({ error: 'items 中存在空路径' }, 400);
      }

      if (fromKey.endsWith('/') !== toKey.endsWith('/')) {
        return jsonResponse({ error: '源路径与目标路径类型不一致（文件与文件夹不能互转）' }, 400);
      }

      if (fromKey.endsWith('/') && toKey.startsWith(fromKey)) {
        return jsonResponse({ error: '不能将文件夹移动到自身或其子目录下' }, 400);
      }

      if (item.expandFolder && fromKey.endsWith('/') && toKey.endsWith('/')) {
        const listed = await env.R2_BUCKET.list({ prefix: fromKey, limit: 1000 });
        const objs = listed.objects || [];
        if (objs.length === 0) {
          expandedItems.push({ from: fromKey, to: toKey });
        } else {
          for (const obj of objs) {
            expandedItems.push({
              from: obj.key,
              to: toKey + obj.key.slice(fromKey.length),
            });
          }
        }
      } else {
        expandedItems.push({ from: fromKey, to: toKey });
      }
    }

    const validItems = expandedItems.slice(0, 500);
    const results = [];
    const affectedCacheKeys = [];

    for (const item of validItems) {
      const fromKey = item.from;
      const toKey = item.to;

      if (!fromKey || !toKey || fromKey === toKey) {
        results.push({ from: item.from, to: item.to, success: false, error: '无效的源路径或目标路径' });
        continue;
      }

      if (fromKey.endsWith('/') !== toKey.endsWith('/')) {
        results.push({ from: fromKey, to: toKey, success: false, error: '源路径与目标路径类型不一致' });
        continue;
      }

      if (fromKey.endsWith('/') && toKey.startsWith(fromKey)) {
        return jsonResponse({ error: '不能将文件夹移动到自身或其子目录下' }, 400);
      }

      if (!allowOverwrite) {
        const dstExisting = typeof env.R2_BUCKET.head === 'function'
          ? await env.R2_BUCKET.head(toKey)
          : await env.R2_BUCKET.get(toKey);
        if (dstExisting) {
          if (dstExisting.body && typeof dstExisting.body.cancel === 'function') {
            try { await dstExisting.body.cancel(); } catch (_) {}
          }
          results.push({ from: fromKey, to: toKey, success: false, conflict: true, error: '目标路径已存在同名对象' });
          continue;
        }
      }

      // 检查源对象
      const srcObj = await env.R2_BUCKET.get(fromKey);
      if (!srcObj) {
        // 如果是目录且对象存储中无独立 0 字节实体（纯虚拟路径），直接记录成功并继续
        if (fromKey.endsWith('/')) {
          results.push({ from: fromKey, to: toKey, success: true, virtualFolder: true });
          continue;
        }
        results.push({ from: fromKey, to: toKey, success: false, error: '源文件不存在' });
        continue;
      }

      // 对 0 字节对象或空流写入空字符串，规避 ReadableStream 读空异常，并按目标扩展名重算 Content-Type
      const objBody = (srcObj.size === 0 || !srcObj.body) ? '' : srcObj.body;
      const nextContentType = toKey.endsWith('/')
        ? 'application/x-directory'
        : inferContentType(toKey);
      await env.R2_BUCKET.put(toKey, objBody, {
        httpMetadata: { ...(srcObj.httpMetadata || {}), contentType: nextContentType },
        customMetadata: srcObj.customMetadata,
      });

      // 删除原 key（免费操作）
      await env.R2_BUCKET.delete(fromKey);

      affectedCacheKeys.push(fromKey, toKey);
      results.push({ from: fromKey, to: toKey, success: true });
    }

    if (affectedCacheKeys.length > 0) {
      purgeEdgeCache(context, request.url, affectedCacheKeys);
    }

    const movedCount = results.filter(r => r.success).length;
    const failedCount = results.length - movedCount;

    if (movedCount === 0 && failedCount > 0) {
      const hasConflict = results.some(r => r.conflict);
      return jsonResponse({
        success: false,
        error: results[0]?.error || '移动失败，未找到源对象',
        movedCount: 0,
        results,
      }, hasConflict ? 409 : 404);
    }

    return jsonResponse({
      success: true,
      message: `成功移动/重命名 ${movedCount} 个项目`,
      movedCount,
      failedCount,
      results,
    });
  } catch (err) {
    console.error('[file.js] move error:', err);
    return jsonResponse({ error: '移动操作失败，请稍后重试' }, 500);
  }
}

// ─── 主路由入口 ────────────────────────────────────────────────────────────────

export async function onRequest(context) {
  const { request, env } = context;

  if (!env.R2_BUCKET) {
    return jsonResponse({ error: 'R2_BUCKET 绑定未配置，请检查 wrangler.toml 或 Cloudflare 控制台设置' }, 500);
  }

  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const method = request.method.toUpperCase();

  try {
    // GET：预览/下载文件 (传入 context 支持 Edge 缓存写入)
    if (method === 'GET') {
      return await handleGet(request, env, context);
    }

    // DELETE：删除单个文件 / 中止分块上传
    if (method === 'DELETE') {
      if (action === 'abortMultipart') {
        return await handleAbortMultipart(request, env);
      }
      return await handleDelete(request, env, context);
    }

    // PUT：普通上传 / 新建文件夹 / 上传分块
    if (method === 'PUT') {
      if (action === 'mkdir') {
        return await handleMkdir(request, env, context);
      }
      if (action === 'uploadPart') {
        return await handleUploadPart(request, env);
      }
      return await handlePut(request, env, context);
    }

    // POST：批量删除 / 移动重命名 / 创建分块上传 / 完成分块上传
    if (method === 'POST') {
      if (action === 'batchDelete') {
        return await handleBatchDelete(request, env, context);
      }
      if (action === 'move') {
        return await handleMove(request, env, context);
      }
      if (action === 'createMultipart') {
        return await handleCreateMultipart(request, env);
      }
      if (action === 'completeMultipart') {
        return await handleCompleteMultipart(request, env, context);
      }
      return jsonResponse({ error: '不支持的 POST action' }, 400);
    }

    return jsonResponse({ error: `不支持的请求方法: ${method}` }, 405);
  } catch (err) {
    console.error('[file.js] Unexpected error:', err);
    return jsonResponse({ error: '服务器内部错误，请稍后重试' }, 500);
  }
}
