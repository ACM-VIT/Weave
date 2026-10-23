import { apiV2 } from './client';

export interface GitHubImportStatus {
  linked: boolean;
  active: boolean;
  provenance: { collected_at?: string; source?: string };
}
export interface GitHubImportPreview {
  snapshot_id: string;
  collected_at: string;
  status: 'complete' | 'partial';
  repository_count: number;
  sources: Record<string, { status: string; count: number; error_code?: string }>;
  suggestions: { interests: string[]; skills: string[]; tech_stack: string[] };
  expires_at: string;
}
export type ImportIdentityDraft = { username: string; full_name: string; date_of_birth: string; bio?: string };
export interface GitHubImportApi {
  status(signal: AbortSignal): Promise<GitHubImportStatus>;
  preview(signal: AbortSignal): Promise<GitHubImportPreview>;
  accept(id: string, signal: AbortSignal): Promise<unknown>;
  revoke(signal: AbortSignal): Promise<unknown>;
  saveIdentity(draft: ImportIdentityDraft, signal: AbortSignal): Promise<unknown>;
}
const base = '/onboarding/github-import';
export const githubImportApi: GitHubImportApi = {
  status: signal => apiV2(base, { signal }),
  preview: signal => apiV2(`${base}/preview`, { method: 'POST', body: JSON.stringify({ consent: true }), signal }),
  accept: (snapshot_id, signal) => apiV2(`${base}/accept`, { method: 'POST', body: JSON.stringify({ snapshot_id }), signal }),
  revoke: signal => apiV2(base, { method: 'DELETE', signal }),
  saveIdentity: (draft, signal) => apiV2('/users/me', { method: 'PATCH', body: JSON.stringify(draft), signal }),
};
