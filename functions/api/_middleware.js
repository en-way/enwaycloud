/**
 * functions/api/_middleware.js
 * 全局 API 鉴权中间件，拦截所有 /api/* 请求
 *
 * 支持三种密码传递方式：
 *   1. Authorization: Bearer <password>  Header
 *   2. X-Drive-Password: <password>      Header（适合 fetch 请求）
 *   3. ?auth=<password>                  URL 查询参数（适合 <img>/<video> 标签直链）
 *
 * 若 env.DRIVE_PASSWORD 未设置，默认放行所有请求。
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Drive-Password',
  'Access-Control-Max-Age': '86400',
};

export async function onRequest(context) {
  const { request, env, next } = context;

  // 处理 CORS 预检请求
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // 若未设置密码，直接放行
  if (!env.DRIVE_PASSWORD) {
    const response = await next();
    return addCorsHeaders(response);
  }

  const url = new URL(request.url);
  let password = null;

  // 1. 从 Authorization Header 读取
  const authHeader = request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    password = authHeader.slice(7).trim();
  }

  // 2. 从自定义 Header 读取
  if (!password) {
    const customHeader = request.headers.get('X-Drive-Password');
    if (customHeader) {
      password = customHeader.trim();
    }
  }

  // 3. 从 URL 查询参数读取（用于媒体直链）
  if (!password) {
    const queryAuth = url.searchParams.get('auth');
    if (queryAuth) {
      password = queryAuth.trim();
    }
  }

  // 密码校验
  if (password !== env.DRIVE_PASSWORD) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized', message: '密码错误或未提供密码' }),
      {
        status: 401,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...CORS_HEADERS,
        },
      }
    );
  }

  // 鉴权通过，继续处理
  const response = await next();
  return addCorsHeaders(response);
}

/**
 * 为响应添加 CORS 头
 * @param {Response} response
 * @returns {Response}
 */
function addCorsHeaders(response) {
  const isNoBodyStatus = [204, 205, 304].includes(response.status);
  const newResponse = new Response(isNoBodyStatus ? null : response.body, response);
  Object.entries(CORS_HEADERS).forEach(([key, value]) => {
    newResponse.headers.set(key, value);
  });
  return newResponse;
}
