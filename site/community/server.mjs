#!/usr/bin/env node

import { createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdminServer } from './admin.mjs';
import { InputError, validateSubmission, validateVote } from './moderation.mjs';
import { RateLimiter } from './rate-limit.mjs';
import { CommunityStore, StoreError } from './store.mjs';

const BODY_LIMIT = 16 * 1024;
const DEFAULT_ORIGINS = ['https://tabmonger.com', 'https://www.tabmonger.com'];
const MIN_SALT_BYTES = 32;
const MAX_SALT_BYTES = 4_096;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
const API_PREFIX = '/api/community/';

const MIME_TYPES = new Map([
  ['.avif', 'image/avif'],
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.xml', 'application/xml; charset=utf-8'],
  ['.zip', 'application/zip'],
]);

class HttpError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function integer(value, fallback, { min, max }) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) throw new Error(`Invalid integer setting: ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Integer setting is outside the allowed range: ${value}`);
  }
  return parsed;
}

function normalizeOrigin(value) {
  if (typeof value !== 'string' || value.length > 256) throw new Error('Invalid allowed origin.');
  const parsed = new URL(value);
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || value !== parsed.origin
  ) {
    throw new Error(`Allowed origin must be an exact origin: ${value}`);
  }
  return parsed.origin;
}

function resolveConfig(options) {
  const env = options.env ?? process.env;
  const originsInput = options.allowedOrigins
    ?? (env.COMMUNITY_ALLOWED_ORIGINS
      ? env.COMMUNITY_ALLOWED_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean)
      : DEFAULT_ORIGINS);
  const allowedOrigins = new Set(originsInput.map(normalizeOrigin));
  if (allowedOrigins.size === 0) throw new Error('At least one COMMUNITY_ALLOWED_ORIGINS value is required.');

  const salt = options.salt ?? env.COMMUNITY_HASH_SALT;
  const saltBytes = typeof salt === 'string' ? Buffer.byteLength(salt, 'utf8') : 0;
  if (saltBytes < MIN_SALT_BYTES || saltBytes > MAX_SALT_BYTES) {
    throw new Error(`COMMUNITY_HASH_SALT must contain ${MIN_SALT_BYTES}-${MAX_SALT_BYTES} UTF-8 bytes.`);
  }

  const dataDir = path.resolve(options.dataDir ?? env.COMMUNITY_DATA_DIR ?? '/data/community');
  return {
    host: options.host ?? env.HOST ?? '0.0.0.0',
    port: integer(options.port ?? env.PORT, 8081, { min: 0, max: 65_535 }),
    staticRoot: path.resolve(options.staticRoot ?? env.STATIC_ROOT ?? '/app/dist'),
    dataDir,
    adminSocketPath: path.resolve(
      options.adminSocketPath ?? env.COMMUNITY_ADMIN_SOCKET ?? path.join(dataDir, 'admin.sock'),
    ),
    allowedOrigins,
    salt,
    trustProxy: options.trustProxy ?? env.COMMUNITY_TRUST_PROXY === '1',
    bodyLimit: integer(options.bodyLimit, BODY_LIMIT, { min: 1_024, max: 64 * 1_024 }),
    cleanupIntervalMs: options.cleanupIntervalMs ?? CLEANUP_INTERVAL_MS,
    rateLimits: options.rateLimits,
    now: options.now,
  };
}

function securityHeaders(response, { api = false } = {}) {
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; media-src 'self'; manifest-src 'self'; worker-src 'self'; upgrade-insecure-requests",
  );
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  if (api) response.setHeader('Cache-Control', 'no-store');
}

function json(response, status, body, extraHeaders = {}) {
  securityHeaders(response, { api: true });
  for (const [name, value] of Object.entries(extraHeaders)) response.setHeader(name, value);
  const payload = Buffer.from(JSON.stringify(body));
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', payload.length);
  response.end(payload);
}

function text(response, status, body) {
  securityHeaders(response);
  const payload = Buffer.from(body);
  response.statusCode = status;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Content-Length', payload.length);
  response.end(payload);
}

function exactSameOrigin(request, allowedOrigins) {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || origin.length > 256 || origin.includes(',')) return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (origin !== parsed.origin || !allowedOrigins.has(parsed.origin)) return false;
  const fetchSite = request.headers['sec-fetch-site'];
  return fetchSite === undefined || fetchSite === 'same-origin';
}

function normalizeAddress(value) {
  if (typeof value !== 'string' || value.length > 128) return null;
  let candidate = value.trim();
  if (candidate.startsWith('[') && candidate.includes(']')) candidate = candidate.slice(1, candidate.indexOf(']'));
  if (candidate.startsWith('::ffff:') && net.isIP(candidate.slice(7)) === 4) candidate = candidate.slice(7);
  return net.isIP(candidate) ? candidate.toLowerCase() : null;
}

function clientAddress(request, trustProxy) {
  if (trustProxy) {
    const cloudflare = normalizeAddress(request.headers['cf-connecting-ip']);
    if (cloudflare) return cloudflare;
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length <= 512) {
      const first = normalizeAddress(forwarded.split(',', 1)[0]);
      if (first) return first;
    }
  }
  return normalizeAddress(request.socket.remoteAddress) ?? 'unknown';
}

function hmac(salt, namespace, value) {
  return createHmac('sha256', salt).update(namespace).update('\0').update(value).digest('hex');
}

function readJson(request, limit) {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    throw new HttpError(415, 'json_required');
  }
  if (request.headers['content-encoding'] !== undefined) {
    throw new HttpError(415, 'content_encoding_not_supported');
  }
  const lengthHeader = request.headers['content-length'];
  if (lengthHeader !== undefined) {
    if (!/^\d+$/.test(lengthHeader)) throw new HttpError(400, 'invalid_content_length');
    if (Number(lengthHeader) > limit) throw new HttpError(413, 'body_too_large');
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAborted);
      request.off('error', onError);
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        request.resume();
        finish(new HttpError(413, 'body_too_large'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      let value;
      try {
        const payload = Buffer.concat(chunks, size).toString('utf8');
        if (payload.length === 0) throw new Error('empty');
        value = JSON.parse(payload);
      } catch {
        finish(new HttpError(400, 'invalid_json'));
        return;
      }
      finish(undefined, value);
    };
    const onAborted = () => finish(new HttpError(400, 'request_aborted'));
    const onError = () => finish(new HttpError(400, 'request_error'));
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onAborted);
    request.once('error', onError);
  });
}

function rateLimit(response, limiter, action, sourceHash) {
  const result = limiter.check(action, sourceHash);
  if (result.allowed) return true;
  json(response, 429, { ok: false, error: 'rate_limited' }, { 'Retry-After': String(result.retryAfter) });
  return false;
}

function rawPath(request) {
  const raw = request.url ?? '/';
  if (!raw.startsWith('/') || raw.length > 4_096) throw new HttpError(400, 'invalid_path');
  return raw.split('?', 1)[0];
}

function requestUrl(request) {
  try {
    return new URL(request.url ?? '/', 'http://community.internal');
  } catch {
    throw new HttpError(400, 'invalid_url');
  }
}

function safeDecodedPath(request) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath(request));
  } catch {
    throw new HttpError(400, 'invalid_path');
  }
  if (decoded.includes('\0') || decoded.includes('\\')) throw new HttpError(400, 'invalid_path');
  const segments = decoded.split('/');
  if (segments.some((segment) => segment === '..' || segment.startsWith('.'))) {
    throw new HttpError(400, 'invalid_path');
  }
  return decoded;
}

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function staticFile(staticRoot, decodedPath) {
  let root;
  try {
    root = await realpath(staticRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const requested = path.resolve(root, `.${decodedPath}`);
  if (!inside(root, requested)) throw new HttpError(400, 'invalid_path');
  const candidates = decodedPath.endsWith('/')
    ? [path.join(requested, 'index.html')]
    : [requested, path.join(requested, 'index.html')];

  for (const candidate of candidates) {
    let candidateReal;
    try {
      const candidateInfo = await lstat(candidate);
      if (candidateInfo.isDirectory()) continue;
      candidateReal = await realpath(candidate);
      if (!inside(root, candidateReal)) continue;
      const info = await stat(candidateReal);
      if (info.isFile()) return { filename: candidateReal, info };
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR' && error?.code !== 'EACCES') throw error;
    }
  }
  return null;
}

async function serveStatic(request, response, staticRoot) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    text(response, 405, 'Method not allowed.');
    return;
  }
  const decoded = safeDecodedPath(request);
  const file = await staticFile(staticRoot, decoded);
  if (!file) {
    text(response, 404, 'Not found.');
    return;
  }

  securityHeaders(response);
  const extension = path.extname(file.filename).toLowerCase();
  const etag = `W/\"${file.info.size.toString(16)}-${Math.trunc(file.info.mtimeMs).toString(16)}\"`;
  response.setHeader('Content-Type', MIME_TYPES.get(extension) ?? 'application/octet-stream');
  response.setHeader('Content-Length', file.info.size);
  response.setHeader('Last-Modified', file.info.mtime.toUTCString());
  response.setHeader('ETag', etag);
  if (decoded.startsWith('/_astro/')) {
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (extension === '.html') {
    response.setHeader('Cache-Control', 'no-cache');
  } else {
    response.setHeader('Cache-Control', 'public, max-age=300');
  }

  if (request.headers['if-none-match'] === etag) {
    response.statusCode = 304;
    response.removeHeader('Content-Length');
    response.end();
    return;
  }
  response.statusCode = 200;
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  const stream = createReadStream(file.filename);
  stream.once('error', () => response.destroy());
  stream.pipe(response);
}

async function apiRequest(request, response, context) {
  const url = requestUrl(request);
  if (url.search || url.hash) throw new HttpError(400, 'query_not_allowed');
  const sourceHash = hmac(context.config.salt, 'source', clientAddress(request, context.config.trustProxy));

  if (url.pathname === '/api/community/health') {
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      throw new HttpError(405, 'method_not_allowed');
    }
    await context.store.stats();
    json(response, 200, { ok: true, service: 'tabmonger-community', schemaVersion: 1 });
    return;
  }

  if (url.pathname === '/api/community/poll') {
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      throw new HttpError(405, 'method_not_allowed');
    }
    if (!rateLimit(response, context.limiter, 'poll', sourceHash)) return;
    json(response, 200, await context.store.getPublicPoll());
    return;
  }

  if (url.pathname === '/api/community/submissions') {
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      throw new HttpError(405, 'method_not_allowed');
    }
    if (!exactSameOrigin(request, context.config.allowedOrigins)) throw new HttpError(403, 'forbidden');
    if (!rateLimit(response, context.limiter, 'submission', sourceHash)) return;
    const submission = validateSubmission(await readJson(request, context.config.bodyLimit));
    if (!submission.honeypot) {
      await context.store.addSubmission({ ...submission, sourceHash });
    }
    json(response, 202, { ok: true });
    return;
  }

  if (url.pathname === '/api/community/vote') {
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      throw new HttpError(405, 'method_not_allowed');
    }
    if (!exactSameOrigin(request, context.config.allowedOrigins)) throw new HttpError(403, 'forbidden');
    if (!rateLimit(response, context.limiter, 'vote', sourceHash)) return;
    const vote = validateVote(await readJson(request, context.config.bodyLimit));
    const voterHash = hmac(context.config.salt, 'voter', vote.voterId);
    await context.store.recordVote(voterHash, vote.featureId);
    json(response, 200, { ok: true });
    return;
  }

  throw new HttpError(404, 'not_found');
}

function publicError(response, error, api) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  let status = 500;
  let code = 'internal_error';
  if (error instanceof HttpError || error instanceof StoreError) {
    status = error.status;
    code = error.code;
  } else if (error instanceof InputError) {
    status = 400;
    code = 'invalid_submission';
  }
  if (api) json(response, status, { ok: false, error: code });
  else text(response, status, status === 500 ? 'Internal server error.' : 'Request rejected.');
}

export async function createCommunityService(options = {}) {
  const config = resolveConfig(options);
  const store = new CommunityStore({
    dataDir: config.dataDir,
    now: config.now,
    onFatalError: () => {
      process.stderr.write('TabMonger community storage failed; service is unhealthy.\n');
      if (options.exitOnStorageFailure === true) {
        process.exitCode = 1;
        setImmediate(() => process.exit(1));
      }
    },
  });
  await store.init();
  const limiter = new RateLimiter({ limits: config.rateLimits });
  const context = { config, store, limiter };
  let admin;
  let cleanupTimer;

  const server = http.createServer((request, response) => {
    const api = (() => {
      try {
        return rawPath(request).startsWith(API_PREFIX);
      } catch {
        return false;
      }
    })();
    const work = api
      ? apiRequest(request, response, context)
      : serveStatic(request, response, config.staticRoot);
    work.catch((error) => publicError(response, error, api));
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  server.on('clientError', (_error, socket) => socket.destroy());

  return {
    config,
    store,
    server,
    get adminSocketPath() {
      return config.adminSocketPath;
    },
    address() {
      return server.address();
    },
    async listen() {
      if (server.listening) return server.address();
      admin = await createAdminServer({ store, socketPath: config.adminSocketPath });
      try {
        await new Promise((resolve, reject) => {
          const onError = (error) => {
            server.off('listening', onListening);
            reject(error);
          };
          const onListening = () => {
            server.off('error', onError);
            resolve();
          };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(config.port, config.host);
        });
      } catch (error) {
        await admin.close();
        admin = undefined;
        throw error;
      }
      if (Number.isFinite(config.cleanupIntervalMs) && config.cleanupIntervalMs > 0) {
        cleanupTimer = setInterval(() => store.cleanup().catch(() => {
          process.stderr.write('TabMonger community retention cleanup failed; service is unhealthy.\n');
          if (options.exitOnCleanupFailure === true) {
            process.exitCode = 1;
            setImmediate(() => process.exit(1));
          }
        }), config.cleanupIntervalMs);
        cleanupTimer.unref();
      }
      return server.address();
    },
    async close() {
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = undefined;
      }
      if (server.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
      if (admin) {
        await admin.close();
        admin = undefined;
      }
    },
  };
}

async function main() {
  const service = await createCommunityService({
    exitOnCleanupFailure: true,
    exitOnStorageFailure: true,
  });
  await service.listen();
  const shutdown = async () => {
    await service.close();
    process.exitCode = 0;
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`TabMonger community service failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });
}
