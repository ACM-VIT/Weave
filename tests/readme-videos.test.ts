import assert from 'node:assert/strict';
import test from 'node:test';
import { extractReadmeVideos } from '../src/utils/readme-videos';
const context = { fullName: 'org/repo', readmeDefaultBranch: 'main', readmeSourcePath: 'docs/README.md' };
test('finds HTML sources, markdown videos and extensionless GitHub attachments', () => {
  assert.deepEqual(extractReadmeVideos(`<video src="./demo.mp4" autoplay></video>
<video><source src="https://cdn.example.com/clip.webm"></video>
[Demo](https://github.com/user-attachments/assets/1234-abcd)
https://cdn.example.com/movie.mp4
[duplicate](./demo.mp4)`, context), [
    'https://raw.githubusercontent.com/org/repo/refs/heads/main/docs/demo.mp4',
    'https://cdn.example.com/clip.webm',
    'https://github.com/user-attachments/assets/1234-abcd',
  ]);
});
test('rejects private hosts, unsafe URLs, non-video attachments and code examples', () => {
  assert.deepEqual(extractReadmeVideos('```html\n<video src="https://cdn.example.com/fake.mp4"></video>\n```\n'
    + '`https://cdn.example.com/fake.mp4`\n'
    + '<video src="javascript:alert(1)"></video>\n'
    + '<video src="https://127.0.0.1/movie.mp4"></video>\n'
    + '[img](https://github.com/user-attachments/assets/image.png)\n'
    + '[page](https://youtube.com/watch?v=abc)', context), []);
});
test('preserves commit pinned relative paths and decodes HTML entities', () => {
  assert.deepEqual(extractReadmeVideos('<video src="../demo.mp4?x=1&amp;y=2"></video>', {
    ...context, readmeBaseUrl: `https://raw.githubusercontent.com/org/repo/${'a'.repeat(40)}/docs/`,
  }), [`https://raw.githubusercontent.com/org/repo/${'a'.repeat(40)}/demo.mp4?x=1&y=2`]);
});
