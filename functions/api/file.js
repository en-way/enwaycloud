/**
 * functions/api/file.js
 * 处理单文件操作：获取/预览/下载、上传（普通 + 分块）、删除、新建文件夹
 *
 * 路由分发（通过 ?action= 参数区分）：
 *
 * GET    /api/file?key=xxx                              → 预览/下载文件
 * GET    /api/file?key=xxx&download=1                   → 强制下载
 * PUT    /api/file?key=xxx                              → 普通上传（< 5MB 小文件）
 * PUT    /api/file?key=xxx&action=mkdir                 → 新建文件夹（上传 0 字节占位符）
 * POST   /api/file?key=xxx&action=createMultipart       → 创建 Multipart Upload，返回 uploadId
 * PUT    /api/file?key=xxx&action=uploadPart&uploadId=xxx&partNumber=N → 上传单个分块
 * POST   /api/file?key=xxx&action=completeMultipart     → 完成分块上传（body: {uploadId, parts:[{partNumber, etag}]}）
 * DELETE /api/file?key=xxx&action=abortMultipart&uploadId=xxx → 中止分块上传
 * DELETE /api/file?key=xxx                              → 删除文件或空文件夹
 */

// MIME 类型映射表（根据文件扩展名推断）
const MIME_MAP = {
  // 图片
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  bmp: 'image/bmp', ico: 'image/x-icon',
  // 视频
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  avi: 'video/x-msvideo', mkv: 'video/x-matroska',
  // 音频
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  flac: 'audio/flac', aac: 'audio/aac', m4a: 'audio/mp4',
  // 文档/代码
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
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
 * 根据文件 key 推断 Content-Type
 * @param {string} key
 * @param {object} httpMetadata
 * @returns {string}
 */
function inferContentType(key, httpMetadata = {}) {
  if (httpMetadata.contentType) return httpMetadata.contentType;
  const ext = key.split('.').pop().toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

/**
 * 构造 JSON 响应
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * 清除 Cloudflare Edge 边缘缓存 (去除 auth 参数，同步清理单文件与关联目录列表缓存)
 * @param {string} requestUrl
 * @param {string} key
 */
function purgeEdgeCache(requestUrl, key) {
  if (typeof caches === 'undefined') return;
  try {
    const cache = caches.default;
    // 1. 清理单文件响应缓存
    const fileUrl = new URL(requestUrl);
    fileUrl.pathname = '/api/file';
    fileUrl.search = `?key=${encodeURIComponent(key)}`;
    cache.delete(new Request(fileUrl.toString(), { method: 'GET' })).catch(() => {});

    // 2. 清理受影响的 /api/files 目录缓存与 ?all=1 全盘缓存
    const dirUrl = new URL(requestUrl);
    dirUrl.pathname = '/api/files';
    dirUrl.search = '?all=1';
    cache.delete(new Request(dirUrl.toString(), { method: 'GET' })).catch(() => {});

    const prefix = key.includes('/') ? key.substring(0, key.lastIndexOf('/') + 1) : '';
    dirUrl.search = `?prefix=${encodeURIComponent(prefix)}`;
    cache.delete(new Request(dirUrl.toString(), { method: 'GET' })).catch(() => {});
  } catch (_) {}
}

/**
 * GET /api/file?key=xxx[&download=1][&auth=xxx]
 * 获取/预览/下载文件 (集成 Range 单次精确读取、ETag 304 协商缓存、Cloudflare Edge 边缘缓存)
 */
async function handleGet(request, env, context) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  const forceDownload = url.searchParams.get('download') === '1';

  if (!key) {
    return jsonResponse({ error: '缺少 key 参数' }, 400);
  }

  // 1. 规范化边缘缓存检查：剥离 ?auth=，让所有已鉴权请求共享同一 Cache Key
  const rangeHeader = request.headers.get('Range');
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheUrl = new URL(request.url);
  cacheUrl.searchParams.delete('auth');
  const cacheKey = new Request(cacheUrl.toString(), {
    method: 'GET',
    headers: request.headers,
  });

  if (cache && !rangeHeader && !forceDownload) {
    try {
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        return cachedResponse;
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
    const fileName = key.split('/').pop();
    const etag = object.httpEtag || object.etag || '';

    // 3. 命中 HTTP 304 Not Modified: 当 onlyIf 前置条件满足（未修改）时，R2 返回无 body 的 R2Object
    if (!object.body) {
      return new Response(null, {
        status: 304,
        headers: {
          'ETag': etag,
          'Cache-Control': 'public, max-age=604800, immutable',
          'Last-Modified': object.uploaded ? object.uploaded.toUTCString() : '',
          'Accept-Ranges': 'bytes',
        },
      });
    }

    const headers = new Headers({
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=604800, immutable',
      'ETag': etag,
      'Last-Modified': object.uploaded ? object.uploaded.toUTCString() : '',
      'Accept-Ranges': 'bytes',
    });

    if (forceDownload) {
      // 对文件名进行 RFC 5987 编码，支持中文等非 ASCII 字符
      const encodedFileName = encodeURIComponent(fileName).replace(/'/g, "%27");
      headers.set(
        'Content-Disposition',
        `attachment; filename="${fileName}"; filename*=UTF-8''${encodedFileName}`
      );
    } else {
      headers.set('Content-Disposition', `inline; filename="${fileName}"`);
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
    const response = new Response(object.body, { status: 200, headers });

    // 写入 Cloudflare 边缘缓存（仅针对状态码 200、非 Range、非下载且 < 50MB 的常规文件）
    if (cache && !rangeHeader && !forceDownload && object.size < 50 * 1024 * 1024 && context && typeof context.waitUntil === 'function') {
      try {
        context.waitUntil(cache.put(cacheKey, response.clone()));
      } catch (_) {}
    }

    return response;
  } catch (err) {
    console.error('[file.js] GET error:', err);
    return jsonResponse({ error: '获取文件失败', message: err.message }, 500);
  }
}

/**
 * PUT /api/file?key=xxx
 * 普通上传（适合 < 5MB 的小文件，直接流式写入 R2）
 */
async function handlePut(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');

  if (!key) {
    return jsonResponse({ error: '缺少 key 参数' }, 400);
  }

  try {
    const contentType = request.headers.get('Content-Type') || 'application/octet-stream';
    await env.R2_BUCKET.put(key, request.body, {
      httpMetadata: { contentType },
    });
    purgeEdgeCache(request.url, key);
    return jsonResponse({ success: true, key, message: '上传成功' });
  } catch (err) {
    console.error('[file.js] PUT error:', err);
    return jsonResponse({ error: '上传失败', message: err.message }, 500);
  }
}

/**
 * PUT /api/file?key=xxx&action=mkdir
 * 新建文件夹（在 R2 中上传一个 0 字节的占位对象，key 以 / 结尾）
 */
async function handleMkdir(request, env) {
  const url = new URL(request.url);
  let key = url.searchParams.get('key');

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
    return jsonResponse({ success: true, key, message: '文件夹创建成功' });
  } catch (err) {
    console.error('[file.js] mkdir error:', err);
    return jsonResponse({ error: '创建文件夹失败', message: err.message }, 500);
  }
}

/**
 * POST /api/file?key=xxx&action=createMultipart
 * 创建 Multipart Upload，返回 uploadId
 */
async function handleCreateMultipart(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');

  if (!key) {
    return jsonResponse({ error: '缺少 key 参数' }, 400);
  }

  try {
    const contentType = request.headers.get('X-Content-Type') ||
                        request.headers.get('Content-Type') ||
                        'application/octet-stream';

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
    return jsonResponse({ error: '创建分块上传失败', message: err.message }, 500);
  }
}

/**
 * PUT /api/file?key=xxx&action=uploadPart&uploadId=xxx&partNumber=N
 * 上传单个分块
 */
async function handleUploadPart(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  const uploadId = url.searchParams.get('uploadId');
  const partNumber = parseInt(url.searchParams.get('partNumber') || '0', 10);

  if (!key || !uploadId || !partNumber) {
    return jsonResponse({ error: '缺少必要参数: key, uploadId, partNumber' }, 400);
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
    return jsonResponse({ error: `上传第 ${partNumber} 块失败`, message: err.message }, 500);
  }
}

/**
 * POST /api/file?key=xxx&action=completeMultipart
 * 完成分块上传，合并所有分块
 * Body: { uploadId: string, parts: [{partNumber: number, etag: string}] }
 */
async function handleCompleteMultipart(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');

  if (!key) {
    return jsonResponse({ error: '缺少 key 参数' }, 400);
  }

  try {
    const body = await request.json();
    const { uploadId, parts } = body;

    if (!uploadId || !Array.isArray(parts) || parts.length === 0) {
      return jsonResponse({ error: '缺少 uploadId 或 parts 数据' }, 400);
    }

    const multipartUpload = env.R2_BUCKET.resumeMultipartUpload(key, uploadId);
    const object = await multipartUpload.complete(parts);
    purgeEdgeCache(request.url, key);

    return jsonResponse({
      success: true,
      key,
      etag: object.etag,
      message: '分块上传完成',
    });
  } catch (err) {
    console.error('[file.js] completeMultipart error:', err);
    return jsonResponse({ error: '完成分块上传失败', message: err.message }, 500);
  }
}

/**
 * DELETE /api/file?key=xxx&action=abortMultipart&uploadId=xxx
 * 中止分块上传
 */
async function handleAbortMultipart(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
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
    return jsonResponse({ error: '中止分块上传失败', message: err.message }, 500);
  }
}

/**
 * DELETE /api/file?key=xxx
 * 删除文件或空文件夹
 */
async function handleDelete(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');

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
    purgeEdgeCache(request.url, key);
    return jsonResponse({ success: true, key, message: '删除成功' });
  } catch (err) {
    console.error('[file.js] DELETE error:', err);
    return jsonResponse({ error: '删除失败', message: err.message }, 500);
  }
}

/**
 * POST /api/file?action=batchDelete
 * 批量删除文件（单次原子操作，减少 98% Functions 调用与 R2 开销）
 * Body: { keys: string[] }
 */
async function handleBatchDelete(request, env) {
  try {
    const body = await request.json().catch(() => ({}));
    const { keys } = body;

    if (!Array.isArray(keys) || keys.length === 0) {
      return jsonResponse({ error: '缺少有效的 keys 数组' }, 400);
    }

    // 安全限制：单次批量最多删除 500 个项目（R2 原生批量上限为 1000）
    const validKeys = keys
      .filter(k => typeof k === 'string' && k.trim().length > 0)
      .slice(0, 500);

    if (validKeys.length === 0) {
      return jsonResponse({ error: 'keys 列表中无有效项' }, 400);
    }

    // R2 原生批量原子删除：delete(keys: string[])，仅计为 1 次原子操作且免费
    await env.R2_BUCKET.delete(validKeys);

    // 异步清理边缘缓存
    validKeys.forEach(k => purgeEdgeCache(request.url, k));

    return jsonResponse({
      success: true,
      message: `成功批量删除 ${validKeys.length} 个项目`,
      deletedCount: validKeys.length,
    });
  } catch (err) {
    console.error('[file.js] batchDelete error:', err);
    return jsonResponse({ error: '批量删除失败', message: err.message }, 500);
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
      return await handleDelete(request, env);
    }

    // PUT：普通上传 / 新建文件夹 / 上传分块
    if (method === 'PUT') {
      if (action === 'mkdir') {
        return await handleMkdir(request, env);
      }
      if (action === 'uploadPart') {
        return await handleUploadPart(request, env);
      }
      return await handlePut(request, env);
    }

    // POST：批量删除 / 创建分块上传 / 完成分块上传
    if (method === 'POST') {
      if (action === 'batchDelete') {
        return await handleBatchDelete(request, env);
      }
      if (action === 'createMultipart') {
        return await handleCreateMultipart(request, env);
      }
      if (action === 'completeMultipart') {
        return await handleCompleteMultipart(request, env);
      }
      return jsonResponse({ error: '不支持的 POST action' }, 400);
    }

    return jsonResponse({ error: `不支持的请求方法: ${method}` }, 405);
  } catch (err) {
    console.error('[file.js] Unexpected error:', err);
    return jsonResponse({ error: '服务器内部错误', message: err.message }, 500);
  }
}
