import { marked } from 'marked';
import type { ReadmeMediaImage, ReadmeMediaManifest } from '../contracts/readmeMedia.v2.js';

export interface ReadmeMediaContext {
  fullName: string;
  githubUrl: string;
  sourcePath: string | null;
  defaultBranch: string | null;
  baseUrl: string | null;
}

const BADGE_PATTERN = /(?:^|[\s/_-])(?:badge|badges|build[\s_-]?status|ci|coverage|license|npm[\s_-]?version|pypi|quality[\s_-]?gate)(?:$|[\s/_.-])/i;
const BADGE_HOST_PATTERN = /(?:^|\.)(?:badge|badges|img\.shields|shields|codecov|coveralls)\./i;
const PREFERRED_PREVIEW_PATTERN = /(?:screenshot|preview|demo|hero|showcase|interface|dashboard|app[-_ ]?view)/i;

function decodeBasicHtmlEntities(value: string): string {
  return value.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function isPublicHttpsUrl(url: URL): boolean {
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

function repositoryParts(context: ReadmeMediaContext): { owner: string; repo: string } | null {
  const match = /^([^/]+)\/([^/]+)$/.exec(context.fullName.trim());
  if (match) return { owner: match[1], repo: match[2].replace(/\.git$/i, '') };
  try {
    const url = new URL(context.githubUrl);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return null;
    const [owner, repo] = url.pathname.split('/').filter(Boolean);
    return owner && repo ? { owner, repo: repo.replace(/\.git$/i, '') } : null;
  } catch { return null; }
}

function encodePathSegments(value: string): string {
  return value.split('/').filter(segment => segment && segment !== '.')
    .map(segment => encodeURIComponent(segment)).join('/');
}

function rawRepositoryRoot(context: ReadmeMediaContext): URL | null {
  const parts = repositoryParts(context);
  if (!parts) return null;
  const root = new URL(`https://raw.githubusercontent.com/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/`);
  try {
    const pinned = new URL(context.baseUrl ?? '');
    const commit = pinned.pathname.slice(root.pathname.length).split('/')[0];
    if (isPublicHttpsUrl(pinned) && pinned.origin === root.origin && pinned.pathname.startsWith(root.pathname)
      && /^[a-f0-9]{40}$/.test(commit) && !pinned.search && !pinned.hash && pinned.pathname.endsWith('/')) {
      return new URL(`${commit}/`, root);
    }
  } catch { /* Use the validated branch when no pinned source is available. */ }
  const branch = context.defaultBranch?.trim();
  if (!branch || branch.split('/').some(segment => segment === '.' || segment === '..')) return null;
  return new URL(`https://raw.githubusercontent.com/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/refs/heads/${encodePathSegments(branch)}/`);
}

function readmeDirectoryBase(context: ReadmeMediaContext, root: URL): URL {
  const sourcePath = (context.sourcePath ?? 'README.md').replace(/\\/g, '/').replace(/^\/+/, '');
  const slash = sourcePath.lastIndexOf('/');
  const encoded = encodePathSegments(slash >= 0 ? sourcePath.slice(0, slash + 1) : '');
  return new URL(encoded ? `${encoded}/` : '', root);
}

function trustedMetadataBase(context: ReadmeMediaContext, root: URL): URL | null {
  if (!context.baseUrl) return null;
  try {
    const base = new URL(context.baseUrl);
    if (!isPublicHttpsUrl(base) || base.hostname.toLowerCase() !== 'raw.githubusercontent.com'
      || !base.pathname.startsWith(root.pathname)) return null;
    if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`;
    return base;
  } catch { return null; }
}

function safeAbsoluteUrl(value: string): string | null {
  try { const url = new URL(value); return isPublicHttpsUrl(url) ? url.toString() : null; }
  catch { return null; }
}

function resolveMediaUrl(source: string | null | undefined, context: ReadmeMediaContext): string | null {
  const value = decodeBasicHtmlEntities(source?.trim() ?? '');
  if (!value || value.startsWith('//')) return null;
  const absolute = safeAbsoluteUrl(value);
  if (absolute) return absolute;
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('#')) return null;
  const root = rawRepositoryRoot(context);
  if (!root) return null;
  const base = trustedMetadataBase(context, root) ?? readmeDirectoryBase(context, root);
  try {
    const relative = value.startsWith('/') ? value.slice(1) : value;
    const resolved = new URL(relative, value.startsWith('/') ? root : base);
    if (!isPublicHttpsUrl(resolved) || resolved.origin !== root.origin || !resolved.pathname.startsWith(root.pathname)) return null;
    return resolved.toString();
  } catch { return null; }
}

function isBadgeImage(source: string, alt: string): boolean {
  try { if (BADGE_HOST_PATTERN.test(`${new URL(source).hostname}.`)) return true; }
  catch { return true; }
  return BADGE_PATTERN.test(`${alt} ${source}`);
}

type ImageCandidate = { alt: string; source: string };

function readmeImageCandidates(markdown: string): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];
  const markdownImage = /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g;
  const htmlImage = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  for (const match of markdown.matchAll(markdownImage)) candidates.push({ alt: match[1] ?? '', source: match[2] ?? match[3] ?? '' });
  for (const match of markdown.matchAll(htmlImage)) {
    const altMatch = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[0]);
    candidates.push({ alt: altMatch?.[1] ?? altMatch?.[2] ?? altMatch?.[3] ?? '', source: match[1] ?? match[2] ?? match[3] ?? '' });
  }
  return candidates;
}

function previewImage(markdown: string, context: ReadmeMediaContext): ReadmeMediaImage | null {
  const candidates = readmeImageCandidates(markdown).map((candidate, index) => ({
    alt: decodeBasicHtmlEntities(candidate.alt).trim(), index,
    url: resolveMediaUrl(candidate.source, context),
  })).filter((candidate): candidate is { alt: string; index: number; url: string } =>
    Boolean(candidate.url) && !isBadgeImage(candidate.url ?? '', candidate.alt));
  candidates.sort((left, right) => Number(PREFERRED_PREVIEW_PATTERN.test(`${right.alt} ${right.url}`))
    - Number(PREFERRED_PREVIEW_PATTERN.test(`${left.alt} ${left.url}`)) || left.index - right.index);
  return candidates.length ? { alt: candidates[0].alt || 'Repository preview', url: candidates[0].url } : null;
}

function summaryImages(markdown: string, context: ReadmeMediaContext): ReadmeMediaImage[] {
  const images: ReadmeMediaImage[] = [];
  const seen = new Set<string>();
  const add = (candidate: ImageCandidate) => {
    const url = resolveMediaUrl(candidate.source, context);
    const alt = decodeBasicHtmlEntities(candidate.alt).trim();
    if (!url || seen.has(url) || isBadgeImage(url, alt) || images.length >= 3) return;
    seen.add(url); images.push({ alt: alt || 'Repository image', url });
  };
  marked.walkTokens(marked.lexer(markdown.slice(0, 1_000_000)), token => {
    if (token.type === 'image') add({ source: token.href, alt: token.text });
    if (token.type === 'html') {
      const html = token.raw.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
      for (const candidate of readmeImageCandidates(html)) add(candidate);
    }
  });
  return images;
}

function summaryVideos(markdown: string, context: ReadmeMediaContext): string[] {
  const videos = new Set<string>();
  const add = (source: string) => {
    if (videos.size >= 3) return;
    const url = resolveMediaUrl(source, context);
    if (!url) return;
    const parsed = new URL(url);
    const githubDownload = parsed.hostname === 'github.com'
      && /^\/[^/]+\/[^/]+\/(?:raw\/[^/]+\/.+|releases\/download\/[^/]+\/[^/]+)$/.test(parsed.pathname);
    const direct = (parsed.hostname !== 'github.com' || githubDownload)
      && /\.(?:mp4|webm|mov|m4v|ogv)$/i.test(parsed.pathname);
    const attachment = parsed.hostname === 'github.com' && /^\/user-attachments\/assets\/[a-z0-9-]+\/?$/i.test(parsed.pathname);
    if (direct || attachment) videos.add(url);
  };
  marked.walkTokens(marked.lexer(markdown.slice(0, 1_000_000)), token => {
    if (token.type === 'link') add(token.href);
    if (token.type === 'html') {
      const html = token.raw.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
      for (const tag of html.matchAll(/<(?:video|source)\b[^>]*>/gi)) {
        const src = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag[0]);
        if (src) add(src[1] ?? src[2] ?? src[3]);
      }
    }
  });
  return [...videos];
}

export function deriveReadmeMediaManifest(input: {
  markdown: string | null;
  context: ReadmeMediaContext;
  contentVersion: number;
  contentHash: string;
}): ReadmeMediaManifest {
  const markdown = input.markdown ?? '';
  return {
    schema_version: 1,
    content_version: input.contentVersion,
    content_hash: input.contentHash,
    readme_available: input.markdown !== null,
    poster: previewImage(markdown, input.context),
    images: summaryImages(markdown, input.context),
    videos: summaryVideos(markdown, input.context),
  };
}

function isReadmeMediaImage(value: unknown): value is ReadmeMediaImage {
  if (!value || typeof value !== 'object') return false;
  const image = value as Partial<ReadmeMediaImage>;
  return typeof image.alt === 'string' && typeof image.url === 'string';
}

export function isCurrentReadmeMediaManifest(value: unknown, contentVersion: number, contentHash: string): value is ReadmeMediaManifest {
  if (!value || typeof value !== 'object') return false;
  const manifest = value as Partial<ReadmeMediaManifest>;
  return manifest.schema_version === 1 && manifest.content_version === contentVersion
    && manifest.content_hash === contentHash && typeof manifest.readme_available === 'boolean'
    && Array.isArray(manifest.images) && manifest.images.every(isReadmeMediaImage)
    && Array.isArray(manifest.videos) && manifest.videos.every(video => typeof video === 'string')
    && (manifest.poster === null || isReadmeMediaImage(manifest.poster));
}
