import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolvePublicTarget, parseTarget } from './security.mjs';
import { rewriteHTML, rewriteCSS } from './rewrite.mjs';

const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 5;
const MAX_CONCURRENT = 20;

// Exported for deterministic redirect/DNS tests without connecting to private fixture servers.
export async function retrieve(value, { resolve = resolvePublicTarget, request = requestPinned, documentOrigin = null } = {}) {
  let current = value;
  const deadline = Date.now() + TIMEOUT_MS;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    if (documentOrigin && new URL(current).origin !== documentOrigin) throw new Error("La navegación debe permanecer en el sitio del proyecto");
    let dnsTimer;
    const destination = await Promise.race([
      resolve(current),
      new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(new Error('Tiempo de espera DNS agotado')), Math.max(1, deadline - Date.now())); }),
    ]).finally(() => clearTimeout(dnsTimer));
    if (Date.now() >= deadline) throw new Error('Tiempo de espera agotado');
    const result = await request(destination, Math.max(1, deadline - Date.now()));
    if ([301, 302, 303, 307, 308].includes(result.status) && result.headers.location) {
      if (redirects === MAX_REDIRECTS) throw new Error('Demasiadas redirecciones');
      current = parseTarget(new URL(result.headers.location, destination.target).href).href;
      continue;
    }
    return { ...result, target: destination.target };
  }
  throw new Error('Demasiadas redirecciones');
}

export function requestPinned({ target, address, family }, timeout) {
  return new Promise((resolve, reject) => {
    const transport = target.protocol === 'https:' ? https : http;
    // The hostname remains upstream's for Host and TLS/SNI; lookup always returns the validated IP.
    const request = transport.get(target, {
      agent: false,
      lookup: (_hostname, options, callback) => options.all
        ? callback(null, [{ address, family }]) : callback(null, address, family),
      headers: { 'user-agent': 'SpotCheck-Review/1.0', accept: '*/*', 'accept-encoding': 'identity' },
    }, (response) => {
      response.on('error', reject);
      const status = response.statusCode || 502;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.destroy();
        resolve({ status, headers: response.headers, body: Buffer.alloc(0) });
        return;
      }
      // Reject unexpected compression rather than forwarding compressed HTML without rewriting.
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
        response.destroy(new Error('El destino no admite transferencia sin compresión'));
        return;
      }
      const length = Number(response.headers['content-length']);
      if (length > MAX_BYTES) { response.destroy(new Error('Respuesta demasiado grande')); return; }
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) response.destroy(new Error('Respuesta demasiado grande'));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve({ status, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    // Absolute deadline, not only inactivity; slow-drip responses cannot keep a request alive.
    const timer = setTimeout(() => request.destroy(new Error('Tiempo de espera agotado')), timeout);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
  });
}

function configuredOrigin(value, name) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) throw new Error(`${name} debe ser un origen HTTP(S) exacto`);
  return url.origin;
}

export async function createProxyServer({
  appOrigin = process.env.APP_ORIGIN || 'http://localhost:3001',
  proxyOrigin = process.env.PROXY_ORIGIN || 'http://localhost:3002',
  load = retrieve,
} = {}) {
  configuredOrigin(appOrigin, 'APP_ORIGIN');
  configuredOrigin(proxyOrigin, 'PROXY_ORIGIN');
  if (appOrigin === proxyOrigin) throw new Error('El proxy debe estar en un origen separado de la aplicación');
  const inspector = await readFile(new URL('./public/spotcheck-inspector.js', import.meta.url));
  let active = 0;
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    response.setHeader('Content-Security-Policy', `default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${appOrigin}`);
    const url = new URL(request.url || '/', proxyOrigin);
    if (request.method !== 'GET') { response.writeHead(405, { Allow: 'GET' }); response.end('Solo GET'); return; }
    if (url.pathname === '/health') { response.end('ok'); return; }
    if (url.pathname === '/spotcheck-inspector.js') {
      response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' }); response.end(inspector); return;
    }
    if (url.pathname !== '/' || !url.searchParams.get('url')) { response.writeHead(400); response.end('Falta una URL válida'); return; }
    if (active >= MAX_CONCURRENT) { response.writeHead(503); response.end('Proxy ocupado'); return; }
    active++;
    try {
      const target = parseTarget(url.searchParams.get('url'));
      const documentOrigin = url.searchParams.get("document") === "1" ? configuredOrigin(url.searchParams.get("siteOrigin") || target.origin, "siteOrigin") : null;
      if (documentOrigin && target.origin !== documentOrigin) throw new Error("Documento externo no permitido");
      const upstream = await load(target.href, { documentOrigin });
      if (documentOrigin && upstream.target.origin !== documentOrigin) throw new Error("Redirección externa no permitida");
      if (response.destroyed) return;
      // Canonicalize redirects in the browser too, so navigation/inspector metadata uses the final URL.
      if (upstream.target.href !== target.href) {
        const redirect = new URL("/", proxyOrigin);
        redirect.searchParams.set("url", upstream.target.href);
        if (documentOrigin) { redirect.searchParams.set("document", "1"); redirect.searchParams.set("siteOrigin", documentOrigin); }
        response.writeHead(302, { Location: redirect.href });
        response.end(); return;
      }
      const contentType = upstream.headers['content-type'] || 'application/octet-stream';
      let body = upstream.body;
      if (/^text\/html\b/i.test(contentType)) body = rewriteHTML(body.toString('utf8'), target.href, proxyOrigin, appOrigin, documentOrigin);
      else if (/^text\/css\b/i.test(contentType)) body = rewriteCSS(body.toString('utf8'), target.href, proxyOrigin);
      // Public upstream assets carry no user credentials. Reuse them across project routes;
      // documents and errors keep no-store so navigation remains fresh.
      if (upstream.status === 200 && /^(?:image\/|font\/|text\/css\b|(?:application|text)\/(?:javascript|x-javascript|font-woff|vnd\.ms-fontobject)\b)/i.test(contentType)) {
        response.setHeader('Cache-Control', 'public, max-age=300');
      }
      response.writeHead(upstream.status, { 'Content-Type': /^text\/(html|css)\b/i.test(contentType) ? `${contentType.split(';')[0]}; charset=utf-8` : contentType });
      response.end(body);
    } catch {
      if (!response.destroyed) {
        response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('No se pudo revisar este destino. Solo se permiten sitios públicos HTTP(S), sin autenticación y dentro de los límites del proxy.');
      }
    } finally { active--; }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 100;
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = await createProxyServer();
  server.listen(Number(process.env.PORT || 3002), '0.0.0.0', () => console.log('SpotCheck isolated review proxy ready'));
}
