export interface RepositoryLanguage {
  name: string;
  color: string | null;
  size: number | null;
  percentage: number | null;
}
export interface RepositoryLanguageObservation {
  language_breakdown?: RepositoryLanguage[] | null;
  language_total_size?: number | null;
  language_breakdown_complete?: boolean | null;
}
type RawObservation = { [K in keyof RepositoryLanguageObservation]?: unknown };

function languageName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 128 || /^\p{Decimal_Number}+$/u.test(value.trim())) {
    throw new Error('Invalid repository language name.');
  }
  return value.trim();
}
function size(value: unknown): number | null {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('Invalid language byte size.');
  return value as number;
}
function row(value: unknown): RepositoryLanguage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid language breakdown row.');
  const item = value as Record<string, unknown>;
  const color = item.color ?? null, percentage = item.percentage ?? null;
  if (color !== null && (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color))) throw new Error('Invalid language color.');
  if (percentage !== null && (typeof percentage !== 'number' || !Number.isFinite(percentage) || percentage < 0 || percentage > 100)) {
    throw new Error('Invalid language percentage.');
  }
  return { name: languageName(item.name), color, size: size(item.size), percentage };
}
function rows(value: unknown): RepositoryLanguage[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Language breakdown must contain at most 100 rows.');
  const result = value.map(row), names = new Set<string>();
  for (const item of result) {
    const key = Array.from(item.name, character => character === 'ı' ? character : character.toUpperCase().toLowerCase()).join('');
    if (names.has(key)) throw new Error('Duplicate language breakdown name.');
    names.add(key);
  }
  return result;
}

/** Normalize historical shapes without deriving percentages from an unproven denominator. */
export function normalizeRepositoryLanguages(value: unknown, observation: RawObservation = {}): {languages: string[]} & RepositoryLanguageObservation {
  let names: string[] = [], legacy: RepositoryLanguage[] | undefined;
  if (value != null) {
    if (Array.isArray(value)) {
      if (value.length > 100) throw new Error('At most 100 repository languages are allowed.');
      if (value.every(item => typeof item === 'string')) names = value.map(languageName);
      else { legacy = rows(value); names = legacy.map(item => item.name); }
    } else if (typeof value === 'object') {
      const entries = Object.entries(value);
      if (entries.length > 100) throw new Error('At most 100 repository languages are allowed.');
      if (entries.length) {
        legacy = rows(entries.map(([name, bytes]) => ({name,size:bytes})));
        names = legacy.map(item => item.name);
      }
    } else throw new Error('Invalid repository languages.');
  }
  names = [...new Set(names)];
  const explicit = ['language_breakdown','language_total_size','language_breakdown_complete'].some(key => observation[key as keyof RawObservation] != null);
  if (!explicit && !legacy) return {languages:names};
  const breakdown = observation.language_breakdown == null ? legacy ?? null : rows(observation.language_breakdown);
  const total = size(observation.language_total_size);
  const complete = observation.language_breakdown_complete ?? null;
  if (complete !== null && typeof complete !== 'boolean') throw new Error('Invalid language completeness.');
  let bytes = 0n, percentages = 0, providedPercentages = 0;
  for (const item of breakdown ?? []) {
    if (item.size !== null) bytes += BigInt(item.size);
    if (item.percentage !== null) {
      percentages += item.percentage; providedPercentages++;
      if (total !== null && total > 0 && item.size !== null && Math.abs(item.percentage - 100 * item.size / total) > 0.01 + 1e-8) {
        throw new Error('Language percentage does not match the observed total.');
      }
    }
  }
  if (percentages > 100 + providedPercentages * 0.01 + 1e-8) throw new Error('Language percentages exceed the observed total.');
  if (total !== null && bytes > BigInt(total)) throw new Error('Language byte sizes exceed the observed total.');
  if (complete === true && (total === null || breakdown === null || breakdown.some(item => item.size === null) || bytes !== BigInt(total))) {
    throw new Error('Complete language data requires every byte size and an exact total.');
  }
  if (!names.length && breakdown?.length) names = breakdown.map(item => item.name);
  return {languages:names,language_breakdown:breakdown,language_total_size:total,language_breakdown_complete:complete};
}


export const LANGUAGE_OBSERVATION_FIELDS = ['language_breakdown','language_total_size','language_breakdown_complete'] as const;
export function hasLanguageObservation(value: RepositoryLanguageObservation): boolean {
  return LANGUAGE_OBSERVATION_FIELDS.some(key => value[key] != null);
}

/** Public reads remain usable for historical malformed rows, with unknown composition. */
export function projectRepositoryLanguages(value: Record<string, unknown>): {languages: string[]} & RepositoryLanguageObservation & {language_observed_at?: string | null} {
  let result: {languages:string[]} & RepositoryLanguageObservation;
  try { result = normalizeRepositoryLanguages(value.languages,value); }
  catch {
    try { result = {languages:normalizeRepositoryLanguages(value.languages).languages}; }
    catch { result = {languages:[]}; }
  }
  const stamp = value.language_observed_at;
  return {...result,language_observed_at:stamp instanceof Date ? stamp.toISOString() : typeof stamp === 'string' ? stamp : null};
}
