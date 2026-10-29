import { Renderer, marked } from 'marked';
import { scanReadmeHtmlMediaCandidates } from '../../backend/contracts/readmeMedia.v2';

export type ReadmeImageContext = {
  fullName?: string | null;
  githubUrl?: string | null;
  readmeSourcePath?: string | null;
  readmeDefaultBranch?: string | null;
  readmeBaseUrl?: string | null;
};

const BADGE_PATTERN = /(?:^|[\s/_-])(?:badge|badges|build[\s_-]?status|ci|coverage|license|npm[\s_-]?version|pypi|quality[\s_-]?gate)(?:$|[\s/_.-])/i;
const BADGE_HOST_PATTERN = /(?:^|\.)(?:badge|badges|img\.shields|shields|codecov|coveralls)\./i;
const PREFERRED_PREVIEW_PATTERN = /(?:screenshot|preview|demo|hero|showcase|interface|dashboard|app[-_ ]?view)/i;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeBasicHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function isPublicHttpsUrl(url: URL): boolean {
  if (url.protocol !== 'https:' || url.username || url.password) return false;

  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/g, '');
  if (
    !hostname
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || !hostname.includes('.')
    || hostname.includes(':')
  ) {
    return false;
  }

  const ipv4 = hostname.split('.').map((part) => Number(part));
  if (ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [first, second] = ipv4;
    if (
      first === 0
      || first === 10
      || first === 127
      || first >= 224
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 0)
      || (first === 192 && second === 168)
      || (first === 198 && (second === 18 || second === 19))
    ) {
      return false;
    }
  }

  return true;
}

function repositoryParts(context: ReadmeImageContext): { owner: string; repo: string } | null {
  const fullName = context.fullName?.trim();
  if (fullName) {
    const match = /^([^/]+)\/([^/]+)$/.exec(fullName);
    if (match) return { owner: match[1], repo: match[2].replace(/\.git$/i, '') };
  }

  try {
    const url = new URL(context.githubUrl ?? '');
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return null;
    const [owner, repo] = url.pathname.split('/').filter(Boolean);
    return owner && repo ? { owner, repo: repo.replace(/\.git$/i, '') } : null;
  } catch {
    return null;
  }
}

function encodePathSegments(value: string): string {
  return value
    .split('/')
    .filter((segment) => segment && segment !== '.')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function rawRepositoryRoot(context: ReadmeImageContext): URL | null {
  const parts = repositoryParts(context);
  if (!parts) return null;
  const repositoryRoot = new URL(
    `https://raw.githubusercontent.com/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/`,
  );
  try {
    const pinned = new URL(context.readmeBaseUrl ?? '');
    const commit = pinned.pathname.slice(repositoryRoot.pathname.length).split('/')[0];
    if (isPublicHttpsUrl(pinned) && pinned.origin === repositoryRoot.origin
      && pinned.pathname.startsWith(repositoryRoot.pathname) && /^[a-f0-9]{40}$/.test(commit)
      && !pinned.search && !pinned.hash && pinned.pathname.endsWith('/')) {
      return new URL(`${commit}/`, repositoryRoot);
    }
  } catch { /* Missing or untrusted metadata retains the branch-based root. */ }
  const branch = context.readmeDefaultBranch?.trim();
  if (
    !branch
    || branch.split('/').some((segment) => segment === '.' || segment === '..')
  ) return null;

  return new URL(
    `https://raw.githubusercontent.com/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/refs/heads/${encodePathSegments(branch)}/`,
  );
}

function readmeDirectoryBase(context: ReadmeImageContext, root: URL): URL {
  const sourcePath = (context.readmeSourcePath ?? 'README.md')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  const finalSlash = sourcePath.lastIndexOf('/');
  const directory = finalSlash >= 0 ? sourcePath.slice(0, finalSlash + 1) : '';
  const encodedDirectory = encodePathSegments(directory);
  return new URL(encodedDirectory ? `${encodedDirectory}/` : '', root);
}

function trustedMetadataBase(context: ReadmeImageContext, root: URL): URL | null {
  if (!context.readmeBaseUrl) return null;
  try {
    const base = new URL(context.readmeBaseUrl);
    const expectedPrefix = root.pathname;
    if (
      !isPublicHttpsUrl(base)
      || base.hostname.toLowerCase() !== 'raw.githubusercontent.com'
      || !base.pathname.startsWith(expectedPrefix)
    ) {
      return null;
    }
    if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`;
    return base;
  } catch {
    return null;
  }
}

/** GitHub blob URLs serve HTML, even when their path ends in an image suffix. */
export function normalizeGithubReadmeImageUrl(value: string): string {
  try {
    const url=new URL(value);
    const parts=url.pathname.split('/').filter(Boolean);
    if (url.protocol==='https:' && url.hostname==='github.com' && !url.username && !url.password
      && parts.length>=5 && (parts[2]==='blob' || parts[2]==='raw')
      && /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico|tiff?)$/i.test(url.pathname)) {
      return `https://raw.githubusercontent.com/${parts.slice(0,2).join('/')}/${parts.slice(3).join('/')}${url.hash}`;
    }
  } catch { /* The resolver still rejects invalid or unsafe sources. */ }
  return value;
}

function safeAbsoluteUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return isPublicHttpsUrl(url) ? normalizeGithubReadmeImageUrl(url.toString()) : null;
  } catch {
    return null;
  }
}

export function resolveReadmeImageUrl(
  source: string | null | undefined,
  context: ReadmeImageContext,
): string | null {
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
    if (
      !isPublicHttpsUrl(resolved)
      || resolved.origin !== root.origin
      || !resolved.pathname.startsWith(root.pathname)
    ) {
      return null;
    }
    return resolved.toString();
  } catch {
    return null;
  }
}

function isBadgeImage(source: string, alt: string): boolean {
  try {
    const url = new URL(source);
    if (BADGE_HOST_PATTERN.test(`${url.hostname}.`)) return true;
  } catch {
    return true;
  }
  return BADGE_PATTERN.test(`${alt} ${source}`);
}

type ImageCandidate = { alt: string; source: string };

function readmeImageCandidates(markdown: string): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];
  marked.walkTokens(marked.lexer(markdown.slice(0, 1_000_000)), token => {
    if (token.type === 'image') candidates.push({ alt: token.text, source: token.href });
    if (token.type === 'html') for (const candidate of scanReadmeHtmlMediaCandidates(token.raw)) {
      if (candidate.kind === 'image') candidates.push({ alt: candidate.alt, source: candidate.source });
    }
  });
  return candidates;
}

export function extractReadmePreviewImage(
  markdown: string | null | undefined,
  context: ReadmeImageContext,
): { alt: string; url: string } | null {
  const candidates = readmeImageCandidates(markdown ?? '')
    .map((candidate, index) => ({
      alt: decodeBasicHtmlEntities(candidate.alt).trim(),
      index,
      url: resolveReadmeImageUrl(candidate.source, context),
    }))
    .filter((candidate): candidate is { alt: string; index: number; url: string } => (
      Boolean(candidate.url) && !isBadgeImage(candidate.url ?? '', candidate.alt)
    ));
  if (candidates.length === 0) return null;

  candidates.sort((left, right) => {
    const leftPreferred = PREFERRED_PREVIEW_PATTERN.test(`${left.alt} ${left.url}`) ? 1 : 0;
    const rightPreferred = PREFERRED_PREVIEW_PATTERN.test(`${right.alt} ${right.url}`) ? 1 : 0;
    return rightPreferred - leftPreferred || left.index - right.index;
  });
  return { alt: candidates[0].alt || 'Repository preview', url: candidates[0].url };
}

function sanitizeHtmlImageTag(tag: string, context: ReadmeImageContext): string {
  const sourceMatch = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  const altMatch = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  const alt = decodeBasicHtmlEntities(
    altMatch?.[1] ?? altMatch?.[2] ?? altMatch?.[3] ?? '',
  ).trim();
  const source = sourceMatch?.[1] ?? sourceMatch?.[2] ?? sourceMatch?.[3] ?? '';
  const resolved = resolveReadmeImageUrl(source, context);
  return resolved
    ? `<img src="${escapeHtml(resolved)}" alt="${escapeHtml(alt)}">`
    : alt ? `<span>${escapeHtml(alt)}</span>` : '';
}

export function renderReadmeMarkdown(
  markdown: string,
  context: ReadmeImageContext,
): string {
  const renderer = new Renderer();
  renderer.image = ({ href, text }) => {
    const resolved = resolveReadmeImageUrl(href, context);
    return resolved
      ? `<img src="${escapeHtml(resolved)}" alt="${escapeHtml(text)}">`
      : text ? `<span>${escapeHtml(text)}</span>` : '';
  };

  const html = marked.parse(markdown, { async: false, gfm: true, renderer }) as string;
  return html.replace(/<img\b[^>]*>/gi, (tag) => sanitizeHtmlImageTag(tag, context));
}

/** Bounded original README media for the digest, excluding badges and code examples. */
export function extractReadmeSummaryImages(markdown: string | null | undefined, context: ReadmeImageContext): {alt: string; url: string}[] {
  const images: {alt: string; url: string}[]=[];
  const seen=new Set<string>();
  const add=(candidate: ImageCandidate)=>{
    const url=resolveReadmeImageUrl(candidate.source,context);
    const alt=decodeBasicHtmlEntities(candidate.alt).trim();
    if (!url || seen.has(url) || isBadgeImage(url,alt) || images.length>=3) return;
    seen.add(url);images.push({alt:alt||'Repository image',url});
  };
  marked.walkTokens(marked.lexer((markdown??'').slice(0,1_000_000)),token=>{
    if(token.type==='image')add({source:token.href,alt:token.text});
    if(token.type==='html')for(const candidate of scanReadmeHtmlMediaCandidates(token.raw)){
      if(candidate.kind==='image')add(candidate);
    }
  });
  return images;
}
