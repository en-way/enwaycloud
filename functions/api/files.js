/**
 * functions/api/files.js
 * 处理文件目录列表查询
 *
 * GET /api/files?prefix=folder/&cursor=xxx
 *
 * 返回格式：
 * {
 *   folders: string[],          // 子文件夹路径数组（来自 delimitedPrefixes）
 *   files: FileObject[],        // 文件对象数组（过滤掉 0 字节占位对象）
 *   truncated: boolean,         // 是否还有更多结果
 *   cursor: string | null,      // 下一页游标
 * }
 */

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    // 校验 R2_BUCKET 绑定
    if (!env.R2_BUCKET) {
      return jsonResponse({ error: 'R2_BUCKET 绑定未配置' }, 500);
    }

    const url = new URL(request.url);
    const prefix = url.searchParams.get('prefix') || '';
    const cursor = url.searchParams.get('cursor') || undefined;
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '1000', 10), 1000);

    // 列出 R2 对象，使用 delimiter 归纳子目录
    const listed = await env.R2_BUCKET.list({
      prefix: prefix,
      delimiter: '/',
      cursor: cursor,
      limit: limit,
    });

    // 提取子文件夹（delimitedPrefixes）
    const folders = (listed.delimitedPrefixes || []);

    // 提取文件列表，过滤掉 0 字节目录占位符（key 以 / 结尾的对象）
    const files = (listed.objects || [])
      .filter(obj => {
        // 过滤掉与 prefix 同名的 0 字节目录占位对象
        if (obj.key === prefix) return false;
        // 过滤掉以 / 结尾的占位对象
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

    return jsonResponse({
      folders,
      files,
      truncated: listed.truncated || false,
      cursor: listed.truncated ? (listed.cursor || null) : null,
      prefix,
    });
  } catch (err) {
    console.error('[files.js] Error:', err);
    return jsonResponse(
      { error: '获取文件列表失败', message: err.message },
      500
    );
  }
}

/**
 * 构造 JSON 响应
 * @param {object} data
 * @param {number} status
 * @returns {Response}
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
