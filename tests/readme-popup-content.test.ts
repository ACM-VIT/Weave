import assert from 'node:assert/strict';
import test from 'node:test';
import { readmePopupBlocks } from '../src/utils/readme-popup-content';
test('keeps the entire summary and places videos between its sections', () => {
  const html='<p>Complete overview.</p>\n<h2>Capabilities</h2><ul><li>Every capability.</li></ul>\n<h2>Use cases</h2><p>Every use case.</p><h2>Things to know</h2><p>All caveats.</p>';
  const blocks=readmePopupBlocks(html,['https://cdn.example.com/demo.mp4'],true);
  assert.equal(blocks.filter(b=>b.kind==='html').map(b=>b.content).join(''),html);
  assert.deepEqual(blocks.map(b=>b.kind),['html','video','html','html','html']);
});
test('short summaries keep their text and append bounded media without duplicating it',()=>{
  assert.deepEqual(readmePopupBlocks('<p>Overview.</p>',['a','b','c','d'],true).map(b=>b.kind),['html','video','video','video']);
  assert.deepEqual(readmePopupBlocks('<h2>Original</h2><p>Source.</p>',['a'],false),[
    {kind:'html',content:'<h2>Original</h2><p>Source.</p>'},{kind:'video',url:'a'},
  ]);
});
