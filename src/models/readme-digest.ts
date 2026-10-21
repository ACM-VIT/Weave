/** Versioned V2 README digest; the short card summary remains a different field. */
export type ReadmeDigest = {
  summary_id: string;
  content_version: number;
  content_hash: string;
  prompt_version: string;
  format_version: string;
  model_version: string;
  source: 'generated';
  generated_at: string;
  overview: string;
  capabilities: string[];
  use_cases: string[];
  considerations: string[];
};

export function parseReadmeDigest(value: unknown): ReadmeDigest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const text = (item: unknown, max: number): item is string => typeof item === 'string' && item.trim().length>0 && item.length<=max;
  const list = (item: unknown, min: number, max: number, length: number): item is string[] => Array.isArray(item)
    && item.length>=min && item.length<=max && item.every((entry) => text(entry,length));
  if (data.source!=='generated' || data.format_version!=='readme-digest-json-v1'
    || !Number.isInteger(data.content_version) || Number(data.content_version)<1
    || !text(data.summary_id,128) || !text(data.content_hash,256) || !text(data.prompt_version,128)
    || !text(data.model_version,256) || !text(data.generated_at,128)
    || !Number.isFinite(Date.parse(data.generated_at)) || !text(data.overview,750)
    || !list(data.capabilities,2,5,250) || !list(data.use_cases,1,3,220) || !list(data.considerations,0,2,220)) return null;
  return data as ReadmeDigest;
}

export function readmeDigestMarkdown(digest: ReadmeDigest): string {
  const sections: [string, string[]][] = [
    ['Key capabilities', digest.capabilities],
    ['Use cases', digest.use_cases],
    ['Things to know', digest.considerations],
  ];
  return [digest.overview, ...sections.filter(([, items]) => items.length)
    .map(([title, items]) => `## ${title}\n\n${items.map((item) => `- ${item}`).join('\n')}`)]
    .join('\n\n');
}

export function resolveReadmeDigest(
  initial: ReadmeDigest | null | undefined,
  reported: { content_version: number; summary: ReadmeDigest | null } | undefined,
  contentVersion?: number | null,
): ReadmeDigest | null {
  if (contentVersion != null) {
    if (initial && initial.content_version < contentVersion) initial = null;
    if (reported && reported.content_version < contentVersion) reported = undefined;
  }
  if (!reported || (initial && initial.content_version>reported.content_version)) return initial??null;
  return reported.summary ?? (initial?.content_version===reported.content_version ? initial : null);
}

export function readmeSummaryQueryKey(viewer: string | undefined, repositoryId: string | undefined, contentVersion: number | null | undefined) {
  return ['readme-summary', viewer, repositoryId, contentVersion ?? null] as const;
}
