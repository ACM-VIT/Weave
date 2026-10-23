export interface TaxonomySelection {
  id: string;
  label: string;
}

export interface OnboardingTaxonomy {
  skills: readonly { id: string; title: string }[];
  interests: readonly { interests: readonly { id: string; name: string }[] }[];
}

function selectionIndex(entries: readonly TaxonomySelection[]): Map<string, TaxonomySelection> {
  const result = new Map<string, TaxonomySelection>();
  for (const entry of entries) {
    const id = entry.id.trim();
    const label = entry.label.trim();
    if (!id || !label) throw new Error('Taxonomy entries require an ID and label.');
    const previous = result.get(id);
    if (previous && previous.label !== label) throw new Error(`Ambiguous taxonomy ID: ${id}`);
    result.set(id, { id, label });
  }
  return result;
}

function resolve(ids: readonly string[], index: ReadonlyMap<string, TaxonomySelection>): TaxonomySelection[] {
  if (ids.length > 50) throw new Error('Choose at most 50 selections per category.');
  const selected = new Map<string, TaxonomySelection>();
  for (const id of ids) {
    const entry = index.get(id);
    if (!entry) throw new Error(`Unknown taxonomy selection: ${id}`);
    selected.set(id, { ...entry });
  }
  return [...selected.values()];
}

/** Keep stable UI IDs as provenance while supplying meaningful labels to ML. */
export function resolveOnboardingTaxonomy(
  selected: { skills?: readonly string[]; interests?: readonly string[]; tech_stack?: readonly string[] },
  taxonomy: OnboardingTaxonomy,
) {
  const skills = resolve(selected.skills ?? [], selectionIndex(
    taxonomy.skills.map(entry => ({ id: entry.id, label: entry.title })),
  ));
  const interests = resolve(selected.interests ?? [], selectionIndex(
    taxonomy.interests.flatMap(category => category.interests.map(entry => ({ id: entry.id, label: entry.name }))),
  ));
  const techStack = selected.tech_stack ?? [];
  if (techStack.length > 50 || techStack.some(value => !value.trim() || value.length > 100)) {
    throw new Error('Choose at most 50 nonempty technology names of at most 100 characters.');
  }
  return {
    taxonomy_selections: { skills, interests },
    skills: skills.map(entry => entry.label),
    interests: interests.map(entry => entry.label),
    tech_stack: [...new Set(techStack.map(value => value.trim()))],
  };
}
