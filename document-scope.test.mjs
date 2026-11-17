import assert from 'node:assert/strict';
import test from 'node:test';
import { createProxyServer, retrieve } from './server.mjs';
import { rewriteHTML, documentUrl } from './rewrite.mjs';
const APP='http://localhost:3001', PROXY='http://localhost:3002', SITE='https://site.example';

test('document rewrites keep the permanent site while CDN assets remain proxyable', () => {
  const internal = new URL(documentUrl('/products#details', SITE, PROXY, SITE));
  assert.equal(internal.searchParams.get('url'), SITE+'/products');
  assert.equal(internal.searchParams.get('siteOrigin'), SITE);
  assert.equal(internal.searchParams.get('document'), '1');
  assert.equal(internal.hash, '#details');
  assert.equal(documentUrl('https://external.example/', SITE, PROXY, SITE), null);
  const html = rewriteHTML('<a href="/products">Products</a><a href="https://external.example/">External</a><img src="https://cdn.example/image.png"><link rel="stylesheet" href="https://cdn.example/style.css">', SITE+'/', PROXY, APP, SITE);
  assert.ok(html.includes('data-spotcheck-external="true"'));
  assert.ok(html.includes(encodeURIComponent('https://cdn.example/image.png')));
  assert.ok(html.includes(encodeURIComponent('https://cdn.example/style.css')));
  assert.ok(html.includes('siteOrigin='));
});

test('document redirects outside site are rejected before connecting; resource redirects remain allowed', async () => {
  let requests=0;
  const resolve=async value=>({target:new URL(value),address:'8.8.8.8',family:4});
  const request=async()=>{requests++;return {status:302,headers:{location:'https://cdn.example/asset'},body:Buffer.alloc(0)};};
  await assert.rejects(retrieve(SITE+'/',{resolve,request,documentOrigin:SITE}), /sitio/);
  assert.equal(requests,1);
  requests=0;
  const result=await retrieve(SITE+'/asset',{resolve,request:async()=>++requests===1?{status:302,headers:{location:'https://cdn.example/asset'},body:Buffer.alloc(0)}:{status:200,headers:{'content-type':'image/png'},body:Buffer.from('image')}});
  assert.equal(result.target.origin,'https://cdn.example');
  assert.equal(requests,2);
});

test('server enforces document scope but does not constrain independent CDN resource requests', async () => {
  const destinations=[];
  const server=await createProxyServer({appOrigin:APP,proxyOrigin:PROXY,load:async (url,options)=>{
    destinations.push({url,options});
    return {status:200,headers:{'content-type':'text/html'},target:new URL(url),body:Buffer.from('<h1>Page</h1>')};
  }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const host=`http://127.0.0.1:${server.address().port}`;
  try {
    const params=new URLSearchParams({url:'https://external.example/',document:'1',siteOrigin:SITE});
    assert.equal((await fetch(`${host}/?${params}`)).status,502); assert.equal(destinations.length,0);
    params.set('url',SITE+'/products');
    assert.equal((await fetch(`${host}/?${params}`)).status,200);
    assert.equal(destinations[0].options.documentOrigin,SITE);
    assert.equal((await fetch(`${host}/?url=${encodeURIComponent('https://cdn.example/style.css')}`)).status,200);
    assert.equal(destinations[1].options.documentOrigin,null);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
