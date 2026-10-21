/** Opt-in fixture suites may write only to the dedicated local scratch database. */
export function assertDisposableDatabase(): void {
  const fail = () => { throw new Error('Use the disposable loopback weave_scroll database outside production.'); };
  let url: URL;
  try { url = new URL(process.env.DATABASE_URL ?? ''); } catch { return fail(); }
  if (process.env.NODE_ENV === 'production'
    || !['postgres:', 'postgresql:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.pathname !== '/weave_scroll' || url.search || url.hash) fail();
}
