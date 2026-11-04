import { KNOWN_TAGS, type KnownTag } from '../data/tags';
import { cleanText, LIMITS } from './text';
import type { Tag } from './types';

/** Lower-case, fold compatibility forms, turn punctuation into spaces. Keeps letters in any script. */
export function normaliseTagText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

const index = new Map<string, KnownTag>();
for (const t of KNOWN_TAGS) {
  for (const name of [t.label, t.id, ...t.aliases]) index.set(normaliseTagText(name), t);
}

const byId = new Map(KNOWN_TAGS.map((t) => [t.id, t]));

/** Look up a known topic by its ID (used when decoding a connect code). */
export function knownTagById(id: string): Tag | null {
  const t = byId.get(id);
  return t ? knownTag(t) : null;
}

export function knownTag(t: KnownTag): Tag {
  return { key: t.id, label: t.label };
}

/** Turn typed text into a tag: a known topic if it matches one (or an alias), otherwise a custom tag. */
export function resolveTag(text: string): Tag | null {
  const label = cleanText(text, LIMITS.tagLabel);
  const norm = normaliseTagText(label);
  if (!norm) return null;
  const known = index.get(norm);
  if (known) return knownTag(known);
  return { key: `x:${norm}`, label };
}

/** Known topics whose label or aliases contain the query. Empty query returns all. */
export function searchKnownTags(query: string): KnownTag[] {
  const q = normaliseTagText(query);
  if (!q) return [...KNOWN_TAGS];
  return KNOWN_TAGS.filter((t) => [t.label, ...t.aliases].some((n) => normaliseTagText(n).includes(q)));
}

/** Tags both people have, matched on the canonical key. Order follows `mine`. */
export function sharedTags(mine: readonly Tag[], theirs: readonly Tag[]): Tag[] {
  const keys = new Set(theirs.map((t) => t.key));
  return mine.filter((t) => keys.has(t.key));
}

/** Clean an untrusted tag list: re-resolve each label, drop duplicates and cut to the limit. */
export function cleanTags(input: unknown): Tag[] {
  if (!Array.isArray(input)) return [];
  const out: Tag[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const label = typeof item === 'string' ? item : (item as { label?: unknown } | null)?.label;
    if (typeof label !== 'string') continue;
    const tag = resolveTag(label);
    if (!tag || seen.has(tag.key)) continue;
    seen.add(tag.key);
    out.push(tag);
    if (out.length >= LIMITS.tags) break;
  }
  return out;
}
