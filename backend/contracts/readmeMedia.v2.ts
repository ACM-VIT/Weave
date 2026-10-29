export const README_MEDIA_SCHEMA_VERSION = 2 as const;
export const README_MEDIA_ITEM_LIMIT = 3;
export const README_MEDIA_URL_LIMIT = 2_048;
export const README_MEDIA_ALT_LIMIT = 10_000;
export const README_MEDIA_HASH_LIMIT = 256;
export const README_MEDIA_MANIFEST_BYTE_LIMIT = 1_000_000;

export interface ReadmeMediaImage {
  alt: string;
  url: string;
}

export interface ReadmeMediaManifest {
  schema_version: typeof README_MEDIA_SCHEMA_VERSION;
  content_version: number;
  content_hash: string;
  readme_available: boolean;
  representation: 'deferred' | 'inline_only';
  poster: ReadmeMediaImage | null;
  images: ReadmeMediaImage[];
  videos: string[];
}

export interface ReadmeMediaHtmlImageCandidate {
  kind: 'image';
  alt: string;
  source: string;
}

export type ReadmeMediaHtmlCandidate = ReadmeMediaHtmlImageCandidate | { kind: 'video'; source: string };

function isHtmlWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_]/.test(value);
}

function startsHtmlTag(source: string, start: number, name: string, closing = false): boolean {
  const nameStart = start + (closing ? 2 : 1);
  if (source[start] !== '<' || (closing && source[start + 1] !== '/')) return false;
  for (let offset = 0; offset < name.length; offset++) {
    if (source[nameStart + offset]?.toLowerCase() !== name[offset]) return false;
  }
  return !isHtmlWordCharacter(source[nameStart + name.length]);
}

function htmlTagEnd(source: string, start: number): number {
  let quote = '';
  for (let index = start + 1; index < source.length; index++) {
    const character = source[index]!;
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '>') return index + 1;
  }
  return -1;
}

function closingHtmlTagEnd(source: string, start: number, name: string): number {
  for (let index = start; index < source.length; index++) {
    if (!startsHtmlTag(source, index, name, true)) continue;
    return htmlTagEnd(source, index);
  }
  return -1;
}

function htmlMediaAttributes(source: string, start: number, name: string, end: number): { src?: string; alt?: string } {
  const attributes: { src?: string; alt?: string } = {};
  let index = start + name.length + 1;
  while (index < end - 1) {
    while (index < end - 1 && (source[index] === '/' || /\s/.test(source[index]!))) index++;
    const attributeStart = index;
    while (index < end - 1 && source[index] !== '=' && source[index] !== '>' && !/\s/.test(source[index]!)) index++;
    if (index === attributeStart) { index++; continue; }
    const attribute = source.slice(attributeStart, index).toLowerCase();
    while (index < end - 1 && /\s/.test(source[index]!)) index++;
    let value: string | undefined;
    if (source[index] === '=') {
      index++;
      while (index < end - 1 && /\s/.test(source[index]!)) index++;
      const quote = source[index] === '"' || source[index] === "'" ? source[index]! : '';
      if (quote) {
        const valueStart = ++index;
        while (index < end - 1 && source[index] !== quote) index++;
        value = source.slice(valueStart, index);
        if (source[index] === quote) index++;
      } else {
        const valueStart = index;
        while (index < end - 1 && source[index] !== '>' && !/\s/.test(source[index]!)) index++;
        value = source.slice(valueStart, index);
      }
    }
    if (attribute === 'src' && attributes.src === undefined && value !== undefined) attributes.src = value;
    if (attribute === 'alt' && attributes.alt === undefined && value !== undefined) attributes.alt = value;
  }
  return attributes;
}

/** Extract HTML media tags in one forward scan; malformed unterminated tags consume the remainder once. */
export function* scanReadmeHtmlMediaCandidates(source: string): Generator<ReadmeMediaHtmlCandidate> {
  let index = 0;
  while (index < source.length) {
    if (source.startsWith('<!--', index)) {
      const commentEnd = source.indexOf('-->', index + 4);
      if (commentEnd < 0) break;
      index = commentEnd + 3;
      continue;
    }
    if (startsHtmlTag(source, index, 'script') || startsHtmlTag(source, index, 'style')) {
      const name = startsHtmlTag(source, index, 'script') ? 'script' : 'style';
      const startTagEnd = htmlTagEnd(source, index);
      if (startTagEnd < 0) break;
      const closeTagEnd = closingHtmlTagEnd(source, startTagEnd, name);
      if (closeTagEnd < 0) break;
      index = closeTagEnd;
      continue;
    }
    const isImage = startsHtmlTag(source, index, 'img');
    const isVideo = startsHtmlTag(source, index, 'video') || startsHtmlTag(source, index, 'source');
    if (!isImage && !isVideo) { index++; continue; }
    const name = isImage ? 'img' : startsHtmlTag(source, index, 'video') ? 'video' : 'source';
    const tagEnd = htmlTagEnd(source, index);
    if (tagEnd < 0) break;
    const attributes = htmlMediaAttributes(source.slice(index, tagEnd), 0, name, tagEnd - index);
    if (attributes.src !== undefined) {
      if (isImage) yield { kind: 'image', alt: attributes.alt ?? '', source: attributes.src };
      else yield { kind: 'video', source: attributes.src };
    }
    index = tagEnd;
  }
}

function isPublicHttpsReadmeMediaUrl(url: URL): boolean {
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/g, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || hostname.endsWith('.internal') || !hostname.includes('.') || hostname.includes(':')) return false;
  const ipv4 = hostname.split('.').map(Number);
  if (ipv4.length === 4 && ipv4.every(part => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [first, second] = ipv4;
    if (first === 0 || first === 10 || first === 127 || first >= 224
      || (first === 100 && second >= 64 && second <= 127) || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 0)
      || (first === 192 && second === 168) || (first === 198 && (second === 18 || second === 19))) return false;
  }
  return true;
}

export function isCanonicalReadmeMediaUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return isPublicHttpsReadmeMediaUrl(url) && url.toString() === value;
  } catch { return false; }
}

export function isReadmeMediaVideoUrl(value: unknown): value is string {
  if (!isCanonicalReadmeMediaUrl(value)) return false;
  const parsed = new URL(value);
  const githubDownload = parsed.hostname === 'github.com'
    && /^\/[^/]+\/[^/]+\/(?:raw\/[^/]+\/.+|releases\/download\/[^/]+\/[^/]+)$/.test(parsed.pathname);
  const direct = (parsed.hostname !== 'github.com' || githubDownload)
    && /\.(?:mp4|webm|mov|m4v|ogv)$/i.test(parsed.pathname);
  const attachment = parsed.hostname === 'github.com' && /^\/user-attachments\/assets\/[a-z0-9-]+\/?$/i.test(parsed.pathname);
  return direct || attachment;
}
