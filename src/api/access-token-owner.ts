function decodeBase64Url(value: string): string | null {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  let bits = 0;
  let bitCount = 0;
  let decoded = '';

  for (const character of normalized.replace(/=+$/, '')) {
    const index = alphabet.indexOf(character);
    if (index < 0) return null;
    bits = (bits << 6) | index;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      decoded += String.fromCharCode((bits >> bitCount) & 0xff);
      bits &= (1 << bitCount) - 1;
    }
  }

  return decoded;
}

export function accessTokenOwner(token: string): string | null {
  const payload = token.split('.')[1];
  if (!payload) return null;

  try {
    const decoded = decodeBase64Url(payload);
    if (!decoded) return null;
    const claims = JSON.parse(decoded) as { userId?: unknown; sub?: unknown };
    if (typeof claims.userId === 'string' && claims.userId) return claims.userId;
    if (typeof claims.sub === 'string' && claims.sub) return claims.sub;
  } catch {
    return null;
  }

  return null;
}

export function tokensHaveSameOwner(first: string, second: string): boolean {
  const firstOwner = accessTokenOwner(first);
  return firstOwner !== null && firstOwner === accessTokenOwner(second);
}

export function selectCurrentSessionToken(
  requestedToken: string,
  currentToken: string | null,
): string | null {
  if (!currentToken) return null;
  if (requestedToken === currentToken) return currentToken;
  return tokensHaveSameOwner(requestedToken, currentToken) ? currentToken : null;
}
