import { apiV2ForOwner } from './owner-request';

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
  status(signal: AbortSignal, userId: string): Promise<GitHubImportStatus>;
  preview(signal: AbortSignal, userId: string): Promise<GitHubImportPreview>;
  accept(id: string, signal: AbortSignal, userId: string): Promise<unknown>;
  revoke(signal: AbortSignal, userId: string): Promise<unknown>;
  saveIdentity(draft: ImportIdentityDraft, signal: AbortSignal, userId: string): Promise<unknown>;
}
const base = '/onboarding/github-import';
export const githubImportApi: GitHubImportApi = {
  status: (signal, userId) => apiV2ForOwner(userId, base, { signal }),
  preview: (signal, userId) => apiV2ForOwner(userId, `${base}/preview`, { method: 'POST', body: JSON.stringify({ consent: true }), signal }),
  accept: (snapshot_id, signal, userId) => apiV2ForOwner(userId, `${base}/accept`, { method: 'POST', body: JSON.stringify({ snapshot_id }), signal }),
  revoke: (signal, userId) => apiV2ForOwner(userId, base, { method: 'DELETE', signal }),
  saveIdentity: (draft, signal, userId) => apiV2ForOwner(userId, '/users/me', { method: 'PATCH', body: JSON.stringify(draft), signal }),
};
