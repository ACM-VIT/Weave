export function summarizeDescription(description: string | null | undefined): string | null {
  const normalized = description?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length <= 360) return normalized;

  const prefix = normalized.slice(0, 359);
  const lastWordBoundary = prefix.lastIndexOf(" ");
  return `${prefix.slice(0, lastWordBoundary >= 180 ? lastWordBoundary : 359).trimEnd()}…`;
}
