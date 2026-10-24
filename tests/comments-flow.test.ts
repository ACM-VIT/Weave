import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { act } from "react";
import { repository, feed } from "./support/feed-harness";

test('comment drafts remain repository-local across close, reopen and repository switches', async () => {
  const app = feed(['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']);
  await app.mount();
  try {
    await app.open(0, 'onCommentPress');
    await app.type('Draft for one');
    await app.requestClose(); await app.finishClose();
    await app.open(1, 'onCommentPress');
    assert.equal(app.input.props.value, '');
    await app.type('Draft for two');
    await app.requestClose(); await app.finishClose();
    await app.open(0, 'onCommentPress');
    assert.equal(app.input.props.value, 'Draft for one');
    await app.requestClose(); await app.finishClose();
    await app.open(1, 'onCommentPress');
    assert.equal(app.input.props.value, 'Draft for two');
  } finally { await app.unmount(); }
});

test('a failed comment after dismissal restores its draft before the next mount', async () => {
  const app = feed(['00000000-0000-4000-8000-000000000001']);
  let reject!: (error: Error) => void;
  app.setPost(() => new Promise((_yes, no) => { reject = no; }));
  await app.mount();
  try {
    await app.open(0, 'onCommentPress'); await app.type('Keep this draft'); await app.submit();
    assert.equal(app.input.props.value, '');
    await app.requestClose(); await app.finishClose();
    await act(async () => { reject(new Error('offline')); });
    await app.open(0, 'onCommentPress');
    assert.equal(app.input.props.value, 'Keep this draft');
  } finally { await app.unmount(); }
});

test('reopening comments during an in-flight post cannot submit that draft twice', async () => {
  const app = feed(['00000000-0000-4000-8000-000000000001']);
  let finish!: (comment: any) => void;
  let posts = 0;
  app.setPost(() => { posts++; return new Promise(resolve => { finish = resolve; }); });
  await app.mount();
  try {
    await app.open(0, 'onCommentPress'); await app.type('Post once'); await app.submit();
    await app.requestClose(); await app.finishClose();
    await app.open(0, 'onCommentPress');
    assert.equal(app.input.props.editable, false);
    await app.type('Post once'); await app.submit();
    assert.equal(posts, 1);
    await act(async () => { finish({ comment_id: 'saved', user_id: 'viewer', repo_id: '00000000-0000-4000-8000-000000000001', comment: 'Post once' }); });
    assert.equal(app.input.props.editable, true);
  } finally { await app.unmount(); }
});

test('comment footer restarts a rejected cursor while retaining loaded rows until fresh pages finish', async()=>{
  const app=feed(['00000000-0000-4000-8000-000000000001']);
  const cursors:(string|null)[]=[];
  let expired=false;
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  const comment=(id:string)=>({comment_id:id,user_id:'viewer',repo_id:'00000000-0000-4000-8000-000000000001',parent_comment_id:null,comment:id,created_at:null,author:{user_id:'viewer',username:'viewer'}});
  app.setCommentPages(async cursor=>{
    cursors.push(cursor);
    if(cursor==='old-tail') throw Object.assign(new Error('Invalid cursor'),{status:400});
    if(cursor===null) return {items:[comment(expired?'fresh-one':'old-one')],has_more:true,next_cursor:expired?'new-next':'old-next'};
    if(cursor==='new-next'){await held;return {items:[comment('fresh-two')],has_more:false,next_cursor:null};}
    return {items:[comment('old-two')],has_more:true,next_cursor:'old-tail'};
  });
  await app.mount();
  try {
    await app.open(0,'onCommentPress');
    await app.pressCommentFooter();
    assert.deepEqual(app.loadedCommentIds,['old-one','old-two']);
    expired=true;
    await app.pressCommentFooter();
    assert.deepEqual(app.loadedCommentIds,['old-one','old-two']);
    await app.pressCommentFooter();
    assert.deepEqual(cursors,[null,'old-next','old-tail',null,'new-next']);
    assert.deepEqual(app.loadedCommentIds,['old-one','old-two'],'keep the previous pages during restart');
    await act(async()=>{release();});
    // Query notifications and React commits need not share the first timer turn.
    for(let attempt=0;attempt<100&&app.loadedCommentIds.join(',')!=='fresh-one,fresh-two';attempt++) {
      await act(async()=>{await new Promise(resolve=>setTimeout(resolve,1));});
    }
    assert.deepEqual(app.loadedCommentIds,['fresh-one','fresh-two']);
  } finally {release();await app.unmount();}
});
