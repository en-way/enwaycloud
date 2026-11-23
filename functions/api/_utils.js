/**
 * functions/api/_utils.js
 * 共享安全工具模块：路径清洗、JSON 响应、常量时间比对、HMAC-SHA256 会话令牌与 Cookie 工具
 */

const SESSION_COOKIE_NAME = 'r2_session';
const DEFAULT_SESSION_TTL = 7 * 24 * 60 * 60; // 7 天

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * 规范化并清洗文件 Key (防止目录穿越与多重斜杠)
 * @param {string} key
 * @returns {string}
 */
export function sanitizeKey(key) {
  if (!key || typeof key !== 'string') return '';
  const raw = key
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\\/g, '/')
    .trim();
  if (!raw) return '';
  const trailingSlash = raw.endsWith('/');
  const parts = raw.split('/').filter(p => p && p !== '..' && p !== '.');
  if (parts.length === 0) return '';
  return parts.join('/') + (trailingSlash ? '/' : '');
}

/**
 * 构造 JSON 响应（默认禁止缓存）
 * @param {object} data
 * @param {number} status
 * @param {Record<string, string>} extraHeaders
 * @returns {Response}
 */
export function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

/**
 * 克隆 Response 并覆写部分 Header（用于分离内部 Edge Cache 头与客户端私密响应头）
 * @param {Response} response
 * @param {Record<string, string>} headerOverrides
 * @returns {Response}
 */
export function withHeaders(response, headerOverrides = {}) {
  const isNoBody = [204, 205, 304].includes(response.status);
  const newRes = new Response(isNoBody ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
  for (const [k, v] of Object.entries(headerOverrides)) {
    if (v === null || v === undefined) {
      newRes.headers.delete(k);
    } else {
      newRes.headers.set(k, v);
    }
  }
  return newRes;
}

/**
 * 基于 SHA-256 摘要的常量时间字符串比对，防止时序侧信道攻击
 * @param {string} a
 * @param {string} b
 * @returns {Promise<boolean>}
 */
export async function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  const viewA = new Uint8Array(hashA);
  const viewB = new Uint8Array(hashB);
  if (typeof crypto.subtle.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(viewA, viewB);
  }
  let diff = 0;
  for (let i = 0; i < viewA.length; i++) {
    diff |= viewA[i] ^ viewB[i];
  }
  return diff === 0;
}

function toBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(str.length / 4) * 4, '=');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

async function getHmacKey(env) {
  const secretSource = (env && (env.SESSION_SECRET || env.DRIVE_PASSWORD)) || '';
  if (!secretSource) {
    throw new Error('Missing SESSION_SECRET or DRIVE_PASSWORD');
  }
  const keyMaterial = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`enwaycloud-session-v1:${secretSource}`)
  );
  return crypto.subtle.importKey(
    'raw',
    keyMaterial,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

/**
 * 签发带过期时间的 HMAC-SHA256 会话令牌
 * @param {object} env
 * @param {number} ttlSeconds
 * @returns {Promise<string>}
 */
export async function signSessionToken(env, ttlSeconds = DEFAULT_SESSION_TTL) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = JSON.stringify({ exp, v: 1 });
  const payloadB64 = toBase64Url(encoder.encode(payload));
  const key = await getHmacKey(env);
  const sigBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadB64));
  const sigB64 = toBase64Url(new Uint8Array(sigBuffer));
  return `${payloadB64}.${sigB64}`;
}

/**
 * 校验 HMAC-SHA256 会话令牌
 * @param {string} token
 * @param {object} env
 * @returns {Promise<boolean>}
 */
export async function verifySessionToken(token, env) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return false;

  try {
    const key = await getHmacKey(env);
    const sigBytes = fromBase64Url(sigB64);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes,
      encoder.encode(payloadB64)
    );
    if (!valid) return false;

    const payload = JSON.parse(decoder.decode(fromBase64Url(payloadB64)));
    if (!payload || payload.v !== 1 || typeof payload.exp !== 'number') return false;
    return payload.exp > Math.floor(Date.now() / 1000);
  } catch (_) {
    return false;
  }
}

/**
 * 解析请求中的指定 Cookie
 * @param {Request} request
 * @param {string} name
 * @returns {string}
 */
export function parseCookie(request, name = SESSION_COOKIE_NAME) {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return '';
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const k = pair.slice(0, eqIdx).trim();
    if (k === name) {
      const rawVal = pair.slice(eqIdx + 1).trim();
      try {
        return decodeURIComponent(rawVal);
      } catch (_) {
        return rawVal;
      }
    }
  }
  return '';
}

/**
 * 构造 HttpOnly 会话 Cookie 字符串
 */
export function buildSessionCookie(token, requestUrl, maxAge = DEFAULT_SESSION_TTL) {
  const isHttps = new URL(requestUrl).protocol === 'https:';
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/api',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (isHttps) parts.push('Secure');
  return parts.join('; ');
}

/**
 * 构造清除会话 Cookie 字符串
 */
export function buildClearSessionCookie(requestUrl) {
  return buildSessionCookie('', requestUrl, 0);
}

export { SESSION_COOKIE_NAME, DEFAULT_SESSION_TTL };
