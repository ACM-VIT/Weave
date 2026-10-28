import assert from 'node:assert/strict';
import test from 'node:test';
import { createProfileAvatarService } from '../../services/profileAvatarService.js';
const owner = '00000000-0000-4000-8000-000000000001';
function fixture() {
    const calls: string[] = [];
    let failure: Error | undefined;
    const saved = { user_id: owner, avatar_url: 'https://storage.invalid/new.webp', profile_version: '2' };
    const service = createProfileAvatarService({
        sanitize: async (input: Buffer) => { calls.push('decode'); if (!input.length)
            throw new Error('invalid'); return input; },
        storage: { put: async (id: string) => { assert.equal(id, owner); calls.push('upload'); return { key: `${owner}/new.webp`, url: saved.avatar_url }; },
            managedKey: (_id: string, url: string) => url === 'https://storage.invalid/old.webp' ? `${owner}/old.webp` : null,
            removeOwned: async (_id: string, key: string) => { calls.push('remove:' + key); } },
        store: { assertActive: async () => { calls.push('active'); }, commit: async () => { calls.push('commit'); if (failure)
                throw failure; return { saved, previousUrl: 'https://storage.invalid/old.webp' }; } },
    });
    return { service, calls, saved, fail(error: Error) { failure = error; } };
}
test('only sanitized output is uploaded and old managed photo removal follows confirmed commit', async () => {
    const f = fixture();
    assert.deepEqual(await f.service.save(owner, Buffer.from('synthetic'), '1'), f.saved);
    assert.deepEqual(f.calls, ['active', 'decode', 'upload', 'commit', `remove:${owner}/old.webp`]);
});
test('invalid image has no object or database write', async () => {
    const f = fixture();
    await assert.rejects(f.service.save(owner, Buffer.alloc(0), '1'));
    assert.deepEqual(f.calls, ['active', 'decode']);
});
test('known rollback cleans the new object; ambiguous commit retains it', async () => {
    for (const known of [true, false]) {
        const f = fixture();
        f.fail(Object.assign(new Error('synthetic commit failure'), { avatarRollbackKnown: known }));
        await assert.rejects(f.service.save(owner, Buffer.from('synthetic'), '1'));
        assert.deepEqual(f.calls, ['active', 'decode', 'upload', 'commit', ...(known ? [`remove:${owner}/new.webp`] : [])]);
    }
});

test('profile-version CAS refuses a late old write after a newer photo is confirmed',async()=>{
 const {assertProfileAvatarVersion}=await import('../../services/profileAvatarService.js');
 assert.doesNotThrow(()=>assertProfileAvatarVersion('1','1'));
 assert.throws(()=>assertProfileAvatarVersion('2','1'),{statusCode:409});
 let current='1',url='old';const removed:string[]=[];let release!:(value:{key:string;url:string})=>void;
 const oldUpload=new Promise<{key:string;url:string}>(resolve=>{release=resolve;});let uploads=0;
 const service=createProfileAvatarService({sanitize:async input=>input,
 storage:{put:async()=>++uploads===1?oldUpload:{key:'new',url:'new'},managedKey:()=>null,removeOwned:async(_owner,key)=>{removed.push(key);}},
 store:{assertActive:async(_owner,version)=>assertProfileAvatarVersion(current,version),commit:async(_owner,next,version)=>{
  try{assertProfileAvatarVersion(current,version);}catch(error){throw Object.assign(error as Error,{avatarRollbackKnown:true});}
  current=String(Number(current)+1);url=next;return{saved:{user_id:owner,avatar_url:url,profile_version:current},previousUrl:null};
 }}});
 const old=service.save(owner,Buffer.from('old'),'1');await new Promise(resolve=>setTimeout(resolve,0));
 await service.save(owner,Buffer.from('new'),'1');release({key:'old-pending',url:'old-pending'});
 await assert.rejects(old,{statusCode:409});assert.equal(url,'new');assert.equal(current,'2');assert.deepEqual(removed,['old-pending']);
});
