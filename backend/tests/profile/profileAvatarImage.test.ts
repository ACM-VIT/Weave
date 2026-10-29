import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { sanitizeProfileAvatar } from '../../services/profileAvatarImage.js';
const image = () => sharp({ create: { width: 20, height: 30, channels: 4, background: '#ff00ff' } });
test('JPEG PNG and still WebP become bounded WebP without metadata', async () => {
    for (const input of [await image().jpeg().withExif({ IFD0: { Artist: 'Synthetic' } }).toBuffer(), await image().png().toBuffer(), await image().webp().toBuffer()]) {
        const result = await sanitizeProfileAvatar(input);
        const info = await sharp(result).metadata();
        assert.equal(info.format, 'webp');
        assert.ok(info.width! <= 512 && info.height! <= 512);
        assert.equal(info.width, info.height, 'small non-square sources must still crop to a square');
        assert.equal(info.exif, undefined);
        assert.equal(info.icc, undefined);
        assert.equal(info.xmp, undefined);
    }
});
test('unsupported disguised or malformed contents never become accepted images', async () => {
    for (const input of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from('GIF89a'), Buffer.from('%PDF-1.7'), Buffer.from('0000ftypheic'), Buffer.from('0000ftypheif'), await image().avif().toBuffer(), await image().tiff().toBuffer(), Buffer.from([0xff, 0xd8, 0xff, 0, 1, 2])]) {
        await assert.rejects(sanitizeProfileAvatar(input));
    }
    await assert.rejects(sanitizeProfileAvatar(Buffer.alloc(0)), { statusCode: 400 });
    await assert.rejects(sanitizeProfileAvatar(Buffer.alloc(5242881)), { statusCode: 413 });
});
test('pixel and edge limits apply before processing a compressed image', async () => {
    const input = await sharp({ create: { width: 8193, height: 1, channels: 3, background: 'red' } }).png().toBuffer();
    await assert.rejects(sanitizeProfileAvatar(input), { statusCode: 413 });
    const many = await sharp({ create: { width: 4097, height: 4097, channels: 3, background: 'red' } }).png().toBuffer();
    await assert.rejects(sanitizeProfileAvatar(many), { statusCode: 413 });
});
test('APNG chunks and animated WebP containers are rejected rather than flattened', async () => {
    const png = await image().png().toBuffer();
    // Insert a bounded acTL chunk before IDAT; animation is rejected before decode.
    const actl = Buffer.alloc(20);
    actl.writeUInt32BE(8);
    actl.write('acTL', 4);
    actl.writeUInt32BE(1, 8);
    await assert.rejects(sanitizeProfileAvatar(Buffer.concat([png.subarray(0, 33), actl, png.subarray(33)])), { statusCode: 415 });
    const webp = Buffer.from([255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255]);
    const animated = await sharp(webp, { raw: { width: 2, height: 4, channels: 3, pageHeight: 2 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
    // A single-frame animation flag must be refused too.
    const vp8x = Buffer.alloc(30);
    vp8x.write('RIFF');
    vp8x.writeUInt32LE(22, 4);
    vp8x.write('WEBPVP8X', 8);
    vp8x.writeUInt32LE(10, 16);
    vp8x[20] = 2;
    await assert.rejects(sanitizeProfileAvatar(vp8x), { statusCode: 415 });
    assert.equal((await sharp(animated).metadata()).pages, 2);
    await assert.rejects(sanitizeProfileAvatar(animated), { statusCode: 415 });
});

test('small and narrow source images crop to the smaller dimension without upscaling',async()=>{
 for(const [width,height,side] of [[20,30,20],[100,600,100],[500,700,500],[800,600,512]]){
  const input=await sharp({create:{width,height,channels:3,background:'blue'}}).png().toBuffer();
  const result=await sanitizeProfileAvatar(input);
  const info=await sharp(result).metadata();
  assert.equal(info.width,side);assert.equal(info.height,side);
 }
});
