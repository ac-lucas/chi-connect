import { describe, expect, it } from 'vitest';
import { KNOWN_TAGS } from '../data/tags';
import { normaliseTagText } from './tags';
import { cleanTags, resolveTag, searchKnownTags, sharedTags } from './tags';
import { LIMITS } from './text';

describe('resolveTag', () => {
  it('maps aliases to the known topic', () => {
    expect(resolveTag('VR')?.key).toBe('vr');
    expect(resolveTag('virtual reality')?.key).toBe('vr');
    expect(resolveTag('Data Visualisation')?.key).toBe('visualization');
    expect(resolveTag('a11y')?.label).toBe('Accessibility');
  });
  it('matches custom tags on normalised text', () => {
    const a = resolveTag('Slow-Tech!');
    const b = resolveTag('slow tech');
    expect(a?.key).toBe(b?.key);
    expect(a?.key.startsWith('x:')).toBe(true);
    expect(a?.label).toBe('Slow-Tech!');
  });
  it('keeps non-Latin custom tags', () => {
    expect(resolveTag('インタラクション')?.key).toBe('x:インタラクション');
  });
  it('returns null for empty or punctuation-only input', () => {
    expect(resolveTag('   ')).toBeNull();
    expect(resolveTag('!!!')).toBeNull();
  });
});

describe('vocabulary', () => {
  it('has no alias that points at two topics', () => {
    const seen = new Map<string, string>();
    for (const t of KNOWN_TAGS) {
      for (const n of [t.label, t.id, ...t.aliases]) {
        const k = normaliseTagText(n);
        const prev = seen.get(k);
        expect(prev === undefined || prev === t.id, `${k} in ${prev} and ${t.id}`).toBe(true);
        seen.set(k, t.id);
      }
    }
  });
  it('searches labels and aliases', () => {
    expect(searchKnownTags('reality').map((t) => t.id)).toEqual(expect.arrayContaining(['vr', 'ar']));
    expect(searchKnownTags('')).toHaveLength(KNOWN_TAGS.length);
  });
});

describe('sharedTags', () => {
  it('finds topics both people have, including via aliases and custom text', () => {
    const mine = cleanTags(['VR', 'Haptics', 'Slow tech']);
    const theirs = cleanTags(['virtual reality', 'slow-tech', 'Games']);
    expect(sharedTags(mine, theirs).map((t) => t.label)).toEqual(['Virtual reality', 'Slow tech']);
  });
});

describe('cleanTags', () => {
  it('drops junk and duplicates and enforces the limit', () => {
    const many = Array.from({ length: 30 }, (_, i) => `topic ${i}`);
    expect(cleanTags(many)).toHaveLength(LIMITS.tags);
    expect(cleanTags(['VR', 'vr', { label: 'Virtual reality' }, 7, null])).toHaveLength(1);
    expect(cleanTags('not an array')).toEqual([]);
  });
});
