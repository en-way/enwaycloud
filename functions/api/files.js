/**
 * functions/api/files.js
 * 处理文件目录列表查询 (集成全盘虚拟树单次扫描与 Cloudflare Edge 目录缓存)
 *
 * GET /api/files?prefix=folder/&cursor=xxx
 * GET /api/files?all=1              // 全盘轻量虚拟树索引扫描 (整盘仅消耗 1 次 Class A)
 * GET /api/files?refresh=1          // 强制穿透 Edge 缓存并刷新
 */

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    // 校验 R2_BUCKET 绑定
    if (!env.R2_BUCKET) {
      return jsonResponse({ error: 'R2_BUCKET 绑定未配置' }, 500);
    }

    const url = new URL(request.url);
    const isAll = url.searchParams.get('all') === '1';
    const isRefresh = url.searchParams.get('refresh') === '1';
    const prefix = url.searchParams.get('prefix') || '';
    const cursor = url.searchParams.get('cursor') || undefined;
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '1000', 10), 1000);

    // 1. Cloudflare Edge CDN 目录缓存检查 (剥离 auth 与 refresh，共享 CDN 缓存)
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    const cacheUrl = new URL(request.url);
    cacheUrl.searchParams.delete('auth');
    cacheUrl.searchParams.delete('refresh');
    const cacheKey = new Request(cacheUrl.toString(), {
      method: 'GET',
      headers: request.headers,
    });

    if (cache && !isRefresh) {
      try {
        const cachedResponse = await cache.match(cacheKey);
        if (cachedResponse) {
          return cachedResponse;
        }
      } catch (_) {}
    }

    // 2. 策略一：全盘虚拟树扫描模式 (?all=1)
    if (isAll) {
      // 不传 delimiter，单次拉取整盘前 1000 个对象
      const listed = await env.R2_BUCKET.list({
        cursor: cursor,
        limit: 1000,
      });

      const objects = (listed.objects || []).map(obj => ({
        key: obj.key,
        size: obj.size,
        uploaded: obj.uploaded ? obj.uploaded.toISOString() : null,
        httpMetadata: obj.httpMetadata || {},
        etag: obj.etag || null,
      }));

      const resData = {
        all: true,
        objects,
        truncated: listed.truncated || false,
        cursor: listed.truncated ? (listed.cursor || null) : null,
      };

      const response = jsonResponse(resData, 200, true);
      if (cache && context && typeof context.waitUntil === 'function') {
        try {
          context.waitUntil(cache.put(cacheKey, response.clone()));
        } catch (_) {}
      }
      return response;
    }

    // 3. 策略二：按需单目录查询模式 (带 delimiter)
    const listed = await env.R2_BUCKET.list({
      prefix: prefix,
      delimiter: '/',
      cursor: cursor,
      limit: limit,
    });

    // 提取子文件夹（delimitedPrefixes）
    const folders = (listed.delimitedPrefixes || []);

    // 提取文件列表，过滤掉 0 字节目录占位符
    const files = (listed.objects || [])
      .filter(obj => {
        if (obj.key === prefix) return false;
        if (obj.key.endsWith('/') && obj.size === 0) return false;
        return true;
      })
      .map(obj => ({
        key: obj.key,
        size: obj.size,
        uploaded: obj.uploaded ? obj.uploaded.toISOString() : null,
        httpMetadata: obj.httpMetadata || {},
        etag: obj.etag || null,
      }));

    const resData = {
      folders,
      files,
      truncated: listed.truncated || false,
      cursor: listed.truncated ? (listed.cursor || null) : null,
      prefix,
    };

    const response = jsonResponse(resData, 200, true);
    if (cache && context && typeof context.waitUntil === 'function') {
      try {
        context.waitUntil(cache.put(cacheKey, response.clone()));
      } catch (_) {}
    }
    return response;
  } catch (err) {
    console.error('[files.js] Error:', err);
    return jsonResponse(
      { error: '获取文件列表失败', message: err.message },
      500
    );
  }
}

/**
 * 构造 JSON 响应 (支持 Edge 缓存头与浏览器不缓存)
 * @param {object} data
 * @param {number} status
 * @param {boolean} cacheable
 * @returns {Response}
 */
function jsonResponse(data, status = 200, cacheable = false) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheable ? 'private, no-cache, s-maxage=300' : 'no-store',
  };
  return new Response(JSON.stringify(data), {
    status,
    headers,
  });
}
