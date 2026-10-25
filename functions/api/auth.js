/**
 * functions/api/auth.js
 * 纯轻量鉴权探测接口（完全不调用 R2，0 Class A 消耗）
 * 鉴权已由全局 _middleware.js 统一拦截核对，通过后此处直接返回成功
 */

export async function onRequestGet() {
  return new Response(JSON.stringify({ ok: true, message: 'Authenticated' }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
