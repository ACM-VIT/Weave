/** React Native's AbortSignal lacks throwIfAborted; keep cancellation portable. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? Object.assign(new Error('Operation cancelled.'), { name: 'AbortError' });
  }
}
