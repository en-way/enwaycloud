/**
 * functions/api/auth.js
 * 会话鉴权接口（完全不调用 R2，0 Class A 消耗）
 *
 * GET    /api/auth  → 轻量登录态探针（经 _middleware.js 校验通过后返回成功）
 * POST   /api/auth  → 校验密码并下发 HttpOnly HMAC-SHA256 会话 Cookie
 * DELETE /api/auth  → 清除会话 Cookie 安全登出
 */

import {
  jsonResponse,
  timingSafeEqualStr,
  signSessionToken,
  buildSessionCookie,
  buildClearSessionCookie,
  DEFAULT_SESSION_TTL,
} from './_utils.js';

export async function onRequestGet({ env }) {
  const publicMode = !env.DRIVE_PASSWORD && env.ALLOW_PUBLIC_ACCESS === 'true';
  return jsonResponse({ ok: true, publicMode, message: 'Authenticated' }, 200);
}

export async function onRequestPost({ request, env }) {
  if (!env.DRIVE_PASSWORD) {
    if (env.ALLOW_PUBLIC_ACCESS === 'true') {
      return jsonResponse({ ok: true, publicMode: true, message: 'Public mode enabled' }, 200);
    }
    return jsonResponse({ error: 'Service Unavailable', message: '服务端尚未完成访问密码配置' }, 503);
  }

  let body = null;
  try {
    body = await request.json();
  } catch (_) {
    return jsonResponse({ error: 'Bad Request', message: '请求体必须为有效 JSON' }, 400);
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse({ error: 'Bad Request', message: '请求体必须为 JSON 对象' }, 400);
  }

  const password = typeof body.password === 'string' ? body.password : '';
  if (!password) {
    return jsonResponse({ error: 'Unauthorized', message: '请输入访问密码' }, 401);
  }

  const matched = await timingSafeEqualStr(password, env.DRIVE_PASSWORD);
  if (!matched) {
    return jsonResponse({ error: 'Unauthorized', message: '密码错误，请重新输入' }, 401);
  }

  const token = await signSessionToken(env, DEFAULT_SESSION_TTL);
  return jsonResponse(
    { ok: true, message: '登录成功' },
    200,
    { 'Set-Cookie': buildSessionCookie(token, request.url, DEFAULT_SESSION_TTL) }
  );
}

export async function onRequestDelete({ request }) {
  return jsonResponse(
    { ok: true, message: '已安全退出登录' },
    200,
    { 'Set-Cookie': buildClearSessionCookie(request.url) }
  );
}
