import sharp from 'sharp';
export const AVATAR_MAX_BYTES = 5242880;
const MAX_PIXELS = 16777216;
export function avatarError(statusCode: number, message: string): Error & {
    statusCode: number;
} {
    return Object.assign(new Error(message), { statusCode });
}
function validateContainer(input: Buffer): void {
    if (input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        let offset = 8;
        while (offset + 12 <= input.length) {
            const length = input.readUInt32BE(offset), end = offset + 12 + length;
            if (end > input.length)
                throw avatarError(400, 'The image is incomplete.');
            const type = input.toString('ascii', offset + 4, offset + 8);
            if (type === 'acTL' || type === 'fcTL' || type === 'fdAT')
                throw avatarError(415, 'Animated images are not supported.');
            if (type === 'IEND') {
                if (length !== 0 || end !== input.length)
                    throw avatarError(400, 'Invalid PNG image.');
                return;
            }
            offset = end;
        }
        throw avatarError(400, 'The image is incomplete.');
    }
    if (input.toString('ascii', 0, 4) === 'RIFF' && input.toString('ascii', 8, 12) === 'WEBP') {
        if (input.length < 20 || input.readUInt32LE(4) + 8 !== input.length)
            throw avatarError(400, 'Invalid WebP image.');
        let offset = 12;
        while (offset + 8 <= input.length) {
            const type = input.toString('ascii', offset, offset + 4), length = input.readUInt32LE(offset + 4);
            const end = offset + 8 + length + (length % 2);
            if (end > input.length)
                throw avatarError(400, 'The image is incomplete.');
            if (type === 'ANIM' || type === 'ANMF' || (type === 'VP8X' && length >= 1 && (input[offset + 8] & 2))) {
                throw avatarError(415, 'Animated images are not supported.');
            }
            offset = end;
        }
        if (offset !== input.length)
            throw avatarError(400, 'Invalid WebP image.');
        return;
    }
    if (input.length >= 3 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff)
        return;
    throw avatarError(415, 'Choose a JPEG, PNG, or still WebP image.');
}
export async function sanitizeProfileAvatar(input: Buffer): Promise<Buffer> {
    if (!Buffer.isBuffer(input) || !input.length)
        throw avatarError(400, 'Choose an image first.');
    if (input.length > AVATAR_MAX_BYTES)
        throw avatarError(413, 'The photo must be 5 MiB or smaller.');
    validateContainer(input);
    try {
        const image = sharp(input, { failOn: 'warning', limitInputPixels: MAX_PIXELS });
        const metadata = await image.metadata();
        if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1 || metadata.delay?.length) {
            throw avatarError(415, 'Choose a JPEG, PNG, or still WebP image.');
        }
        const { width, height } = metadata;
        if (!width || !height || width > 8192 || height > 8192 || width * height > MAX_PIXELS) {
            throw avatarError(413, 'The photo must be at most 16 megapixels and 8192 pixels per side.');
        }
        // Clamp the target square before resizing: withoutEnlargement alone
        // can return a non-square image when either source edge is below 512.
        const side = Math.min(512, width, height);
        const output = await image.rotate().resize(side, side, { fit: 'cover', withoutEnlargement: true })
            .webp({ quality: 85 }).timeout({ seconds: 5 }).toBuffer();
        if (output.length > 1048576)
            throw avatarError(413, 'The processed photo is too large.');
        return output;
    }
    catch (error) {
        if (error instanceof Error && 'statusCode' in error)
            throw error;
        if (error instanceof Error && /pixel limit/i.test(error.message))
            throw avatarError(413, 'The photo exceeds the 16 megapixel limit.');
        throw avatarError(400, 'The image could not be read. Choose a valid, complete image.');
    }
}
