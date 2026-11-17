import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { isPublicAddress, parseTarget, resolvePublicTarget } from './security.mjs';
import { retrieve, createProxyServer, requestPinned } from './server.mjs';
import { rewriteHTML, rewriteCSS, proxyUrl } from './rewrite.mjs';

const APP = 'http://localhost:3001';
const PROXY = 'http://localhost:3002';

test('blocks IPv4, IPv6, mapped, metadata, multicast and reserved networks', () => {
  for (const ip of ['0.0.0.0', '127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '240.0.0.1', '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '64:ff9b::a00:1', '2001:db8::1'])
    assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
});

test('rejects schemes, credentials, alternate ports, and ambiguous private IP encodings', async () => {
  for (const url of ['file:///etc/passwd', 'http://user:password@example.com', 'https://example.com:8443']) assert.throws(() => parseTarget(url));
  for (const url of ['http://2130706433/', 'http://0x7f000001/', 'http://127.1/', 'http://[::ffff:127.0.0.1]/']) {
    await assert.rejects(resolvePublicTarget(url, async (hostname) => [{ address: hostname, family: hostname.includes(':') ? 6 : 4 }]));
  }
});

test('rejects mixed public/private DNS and returns one pinned public destination', async () => {
  await assert.rejects(resolvePublicTarget('https://example.com', async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]));
  const result = await resolvePublicTarget('https://example.com', async () => [{ address: '8.8.8.8', family: 4 }]);
  assert.equal(result.address, '8.8.8.8');
  assert.equal(result.target.hostname, 'example.com');
});

test('validates every redirect before making a connection and bounds redirect count', async () => {
  let requests = 0;
  const resolve = (url) => resolvePublicTarget(url, async (host) => [{ address: host === 'evil.example' ? '127.0.0.1' : '8.8.8.8', family: 4 }]);
  await assert.rejects(retrieve('https://example.com', {
    resolve,
    request: async () => { requests++; return { status: 302, headers: { location: 'http://evil.example/' } }; },
  }));
  assert.equal(requests, 1);
  requests = 0;
  await assert.rejects(retrieve('https://example.com', {
    resolve,
    request: async () => { requests++; return { status: 302, headers: { location: '/again' } }; },
  }), /redirecciones/);
  assert.equal(requests, 6);
});

test('rewrites links, bases, assets, CSS and injects inspector before upstream scripts', () => {
  const html = rewriteHTML('<html><head><base href="https://cdn.example/assets/"><script src="site.js" integrity="sha256-x"></script><style>.x { background: url(img.png) }</style></head><body><a href="/next#part" target="_top">Go</a><img src="a.png" srcset="https://bad.example 2x"><iframe srcdoc="bad"></iframe><meta http-equiv="refresh" content="0;url=x"></body></html>', 'https://example.com/start', PROXY, APP);
  assert.ok(html.indexOf('/spotcheck-inspector.js') < html.indexOf(encodeURIComponent('https://cdn.example/assets/site.js')));
  assert.ok(html.includes(`data-parent-origin="${APP}"`));
  assert.ok(html.includes(encodeURIComponent('https://cdn.example/next') + '#part'));
  assert.ok(html.includes(encodeURIComponent('https://cdn.example/assets/a.png')));
  assert.ok(html.includes(encodeURIComponent('https://cdn.example/assets/img.png')));
  assert.ok(!html.includes('<base'));
  assert.ok(!html.includes('srcdoc='));
  assert.ok(!html.includes('integrity='));
  assert.ok(!html.includes('http-equiv'));
  assert.ok(html.includes('target="_self"'));
  assert.equal(proxyUrl('#section', 'https://example.com', PROXY), '#section');
  assert.ok(rewriteCSS('@import "theme.css"; .a { background:url(../a.png) }', 'https://example.com/css/main.css', PROXY).includes(encodeURIComponent('https://example.com/a.png')));
});

test('isolated server strips upstream cookies, rejects writes, and enforces CSP', async () => {
  let calls = 0;
  const server = await createProxyServer({ appOrigin: APP, proxyOrigin: PROXY, load: async (url) => {
    calls++;
    return { status: 200, target: new URL(url), headers: { 'content-type': 'text/html', 'set-cookie': ['secret=x'], 'access-control-allow-origin': '*' }, body: Buffer.from('<h1>Example</h1>') };
  } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${origin}/?url=https%3A%2F%2Fexample.com`, { headers: { Cookie: 'app-secret=secret', Authorization: 'secret' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.ok(response.headers.get('content-security-policy').includes(`frame-ancestors ${APP}`));
    assert.ok(response.headers.get('content-security-policy').includes("connect-src 'self'"));
    assert.ok((await response.text()).includes('spotcheck-inspector.js'));
    assert.equal((await fetch(`${origin}/?url=https://example.com`, { method: 'POST' })).status, 405);
    assert.equal(calls, 1);
    assert.equal((await fetch(`${origin}/health`)).status, 200);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('refuses same origin app and proxy', async () => {
  await assert.rejects(createProxyServer({ appOrigin: APP, proxyOrigin: APP }), /separado/);
});


test('pinned connections preserve upstream Host and reject size, compression and timeout limits', async () => {
  const fixture = http.createServer((request, response) => {
    if (request.url === '/size') { response.writeHead(200, { 'Content-Length': '10485761' }); response.end(); }
    else if (request.url === '/gzip') { response.writeHead(200, { 'Content-Encoding': 'gzip' }); response.end('compressed'); }
    else if (request.url === '/slow') { response.writeHead(200); response.write('waiting'); }
    else { response.end(JSON.stringify({ host: request.headers.host, cookie: request.headers.cookie, authorization: request.headers.authorization })); }
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const port = fixture.address().port;
  const destination = (path) => ({ target: new URL(`http://upstream.example:${port}${path}`), address: '127.0.0.1', family: 4 });
  try {
    const result = await requestPinned(destination('/'), 1000);
    assert.deepEqual(JSON.parse(result.body), { host: `upstream.example:${port}` });
    await assert.rejects(requestPinned(destination('/size'), 1000), /grande/);
    await assert.rejects(requestPinned(destination('/gzip'), 1000), /compresión/);
    await assert.rejects(requestPinned(destination('/slow'), 40), /espera/);
  } finally { fixture.closeAllConnections(); await new Promise((resolve) => fixture.close(resolve)); }
});
