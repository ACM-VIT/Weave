import assert from 'node:assert/strict';
import test from 'node:test';
import { createProfilePhotoFlow } from '../src/services/profilePhotoFlow';
import { mergeSavedAvatar } from '../src/utils/profile-state';
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
    let current = true;
    const read = deferred<ArrayBuffer>(), upload = deferred<any>();
    const calls: string[] = [], states: any[] = [];
    const flow = createProfilePhotoFlow({ isCurrent: () => current, pick: async () => ({ uri: 'file://synthetic' }), read: () => read.promise,
        upload: async () => { calls.push('upload'); return upload.promise; }, apply: () => { calls.push('apply'); }, state: state => states.push(state) });
    return { flow, read, upload, calls, states, retire() { current = false; } };
}
test('selection and explicit saving are separate and duplicate saves share one upload', async () => {
    const f = fixture();
    const picking = f.flow.select();
    f.read.resolve(new Uint8Array([255, 216, 255, 1]).buffer);
    await picking;
    assert.deepEqual(f.calls, []);
    const save = f.flow.save();
    const second = f.flow.save();
    f.upload.resolve({ avatar_url: 'https://fixture.invalid/a.webp', profile_version: '2' });
    await Promise.all([save, second]);
    assert.deepEqual(f.calls, ['upload', 'apply']);
});
test('logout/account change during file read cannot upload or apply a result', async () => {
    const f = fixture();
    const picking = f.flow.select();
    f.retire();
    f.read.resolve(new Uint8Array([255, 216, 255, 1]).buffer);
    await picking;
    await f.flow.save();
    assert.deepEqual(f.calls, []);
});
test('cancellation during upload aborts transport and ignores its late success', async () => {
    const f = fixture();
    f.read.resolve(new Uint8Array([255, 216, 255, 1]).buffer);
    await f.flow.select();
    const save = f.flow.save();
    f.flow.cancel();
    f.upload.resolve({ avatar_url: 'https://fixture.invalid/a.webp', profile_version: '2' });
    await save;
    assert.deepEqual(f.calls, ['upload']);
});
test('failed or uncertain upload is not called saved and newer selection discards old result', async () => {
    const f = fixture();
    f.read.resolve(new Uint8Array([255, 216, 255, 1]).buffer);
    await f.flow.select();
    const save = f.flow.save();
    f.retire();
    f.upload.resolve({ avatar_url: 'https://fixture.invalid/a.webp', profile_version: '2' });
    await save;
    assert.deepEqual(f.calls, ['upload']);
});
test('avatar application checks owner/generation and preserves newer unrelated profile fields', () => {
    const current = { user_id: 'owner', username: 'new-name', bio: 'new-bio', avatar_url: 'old', profile_version: '3' };
    assert.equal(mergeSavedAvatar(current, 'other', true, { avatar_url: 'next', profile_version: '4' }), current);
    assert.equal(mergeSavedAvatar(current, 'owner', false, { avatar_url: 'next', profile_version: '4' }), current);
    assert.deepEqual(mergeSavedAvatar(current, 'owner', true, { avatar_url: 'next', profile_version: '4' }), { ...current, avatar_url: 'next', profile_version: '4' });
    assert.equal(mergeSavedAvatar(current, 'owner', true, { avatar_url: 'stale', profile_version: '2' }), current);
});
test('late profile read cannot replace a newer saved avatar with its older snapshot', async () => {
    const { preserveNewerAvatar } = await import('../src/utils/profile-state');
    const current = { user_id: 'owner', username: 'current', avatar_url: 'new-photo', profile_version: '5' };
    const read = { user_id: 'owner', username: 'server', avatar_url: 'old-photo', profile_version: '4' };
    assert.deepEqual(preserveNewerAvatar(current, read), { ...read, avatar_url: 'new-photo', profile_version: '5' });
    assert.deepEqual(preserveNewerAvatar(current, { ...read, user_id: 'other' }), { ...read, user_id: 'other' });
});
test('uncertain transport failure requires reconciliation, not a duplicate upload retry', async () => {
    const states: any[] = [];
    let uploads = 0, applied = 0;
    const flow = createProfilePhotoFlow({ isCurrent: () => true, pick: async () => ({ uri: 'file://fixture' }), read: async () => new Uint8Array([255, 216, 255, 1]).buffer,
        upload: async () => { uploads++; throw new TypeError('synthetic network failure'); }, apply: () => { applied++; }, state: state => states.push(state) });
    await flow.select();
    await flow.save();
    await flow.select();
    await flow.save();
    assert.equal(uploads, 1);
    assert.equal(applied, 0);
    assert.equal(states.at(-1).status, 'error');
    assert.equal(states.at(-1).uncertain, true);
});

test('upload responses must belong to the original owner and contain a usable saved photo/version',async()=>{
 const {validateSavedPhoto}=await import('../src/services/profilePhotoFlow');
 const saved={user_id:'owner',avatar_url:'https://fixture.invalid/a.webp',profile_version:'2'};
 assert.deepEqual(validateSavedPhoto(saved,'owner'),{avatar_url:saved.avatar_url,profile_version:'2'});
 for(const value of [null,{}, {...saved,user_id:'other'},{...saved,avatar_url:'javascript:bad'}, {...saved,avatar_url:'https://u:p@fixture.invalid/a.webp'}, {...saved,profile_version:'wrong'}])assert.throws(()=>validateSavedPhoto(value,'owner'));
});

test('same-owner generation uncertainty survives disposal and remount until a real checked read',async()=>{
 const {ProfilePhotoRecovery}=await import('../src/services/profilePhotoFlow');const recovery=new ProfilePhotoRecovery();let uploads=0,checked=0;
 const ports={isCurrent:()=>true,recovery,scope:'owner:1',pick:async()=>({uri:'file://fixture'}),read:async()=>new Uint8Array([255,216,255,1]).buffer,upload:async()=>{uploads++;throw new TypeError('lost response');},apply(){},state(){},reconcile:async()=>{checked++;}};
 const first=createProfilePhotoFlow(ports);await first.select();await first.save();first.dispose();
 const second=createProfilePhotoFlow(ports);await second.select();await second.save();assert.equal(uploads,1);
 assert.equal(await second.reconcile(),true);assert.equal(checked,1);await second.select();await second.save();assert.equal(uploads,2);
});

test('a rejected old file read releases only its own preview, never a newer selection',async()=>{
 let rejectOld!:(error:Error)=>void;const oldRead=new Promise<ArrayBuffer>((_resolve,reject)=>{rejectOld=reject;});
 let pickCount=0;const released:string[]=[];
 const flow=createProfilePhotoFlow({isCurrent:()=>true,pick:async()=>({uri:++pickCount===1?'blob:old':'blob:new'}),
 read:photo=>photo.uri==='blob:old'?oldRead:Promise.resolve(new Uint8Array([255,216,255,1]).buffer),
 release:photo=>released.push(photo.uri),upload:async()=>({avatar_url:'https://fixture.invalid/a.webp',profile_version:'2'}),apply(){},state(){}});
 const first=flow.select();await Promise.resolve();flow.cancel();await flow.select();rejectOld(new Error('old read canceled'));await first;
 assert.equal(released.includes('blob:new'),false);flow.dispose();assert.equal(released.includes('blob:new'),true);
});

test('photo If-Match is derived from a canonical authoritative profile version',async()=>{
 const {photoVersionHeader}=await import('../src/services/profilePhotoFlow');
 assert.equal(photoVersionHeader('2'),'"2"');assert.equal(photoVersionHeader(3),'"3"');
 for(const value of [null,undefined,0,'01','*','W/"2"',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>photoVersionHeader(value),{status:428});
});

test('a still-pending old upload cannot be unlocked by an early read after editor remount',async()=>{
 const {ProfilePhotoRecovery}=await import('../src/services/profilePhotoFlow');const recovery=new ProfilePhotoRecovery();let checks=0,uploads=0;
 const held=deferred<any>();const ports={isCurrent:()=>true,recovery,scope:'owner:pending',pick:async()=>({uri:'file://fixture'}),read:async()=>new Uint8Array([255,216,255,1]).buffer,
 upload:async()=>{uploads++;return held.promise;},reconcile:async()=>{checks++;},apply(){},state(){}};
 const old=createProfilePhotoFlow(ports);await old.select();const saving=old.save();old.dispose();const next=createProfilePhotoFlow(ports);
 assert.equal(await next.reconcile(),false);await next.select();await next.save();assert.equal(checks,0);assert.equal(uploads,1);
 held.resolve({avatar_url:'https://fixture.invalid/a.webp',profile_version:'2'});await saving;assert.equal(await next.reconcile(),true);assert.equal(checks,1);
});
