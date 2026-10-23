import { apiV2 } from './client';

export interface GithubUnlinkResult { status: 'none' | 'pending' | 'done' | 'refused' | 'superseded'; message?: string }
const base = '/onboarding/github-unlink';
export const githubUnlinkApi = {
  start: (code_challenge: string, redirect_uri: string, signal: AbortSignal) => apiV2<{ url: string }>(`${base}/start`, {
    method: 'POST', body: JSON.stringify({ code_challenge, redirect_uri, confirmation: 'disconnect-github' }), signal,
  }),
  finish: (unlink_code: string, code_verifier: string, signal: AbortSignal) => apiV2<GithubUnlinkResult>(`${base}/finish`, {
    method: 'POST', body: JSON.stringify({ unlink_code, code_verifier, confirmation: 'disconnect-github' }), signal,
  }),
  status: (signal: AbortSignal) => apiV2<GithubUnlinkResult>(`${base}/status`, { method: 'POST', body: '{}', signal }),
};
