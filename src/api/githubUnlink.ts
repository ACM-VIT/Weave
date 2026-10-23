import { apiV2ForOwner } from './owner-request';

export interface GithubUnlinkResult { status: 'none' | 'pending' | 'done' | 'refused' | 'superseded'; message?: string }
const base = '/onboarding/github-unlink';
export const githubUnlinkApi = {
  start: (code_challenge: string, redirect_uri: string, signal: AbortSignal, owner: string) => apiV2ForOwner<{ url: string }>(owner, `${base}/start`, {
    method: 'POST', body: JSON.stringify({ code_challenge, redirect_uri, confirmation: 'disconnect-github' }), signal,
  }),
  finish: (unlink_code: string, code_verifier: string, signal: AbortSignal, owner: string) => apiV2ForOwner<GithubUnlinkResult>(owner, `${base}/finish`, {
    method: 'POST', body: JSON.stringify({ unlink_code, code_verifier, confirmation: 'disconnect-github' }), signal,
  }),
  status: (signal: AbortSignal, owner: string) => apiV2ForOwner<GithubUnlinkResult>(owner, `${base}/status`, { method: 'POST', body: '{}', signal }),
};
