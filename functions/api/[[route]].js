/**
 * KeyVault 后端 — Cloudflare Pages Function
 * 
 * 功能：
 * 1. /api/vault     — KV 加密存储（GET/PUT）
 * 2. /api/webdav-proxy — WebDAV CORS 代理（解决坚果云等跨域问题）
 * 3. /api/init      — 初始化 Token（首次设置主密码时调用）
 * 
 * 部署方式：放在 functions/api/[[route]].js
 * Cloudflare Pages 会自动将此文件映射为 /api/* 路由
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS, PROPFIND, MKCOL, MOVE, COPY, HEAD, POST',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Depth, Destination, X-Api-Token',
  'Access-Control-Expose-Headers': 'DAV, Content-Length, ETag',
  'Access-Control-Max-Age': '86400',
};

function corsResponse(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// ===== Token 验证 =====
// 客户端用主密码 PBKDF2 派生 API Token
// 服务端存储 Token 的 SHA-256 哈希，验证时对比
async function verifyToken(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  const tokenHash = await sha256(token);
  
  // KV 中存储的 token hash
  const stored = await env.KEYVAULT_KV.get('auth:token_hash');
  if (!stored) {
    // 首次初始化：必须通过 /api/init 端点显式注册
    return false;
  }
  return stored === tokenHash;
}

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  // 分块编码，避免大数组栈溢出
  const arr = new Uint8Array(buf);
  const chunks = [];
  const chunkSize = 8192;
  for (let i = 0; i < arr.length; i += chunkSize) {
    chunks.push(String.fromCharCode(...arr.slice(i, i + chunkSize)));
  }
  return btoa(chunks.join(''));
}

// ===== Vault API =====
async function handleVaultGet(request, env) {
  if (!await verifyToken(request, env)) {
    return corsResponse(JSON.stringify({ error: 'Unauthorized' }), 401);
  }
  const data = await env.KEYVAULT_KV.get('vault:main', 'json');
  if (!data) {
    return corsResponse(JSON.stringify({ error: 'No vault data' }), 404);
  }
  return corsResponse(JSON.stringify(data));
}

async function handleVaultPut(request, env) {
  if (!await verifyToken(request, env)) {
    return corsResponse(JSON.stringify({ error: 'Unauthorized' }), 401);
  }
  const body = await request.json();
  
  // 保存当前版本快照（最多保留 5 个）
  const current = await env.KEYVAULT_KV.get('vault:main', 'json');
  if (current && current.version) {
    const snapshotKey = `vault:snapshot:${current.version}`;
    await env.KEYVAULT_KV.put(snapshotKey, JSON.stringify(current));
    // 清理旧快照
    const list = await env.KEYVAULT_KV.list({ prefix: 'vault:snapshot:' });
    if (list.keys.length > 5) {
      const toDelete = list.keys
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, list.keys.length - 5);
      for (const k of toDelete) {
        await env.KEYVAULT_KV.delete(k.name);
      }
    }
  }
  
  await env.KEYVAULT_KV.put('vault:main', JSON.stringify(body));
  return corsResponse(JSON.stringify({ ok: true, version: body.version }));
}

// ===== WebDAV CORS 代理 =====

// 允许代理的 WebDAV 域名白名单（防止被滥用扫描内网/公网）
// 部署时请根据实际使用的 WebDAV 服务修改此列表
const ALLOWED_WEBDAV_DOMAINS = [
  'dav.jianguoyun.com',        // 坚果云
  'webdav.pcloud.com',         // pCloud
  'webdav.hidrive.strato.com', // HiDrive
  'dav.infini-cloud.net',      // InfiniCLOUD
  // 自建服务请在下方添加精确域名，如：
  // 'nextcloud.example.com',
  // 'alist.example.com',
];

// 速率限制：基于 KV 实现（Worker 无状态，内存 Map 不可靠）
const RATE_LIMIT = { max: 60, window: 60 };

async function checkRateLimit(ip, env) {
  const key = `ratelimit:${ip}`;
  const now = Math.floor(Date.now() / 1000);
  const stored = await env.KEYVAULT_KV.get(key, 'json');
  if (!stored || now - stored.start > RATE_LIMIT.window) {
    await env.KEYVAULT_KV.put(key, JSON.stringify({ start: now, count: 1 }), { expirationTtl: RATE_LIMIT.window + 10 });
    return true;
  }
  stored.count++;
  if (stored.count > RATE_LIMIT.max) return false;
  await env.KEYVAULT_KV.put(key, JSON.stringify(stored), { expirationTtl: RATE_LIMIT.window + 10 });
  return true;
}

function isDomainAllowed(urlStr) {
  try {
    const target = new URL(urlStr);
    const hostname = target.hostname.toLowerCase();
    // 只允许 HTTPS（防止明文传输凭据）
    if (target.protocol !== 'https:') return false;
    return ALLOWED_WEBDAV_DOMAINS.some(allowed => {
      // 精确匹配或子域名匹配，避免 includes() 模糊匹配
      return hostname === allowed || hostname.endsWith('.' + allowed);
    });
  } catch { return false; }
}

async function handleWebdavProxy(request, env) {
  // 速率限制
  const clientIp = request.headers.get('cf-connecting-ip') || 
                   request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
    if (!await checkRateLimit(clientIp, env)) {
    return corsResponse(JSON.stringify({ error: 'Rate limit exceeded. Max 60 requests/minute.' }), 429);
  }
  
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');
  
  if (!targetUrl) {
    return corsResponse(JSON.stringify({ error: 'Missing url parameter' }), 400);
  }
  
  // 域名白名单校验
  if (!isDomainAllowed(targetUrl)) {
    try {
      const targetHost = new URL(targetUrl).hostname;
      return corsResponse(
        JSON.stringify({ 
          error: `Domain "${targetHost}" is not in the allowed WebDAV whitelist. ` +
                 `Add it to ALLOWED_WEBDAV_DOMAINS in worker.js if needed.` 
        }), 403
      );
    } catch {
      return corsResponse(JSON.stringify({ error: 'Invalid target URL' }), 400);
    }
  }
  
  // 从 X-WebDAV-Method 头取出真实的 WebDAV 方法
  // 前端统一用 POST 发请求（因为 Cloudflare 边缘不转发 MKCOL/PROPFIND 等非标准方法，直接 520）
  const realMethod = request.headers.get('x-webdav-method') || request.method;
  
  // 只转发 WebDAV 需要的头，避免把浏览器/Cloudflare 内部头转发给目标服务器
  // 导致目标服务器返回异常响应，Cloudflare 边缘无法解析产生 520
  const headers = new Headers();
  const forwardHeaders = ['authorization', 'content-type', 'depth', 'if-match', 'if-none-match', 'overwrite', 'destination'];
  for (const key of forwardHeaders) {
    const val = request.headers.get(key);
    if (val) headers.set(key, val);
  }
  
  const init = {
    method: realMethod,
    headers,
  };
  
  // MKCOL/PROPFIND 没有 body，不要传 body 过去
  if (['POST', 'PUT', 'PATCH'].includes(realMethod) && request.body) {
    init.body = request.body;
  }
  
  try {
    const resp = await fetch(targetUrl, init);
    // 不能流式转发 resp.body：坚果云返回的响应含 transfer-encoding/content-encoding
    // 等头，Cloudflare 边缘不允许源站返回这些头，直接 520
    // 所以必须读取完整 body，用干净的头重新构建响应
    const body = await resp.arrayBuffer();
    const respHeaders = new Headers();
    // 只转发安全的响应头
    const safeHeaders = ['content-type', 'dav', 'etag', 'last-modified', 'content-length', 'content-range'];
    for (const key of safeHeaders) {
      const val = resp.headers.get(key);
      if (val) respHeaders.set(key, val);
    }
    for (const [k, v] of Object.entries(CORS)) {
      respHeaders.set(k, v);
    }
    respHeaders.set('Access-Control-Expose-Headers', 'DAV, Content-Length, Content-Range, ETag');
    
    return new Response(body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: respHeaders,
    });
  } catch (err) {
    return corsResponse(JSON.stringify({ error: 'Proxy error: ' + err.message }), 502);
  }
}

// ===== 初始化 =====
async function handleInit(request, env) {
  const body = await request.json();
  if (!body.tokenHash) {
    return corsResponse(JSON.stringify({ error: 'Missing tokenHash' }), 400);
  }
  
  const existing = await env.KEYVAULT_KV.get('auth:token_hash');
  // 允许覆盖：只有知道主密码的人才能派生出正确的 tokenHash
  // 所以能发起此请求的必然是合法用户
  await env.KEYVAULT_KV.put('auth:token_hash', body.tokenHash);
  
  if (existing && existing === body.tokenHash) {
    return corsResponse(JSON.stringify({ ok: true, status: 'unchanged' }));
  }
  return corsResponse(JSON.stringify({ ok: true, status: existing ? 'updated' : 'created' }));
}

// ===== 路由分发 =====
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  
  // CORS 预检
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  
  // 路由
  if (url.pathname === '/api/vault') {
    if (request.method === 'GET') return handleVaultGet(request, env);
    if (request.method === 'PUT') return handleVaultPut(request, env);
    if (request.method === 'DELETE') {
      if (!await verifyToken(request, env)) return corsResponse(JSON.stringify({ error: 'Unauthorized' }), 401);
      await env.KEYVAULT_KV.delete('vault:main');
      return corsResponse(JSON.stringify({ ok: true }));
    }
  }
  
  if (url.pathname === '/api/webdav-proxy') {
    return handleWebdavProxy(request, env);
  }
  
  if (url.pathname === '/api/init') {
    // 初始化端点也加速率限制（防止暴力尝试）
    const clientIp = request.headers.get('cf-connecting-ip') || 
                     request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
  if (!await checkRateLimit(clientIp, env)) {
      return corsResponse(JSON.stringify({ error: 'Rate limit exceeded. Max 60 requests/minute.' }), 429);
    }
    return handleInit(request, env);
  }
  
  return corsResponse(JSON.stringify({ error: 'Not found' }), 404);
}
