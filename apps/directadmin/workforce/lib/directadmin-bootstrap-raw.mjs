import http from 'node:http';
import { constants as fsConstants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const MAX_HEADER_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 8192;
const BODY_TIMEOUT_MS = 1000;
const UPSTREAM_TIMEOUT_MS = 7000;
const PRIVATE_HOST = '127.0.0.1';
const PRIVATE_PORT = 3010;
const ROUTES = Object.freeze({
  nonce: Object.freeze({ path: '/v1/directadmin/bootstrap-nonce', query: 'headers_to_env=yes&pipe_post=yes' }),
  bootstrap: Object.freeze({ path: '/v1/directadmin/bootstrap', query: 'headers_to_env=yes&pipe_post=yes' }),
});
const COOKIE_NAME = '__Host-titan-da-session';
const COOKIE_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/;
const SESSION_TOKEN = /^[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,4096}$/;
const NONCE = /^[A-Za-z0-9_-]{43,128}$/;

const responseSecurityHeaders = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
  'X-Frame-Options': 'SAMEORIGIN',
});

function failure(status, error) {
  return { status, body: { error, read_only: true } };
}

function parseQuery(value, action) {
  if (typeof value !== 'string' || value !== ROUTES[action].query) throw new Error('invalid-transport-flags');
  const entries = value.split('&').map(pair => pair.split('='));
  if (entries.length !== 2 || entries.some(pair => pair.length !== 2)
    || entries[0][0] !== 'headers_to_env' || entries[0][1] !== 'yes'
    || entries[1][0] !== 'pipe_post' || entries[1][1] !== 'yes') throw new Error('invalid-transport-flags');
}

function parseHeaders(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_HEADER_BYTES * 3
    || /%(?![0-9a-f]{2})/i.test(value)) throw new Error('invalid-headers');
  let decoded;
  // Accept both RFC 3986 percent encoding and standard form-style URL
  // encoding. Literal plus signs must be escaped as %2B in either transport.
  try { decoded = decodeURIComponent(value.replace(/\+/g, ' ')); } catch { throw new Error('invalid-headers'); }
  if (Buffer.byteLength(decoded, 'utf8') > MAX_HEADER_BYTES || /\u0000/.test(decoded)) throw new Error('invalid-headers');
  const normalized = decoded.replace(/\r\n/g, '\n');
  if (normalized.includes('\r')) throw new Error('invalid-headers');
  const headers = new Map();
  for (const line of normalized.split('\n')) {
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 1) throw new Error('invalid-headers');
    const name = line.slice(0, separator).toLowerCase();
    const raw = line.slice(separator + 1).replace(/^\s+|\s+$/g, '');
    if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(name) || /[\r\n\u0000-\u001f\u007f]/.test(raw) || headers.has(name)) {
      throw new Error('invalid-headers');
    }
    headers.set(name, raw);
  }
  return headers;
}

function readCookiePair(value) {
  const separator = value.indexOf('=');
  if (separator <= 0) throw new Error('invalid-cookie');
  const name = value.slice(0, separator);
  const cookieValue = value.slice(separator + 1);
  if (!COOKIE_TOKEN.test(name) || !COOKIE_VALUE.test(cookieValue)) throw new Error('invalid-cookie');
  return [name, cookieValue];
}

function cookiesForAction(value, action) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384 || /[\r\n\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('invalid-cookie');
  }
  const parsed = new Map();
  for (const raw of value.split(';')) {
    const part = raw.trim();
    if (!part) throw new Error('invalid-cookie');
    const [name, cookieValue] = readCookiePair(part);
    if (!['session', 'key', COOKIE_NAME].includes(name) || parsed.has(name)) {
      throw new Error('invalid-cookie');
    }
    if (name === COOKIE_NAME && !SESSION_TOKEN.test(cookieValue)) throw new Error('invalid-cookie');
    parsed.set(name, cookieValue);
  }
  if (!parsed.has('session') || !parsed.has('key')) throw new Error('invalid-cookie');
  const entries = [`session=${parsed.get('session')}`, `key=${parsed.get('key')}`];
  if (action === 'bootstrap' && parsed.has(COOKIE_NAME)) entries.push(`${COOKIE_NAME}=${parsed.get(COOKIE_NAME)}`);
  return entries.join('; ');
}

function validateRequest(env, action, input) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('invalid-environment');
  if (env.REQUEST_METHOD !== 'POST' || env.POST !== 'stdin=true') throw new Error('invalid-method');
  parseQuery(env.QUERY_STRING, action);
  if (env.CONTENT_TYPE !== undefined && env.CONTENT_TYPE !== '') throw new Error('invalid-content-type');
  if (env.CONTENT_LENGTH !== undefined && !/^0+$/.test(env.CONTENT_LENGTH)) throw new Error('invalid-content-length');
  if (!Buffer.isBuffer(input) || input.byteLength !== 0) throw new Error('invalid-body');

  const headers = parseHeaders(env.HEADERS);
  for (const name of ['host', 'origin', 'sec-fetch-site', 'cookie']) if (!headers.has(name)) throw new Error('required-header-missing');
  if (headers.get('sec-fetch-site') !== 'same-origin') throw new Error('fetch-site-invalid');
  if (headers.has('transfer-encoding') || headers.has('content-encoding') || headers.has('content-type')) throw new Error('request-encoding-invalid');
  const declared = headers.get('content-length');
  if (declared !== undefined && !/^0+$/.test(declared)) throw new Error('content-length-invalid');
  if (headers.has('authorization') || headers.has('proxy-authorization') || headers.has('x-titan-csrf')) throw new Error('identity-header-forbidden');
  for (const name of headers.keys()) {
    if ((name.startsWith('x-titan-') && !(action === 'bootstrap' && name === 'x-titan-da-bootstrap-csrf'))
      || name.startsWith('directadmin-') || name.startsWith('x-directadmin-')) throw new Error('identity-header-forbidden');
  }

  const origin = headers.get('origin');
  let parsedOrigin;
  try { parsedOrigin = new URL(origin); } catch { throw new Error('origin-invalid'); }
  if (parsedOrigin.protocol !== 'https:' || parsedOrigin.origin !== origin || parsedOrigin.username || parsedOrigin.password
    || parsedOrigin.pathname !== '/' || parsedOrigin.search || parsedOrigin.hash || parsedOrigin.host !== headers.get('host')) {
    throw new Error('origin-invalid');
  }
  const referer = headers.get('referer');
  if (referer !== undefined) {
    try { if (new URL(referer).origin !== origin) throw new Error(); }
    catch { throw new Error('referer-invalid'); }
  }

  const csrfNonce = headers.get('x-titan-da-bootstrap-csrf');
  if (action === 'nonce' && csrfNonce !== undefined) throw new Error('unexpected-nonce');
  if (action === 'bootstrap' && (typeof csrfNonce !== 'string' || !NONCE.test(csrfNonce))) throw new Error('bootstrap-nonce-invalid');
  const cookie = cookiesForAction(headers.get('cookie'), action);
  return Object.freeze({ origin, publicHost: parsedOrigin.host, cookie, csrfNonce });
}

async function readStdinBounded(stream, timeoutMs = BODY_TIMEOUT_MS) {
  const chunks = [];
  let length = 0;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { stream.destroy?.(); } catch { /* best effort closes DA's input pipe */ }
      reject(new Error('body-timeout'));
    }, timeoutMs);
  });
  const read = (async () => {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      if (length > MAX_BODY_BYTES) throw new Error('body-too-large');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, length);
  })();
  try { return await Promise.race([read, timeout]); }
  finally { clearTimeout(timer); }
}

function parseExactJson(buffer, expectedKeys) {
  let text;
  let result;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    result = JSON.parse(text);
  } catch { throw new Error('invalid-upstream-json'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).length !== expectedKeys.length || Object.keys(result).some(key => !expectedKeys.includes(key))
    || JSON.stringify(result) !== text) throw new Error('invalid-upstream-json');
  return result;
}

function headerValues(response, wanted) {
  const result = new Map();
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index].toLowerCase();
    if (!wanted.has(name)) continue;
    const values = result.get(name) ?? [];
    values.push(response.rawHeaders[index + 1]);
    result.set(name, values);
  }
  return result;
}

function validSessionSetCookie(value) {
  if (typeof value !== 'string' || value.length > 4096) return false;
  const match = new RegExp(`^${COOKIE_NAME}=(${SESSION_TOKEN.source.slice(1, -1)}); Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=([1-9][0-9]*)$`).exec(value);
  return Boolean(match && Number(match[2]) <= 300);
}

const CLEAR_SESSION_COOKIE = `${COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;

function sanitizeUpstream(action, status, bytes, values) {
  const contentTypes = values.get('content-type') ?? [];
  if (contentTypes.length !== 1 || contentTypes[0].split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new Error('upstream-response-invalid');
  }
  const setCookies = values.get('set-cookie') ?? [];
  if (status === 200) {
    const body = parseExactJson(bytes, action === 'nonce' ? ['csrf_nonce'] : ['csrf_token']);
    if (action === 'nonce') {
      if (!NONCE.test(body.csrf_nonce) || setCookies.length !== 0) throw new Error('upstream-response-invalid');
      return { status: 200, body: { csrf_nonce: body.csrf_nonce } };
    }
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(body.csrf_token) || setCookies.length !== 1 || !validSessionSetCookie(setCookies[0])) {
      throw new Error('upstream-response-invalid');
    }
    return { status: 200, body: { csrf_token: body.csrf_token }, setCookie: setCookies[0] };
  }
  let error;
  if (status === 401) error = 'directadmin-session-rejected';
  else if (status === 409 && action === 'bootstrap') error = 'directadmin-session-binding-mismatch';
  else if (status === 503) error = 'directadmin-bootstrap-unavailable';
  else throw new Error('upstream-response-invalid');
  if (bytes.length > MAX_BODY_BYTES) throw new Error('upstream-response-invalid');
  const body = parseExactJson(bytes, ['error', 'read_only']);
  if (body.read_only !== true || !['directadmin-session-rejected', 'directadmin-bootstrap-unavailable', 'directadmin-session-binding-mismatch'].includes(body.error)) {
    throw new Error('upstream-response-invalid');
  }
  if ((status === 401 && body.error !== 'directadmin-session-rejected')
    || (status === 409 && body.error !== 'directadmin-session-binding-mismatch')
    || (status === 503 && body.error !== 'directadmin-bootstrap-unavailable')) throw new Error('upstream-response-invalid');
  if (setCookies.length > 1 || (setCookies.length === 1 && setCookies[0] !== CLEAR_SESSION_COOKIE)) throw new Error('upstream-response-invalid');
  if (action === 'nonce' && setCookies.length !== 0) throw new Error('upstream-response-invalid');
  return { status, body: failure(status, error).body, ...(setCookies.length === 1 ? { setCookie: setCookies[0] } : {}) };
}

function callPrivateWorkforce(target, action) {
  return testPrivatePort().then(port => new Promise((resolve, reject) => {
    const headers = {
      host: target.publicHost,
      origin: target.origin,
      'sec-fetch-site': 'same-origin',
      cookie: target.cookie,
      accept: 'application/json',
      'content-length': '0',
    };
    if (action === 'bootstrap') headers['x-titan-da-bootstrap-csrf'] = target.csrfNonce;
    const request = http.request({
      host: PRIVATE_HOST,
      port,
      method: 'POST',
      path: ROUTES[action].path,
      headers,
      agent: false,
      maxHeaderSize: MAX_HEADER_BYTES,
    }, response => {
      const values = headerValues(response, new Set(['content-type', 'set-cookie']));
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_BODY_BYTES) {
          request.destroy(new Error('upstream-response-too-large'));
          return;
        }
        chunks.push(bytes);
      });
      response.once('error', () => { clearTimeout(deadline); reject(new Error('upstream-unavailable')); });
      response.once('end', () => {
        clearTimeout(deadline);
        try { resolve(sanitizeUpstream(action, response.statusCode ?? 0, Buffer.concat(chunks, size), values)); }
        catch { reject(new Error('upstream-response-invalid')); }
      });
    });
    const deadline = setTimeout(() => request.destroy(new Error('upstream-timeout')), UPSTREAM_TIMEOUT_MS);
    request.once('error', () => { clearTimeout(deadline); reject(new Error('upstream-unavailable')); });
    request.end();
  }));
}

async function testPrivatePort() {
  // Disposable tests may select an ephemeral port only from a private file
  // beneath tmpdir. Production requests always use the fixed #811 loopback
  // listener and never consult CGI-provided target data.
  const filename = process.env.NODE_ENV === 'test' ? process.env.TITAN_WORKFORCE_DIRECTADMIN_RAW_TEST_CONFIG : undefined;
  if (filename === undefined || filename === '') return PRIVATE_PORT;
  if (typeof filename !== 'string' || !isAbsolute(filename) || resolve(filename) !== filename) {
    throw new Error('private-target-invalid');
  }
  let canonicalFilename;
  let canonicalTempDirectory;
  try {
    [canonicalFilename, canonicalTempDirectory] = await Promise.all([realpath(filename), realpath(tmpdir())]);
  } catch { throw new Error('private-target-invalid'); }
  const relativePath = relative(canonicalTempDirectory, canonicalFilename);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error('private-target-invalid');
  }
  let file;
  try {
    if (typeof fsConstants.O_NOFOLLOW !== 'number' || fsConstants.O_NOFOLLOW === 0) throw new Error();
    file = await open(canonicalFilename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch { throw new Error('private-target-invalid'); }
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o022) !== 0 || info.size > 6) throw new Error('private-target-invalid');
    const value = await file.readFile('utf8');
    if (!/^[1-9][0-9]{0,4}\n?$/.test(value)) throw new Error('private-target-invalid');
    const port = Number(value.trim());
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('private-target-invalid');
    return port;
  } finally { await file.close(); }
}

function writeRaw(stdout, result) {
  const statusText = ({ 200: 'OK', 400: 'Bad Request', 401: 'Unauthorized', 409: 'Conflict', 503: 'Service Unavailable' })[result.status] ?? 'Service Unavailable';
  const body = Buffer.from(JSON.stringify(result.body), 'utf8');
  const headers = {
    ...responseSecurityHeaders,
    'Content-Length': String(body.length),
    Connection: 'close',
    ...(result.setCookie ? { 'Set-Cookie': result.setCookie } : {}),
  };
  const lines = [`HTTP/1.1 ${result.status} ${statusText}`, ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), '', ''];
  stdout.write(Buffer.concat([Buffer.from(lines.join('\r\n'), 'latin1'), body]));
}

export async function runDirectAdminBootstrapRaw(action, options = {}) {
  const env = options.env ?? process.env;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  let result;
  try {
    if (action !== 'nonce' && action !== 'bootstrap') throw new Error('invalid-action');
    const input = await readStdinBounded(stdin);
    const target = validateRequest(env, action, input);
    result = options.privateCall
      ? await options.privateCall(target, action)
      : await callPrivateWorkforce(target, action);
  } catch (error) {
    if (error instanceof Error && ['invalid-action', 'invalid-transport-flags', 'invalid-environment', 'invalid-method', 'invalid-headers',
      'invalid-content-type', 'invalid-content-length', 'invalid-body', 'required-header-missing', 'fetch-site-invalid',
      'request-encoding-invalid', 'content-length-invalid', 'identity-header-forbidden', 'origin-invalid', 'referer-invalid',
      'unexpected-nonce', 'bootstrap-nonce-invalid', 'invalid-cookie', 'body-timeout', 'body-too-large'].includes(error.message)) {
      result = failure(400, 'invalid_request');
    } else if (error instanceof Error && error.message === 'upstream-response-invalid') {
      result = failure(503, 'directadmin-bootstrap-unavailable');
    } else {
      result = failure(503, 'directadmin-bootstrap-unavailable');
    }
  }
  writeRaw(stdout, result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const action = process.argv[2];
  void runDirectAdminBootstrapRaw(action);
}
