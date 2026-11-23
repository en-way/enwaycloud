/**
 * functions/api/_middleware.js
 * 全局 API 鉴权与安全响应中间件，拦截所有 /api/* 请求
 *
 * 安全策略：
 *   1. Fail-Closed：未配置 DRIVE_PASSWORD 且未显式开启 ALLOW_PUBLIC_ACCESS='true' 时返回 503
 *   2. 会话校验：优先校验 HttpOnly HMAC-SHA256 Cookie (r2_session)，兼容 Authorization: Bearer 调试
 *   3. 彻底废除 URL ?auth= 查询参数传递明文密码
 *   4. 收窄 CORS：默认仅同源访问，仅当配置 env.ALLOWED_ORIGIN 且精确匹配时放行跨域
 */

import {
  jsonResponse,
  withHeaders,
  timingSafeEqualStr,
  verifySessionToken,
  parseCookie,
  SESSION_COOKIE_NAME,
} from './_utils.js';

function getCorsHeaders(request, env) {
  const allowedOrigin = (env.ALLOWED_ORIGIN || '').trim();
  const origin = request.headers.get('Origin');
  if (!allowedOrigin || !origin || origin !== allowedOrigin) {
    return {};
  }
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function applyCorsHeaders(response, corsHeaders) {
  if (!corsHeaders || Object.keys(corsHeaders).length === 0) {
    return response;
  }
  return withHeaders(response, corsHeaders);
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const corsHeaders = getCorsHeaders(request, env);
  const method = request.method.toUpperCase();
  const url = new URL(request.url);

  // 处理 CORS 预检请求
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // 0. 同源 CSRF 纵深校验（保护所有修改型方法）
  if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
    const origin = request.headers.get('Origin');
    const allowedOrigin = (env.ALLOWED_ORIGIN || '').trim();
    if (origin) {
      if (origin !== url.origin && (!allowedOrigin || origin !== allowedOrigin)) {
        return jsonResponse({ error: 'Forbidden', message: '拒绝跨源修改请求' }, 403, corsHeaders);
      }
    } else {
      const secFetchSite = request.headers.get('Sec-Fetch-Site');
      if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
        return jsonResponse({ error: 'Forbidden', message: '拒绝跨站修改请求' }, 403, corsHeaders);
      }
    }
  }

  // 1. Fail-Closed 检查：未设置密码且未显式允许公开访问，拒绝服务
  if (!env.DRIVE_PASSWORD) {
    if (env.ALLOW_PUBLIC_ACCESS === 'true') {
      const response = await next();
      return applyCorsHeaders(response, corsHeaders);
    }
    return jsonResponse(
      { error: 'Service Unavailable', message: '服务端尚未完成访问密码配置' },
      503,
      corsHeaders
    );
  }

  // 2. 登录 (POST /api/auth) 与登出 (DELETE /api/auth) 端点直接交由 auth.js 处理
  if (url.pathname === '/api/auth' && (method === 'POST' || method === 'DELETE')) {
    const response = await next();
    return applyCorsHeaders(response, corsHeaders);
  }

  // 3. 校验 HttpOnly 会话 Cookie 或 Authorization: Bearer 调试令牌
  let isAuthenticated = false;

  const sessionToken = parseCookie(request, SESSION_COOKIE_NAME);
  if (sessionToken) {
    isAuthenticated = await verifySessionToken(sessionToken, env);
  }

  if (!isAuthenticated) {
    const authHeader = request.headers.get('Authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const bearerPwd = authHeader.slice(7).trim();
      if (bearerPwd) {
        isAuthenticated = await timingSafeEqualStr(bearerPwd, env.DRIVE_PASSWORD);
      }
    }
  }

  if (!isAuthenticated) {
    return jsonResponse(
      { error: 'Unauthorized', message: '未登录或会话已过期，请重新验证' },
      401,
      corsHeaders
    );
  }

  // 4. 鉴权通过，放行下游 Handler
  const response = await next();
  return applyCorsHeaders(response, corsHeaders);
}
