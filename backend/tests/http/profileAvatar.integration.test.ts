import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';
process.env.JWT_SECRET = 'synthetic-avatar-test-secret';
const { requireAuth } = await import('../../middlewares/authMiddleware.js');
const { createProfileAvatarRouter } = await import('../../routes/profileAvatarRoutes.js');
const owner = '00000000-0000-4000-8000-000000000001';
async function fixture(save: (owner: string, bytes: Buffer, expectedVersion: string) => Promise<any>, admit: (owner: string) => Promise<void> = async () => { }, readBudgetMs?: number) {
    const app = express();
    app.use('/avatar', requireAuth, createProfileAvatarRouter({ save, admit, ...(readBudgetMs ? { readBudgetMs } : {}) } as any));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as {
        port: number;
    };
    return { url: `http://127.0.0.1:${address.port}/avatar`, headers: { Authorization: `Bearer ${jwt.sign({ userId: owner, email: 'fixture.invalid' }, process.env.JWT_SECRET!)}`, 'Content-Type': 'application/octet-stream', 'If-Match': '"1"' }, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
test('real authenticated route rejects unauthorized, wrong media, excessive and empty bytes before save', async () => {
    let writes = 0;
    const f = await fixture(async () => { writes++; return {}; });
    try {
        assert.equal((await fetch(f.url, { method: 'PUT', body: 'x' })).status, 401);
        assert.equal((await fetch(f.url, { method: 'PUT', headers: { ...f.headers, 'Content-Type': 'image/svg+xml' }, body: '<svg/>' })).status, 415);
        assert.equal((await fetch(f.url, { method: 'PUT', headers: f.headers, body: Buffer.alloc(5242881) })).status, 413);
        assert.equal((await fetch(f.url, { method: 'PUT', headers: f.headers, body: Buffer.alloc(0) })).status, 400);
        assert.equal(writes, 0);
    }
    finally {
        await f.close();
    }
});
test('only JWT owner and raw bytes reach save; errors retain a safe envelope', async () => {
    const f = await fixture(async (id, bytes) => { assert.equal(id, owner); assert.equal(bytes.toString(), 'synthetic'); return { user_id: id, avatar_url: 'https://fixture.invalid/a.webp', profile_version: '2' }; });
    try {
        assert.equal((await fetch(f.url + '?owner=foreign', { method: 'PUT', headers: f.headers, body: 'synthetic' })).status, 400);
        const response = await fetch(f.url, { method: 'PUT', headers: f.headers, body: 'synthetic' });
        assert.equal(response.status, 200);
        assert.equal((await response.json() as any).data.user_id, owner);
    }
    finally {
        await f.close();
    }
});
test('busy slots are held until pending save actually settles and released after errors', async () => {
    let finish!: () => void;
    let pending = true;
    const wait = new Promise<void>(resolve => { finish = resolve; });
    const f = await fixture(async () => { if (pending)
        await wait; throw Object.assign(new Error('synthetic'), { statusCode: 503 }); });
    try {
        const one = fetch(f.url, { method: 'PUT', headers: f.headers, body: 'a' }), two = fetch(f.url, { method: 'PUT', headers: f.headers, body: 'b' });
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal((await fetch(f.url, { method: 'PUT', headers: f.headers, body: 'c' })).status, 503);
        finish();
        await Promise.all([one, two]);
        pending = false;
        assert.equal((await fetch(f.url, { method: 'PUT', headers: f.headers, body: 'd' })).status, 503);
    }
    finally {
        finish();
        await f.close();
    }
});
test('authenticated route plus real sanitizer writes only decoded metadata-free WebP', async () => {
    const [{ default: sharp }, { sanitizeProfileAvatar }, { createProfileAvatarService }] = await Promise.all([
        import('sharp'), import('../../services/profileAvatarImage.js'), import('../../services/profileAvatarService.js')
    ]);
    let writes = 0;
    const service = createProfileAvatarService({ sanitize: sanitizeProfileAvatar,
        storage: { put: async (id, output) => { writes++; assert.equal(id, owner); const info = await sharp(output).metadata(); assert.equal(info.format, 'webp'); assert.equal(info.exif, undefined); return { key: `${owner}/fixture.webp`, url: 'https://fixture.invalid/public.webp' }; }, managedKey: () => null, removeOwned: async () => { } },
        store: { assertActive: async () => { }, commit: async (id, url) => ({ saved: { user_id: id, avatar_url: url, profile_version: '2' }, previousUrl: null }) } });
    const f = await fixture(service.save);
    try {
        const input = await sharp({ create: { width: 20, height: 30, channels: 3, background: 'blue' } }).jpeg().withExif({ IFD0: { Artist: 'Synthetic' } }).toBuffer();
        assert.equal((await fetch(f.url, { method: 'PUT', headers: f.headers, body: input })).status, 200);
        assert.equal(writes, 1);
        assert.equal((await fetch(f.url, { method: 'PUT', headers: f.headers, body: '<svg/>' })).status, 415);
        assert.equal(writes, 1);
        assert.equal((await fetch(f.url, { method: 'PUT', headers: { ...f.headers, 'Content-Encoding': 'gzip' }, body: 'fakecompressed' })).status, 415);
        assert.equal(writes, 1);
    }
    finally {
        await f.close();
    }
});

test('pending admission consumes a bounded process slot instead of accumulating Redis waiters',async()=>{
 let release!:()=>void,calls=0;
 const held=new Promise<void>(resolve=>{release=resolve;});
 const f=await fixture(async()=>({user_id:owner,avatar_url:'https://fixture.invalid/a.webp',profile_version:'2'}),async()=>{calls++;await held;});
 let one:Promise<Response>|undefined,two:Promise<Response>|undefined;
 try{
  one=fetch(f.url,{method:'PUT',headers:f.headers,body:'one'});two=fetch(f.url,{method:'PUT',headers:f.headers,body:'two'});
  await new Promise(resolve=>setTimeout(resolve,30));
  const third=await fetch(f.url,{method:'PUT',headers:f.headers,body:'three',signal:AbortSignal.timeout(300)}).catch(()=>null);
  assert.equal(third?.status,503);assert.equal(calls,2);
 }finally{release();await Promise.all([one,two]);await f.close();}
});

test('an absolute body deadline closes an incomplete request and releases its upload slot',async()=>{
 let writes=0;const f=await fixture(async()=>{writes++;return{user_id:owner,avatar_url:'https://fixture.invalid/a.webp',profile_version:'2'};},async()=>{},25);
 const request=httpRequest(f.url,{method:'PUT',headers:{...f.headers,'Transfer-Encoding':'chunked'}});
 let deadline:ReturnType<typeof setTimeout>|undefined;
 const closed=new Promise<string>(resolve=>{request.once('error',()=>resolve('closed'));request.once('response',()=>resolve('responded'));});
 try{
  request.write('a partial image body');
  const result=await Promise.race([closed,new Promise<string>(resolve=>{deadline=setTimeout(()=>resolve('unbounded'),400);})]);
  assert.equal(result,'closed');assert.equal(writes,0);
  const response=await fetch(f.url,{method:'PUT',headers:f.headers,body:'complete'});assert.equal(response.status,200);assert.equal(writes,1);
 }finally{clearTimeout(deadline);request.destroy();await f.close();}
});

test('photo writes require a quoted current profile-version precondition',async()=>{
 let writes=0;const f=await fixture(async()=>{writes++;return{user_id:owner,avatar_url:'https://fixture.invalid/a.webp',profile_version:'2'};});
 try{
  const headers={...f.headers} as Record<string,string>;delete headers['If-Match'];
  assert.equal((await fetch(f.url,{method:'PUT',headers,body:'bytes'})).status,428);
  for(const value of ['*','W/"1"','"1", "2"','1','"0"'])assert.equal((await fetch(f.url,{method:'PUT',headers:{...headers,'If-Match':value},body:'bytes'})).status,400);
  assert.equal(writes,0);
 }finally{await f.close();}
});
