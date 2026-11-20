/**
 * functions/api/files.js
 * 处理文件目录列表查询 (集成全盘虚拟树单次扫描与 Cloudflare Edge 目录缓存)
 *
 * GET /api/files?prefix=folder/&cursor=xxx
 * GET /api/files?all=1              // 全盘轻量虚拟树索引扫描 (整盘仅消耗 1 次 Class A)
 * GET /api/files?refresh=1          // 强制穿透 Edge 缓存并刷新
 */

import { sanitizeKey, jsonResponse, withHeaders } from './_utils.js';

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
    let prefix = sanitizeKey(url.searchParams.get('prefix') || '');
    if (prefix && !prefix.endsWith('/')) {
      prefix = prefix + '/';
    }
    const cursor = url.searchParams.get('cursor') || undefined;
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '1000', 10) || 1000, 1), 1000);

    // 1. Cloudflare Edge CDN 目录缓存检查（内部缓存与客户端私密响应头分离）
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    const cacheUrl = new URL(request.url);
    cacheUrl.searchParams.delete('auth');
    cacheUrl.searchParams.delete('refresh');
    const cacheKey = new Request(cacheUrl.toString(), {
      method: 'GET',
    });

    if (cache && !isRefresh) {
      try {
        const cachedResponse = await cache.match(cacheKey);
        if (cachedResponse) {
          return withHeaders(cachedResponse, { 'Cache-Control': 'private, no-cache' });
        }
      } catch (_) {}
    }

    // 2. 策略一：全盘虚拟树扫描模式 (?all=1)
    if (isAll) {
      const listed = await env.R2_BUCKET.list({
        cursor,
        limit: 1000,
      });

      const objects = (listed.objects || []).map(obj => ({
        key: obj.key,
        size: obj.size,
        uploaded: obj.uploaded ? obj.uploaded.toISOString() : null,
        httpMetadata: obj.httpMetadata || {},
        etag: obj.etag || null,
      }));

      const totalSize = (listed.objects || []).reduce((sum, obj) => sum + (obj.size || 0), 0);

      const resData = {
        all: true,
        objects,
        totalSize,
        truncated: listed.truncated || false,
        cursor: listed.truncated ? (listed.cursor || null) : null,
      };

      const edgeResponse = jsonResponse(resData, 200, {
        'Cache-Control': 'public, max-age=300',
      });
      if (cache && context && typeof context.waitUntil === 'function') {
        try {
          context.waitUntil(cache.put(cacheKey, edgeResponse.clone()));
        } catch (_) {}
      }
      return withHeaders(edgeResponse, { 'Cache-Control': 'private, no-cache' });
    }

    // 3. 策略二：按需单目录查询模式 (带 delimiter)
    const listed = await env.R2_BUCKET.list({
      prefix,
      delimiter: '/',
      cursor,
      limit,
    });

    const folders = listed.delimitedPrefixes || [];
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

    const edgeResponse = jsonResponse(resData, 200, {
      'Cache-Control': 'public, max-age=300',
    });
    if (cache && context && typeof context.waitUntil === 'function') {
      try {
        context.waitUntil(cache.put(cacheKey, edgeResponse.clone()));
      } catch (_) {}
    }
    return withHeaders(edgeResponse, { 'Cache-Control': 'private, no-cache' });
  } catch (err) {
    console.error('[files.js] Error:', err);
    return jsonResponse({ error: '获取文件列表失败，请稍后重试' }, 500);
  }
}
