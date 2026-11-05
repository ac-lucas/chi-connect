// Cleaning and size limits for every piece of text a person types or receives.
// The same functions are used for our own input and for anything arriving from another device.

export const LIMITS = {
  displayName: 60,
  role: 80,
  company: 80,
  link: 200,
  links: 3,
  tags: 12,
  tagLabel: 30,
  note: 2000,
} as const;

// C0 and C1 control characters, bidi embedding, override and isolate controls, invisible marks that let two names
// look the same (zero-width space, LRM/RLM, Arabic letter mark, word joiner and invisible operators, Mongolian vowel
// separator), and the byte order mark. Zero-width joiner and non-joiner (U+200C, U+200D) are kept: several scripts
// and emoji sequences need them.
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g; // become spaces (they often separate words)
const INVISIBLE = /[\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g; // removed outright

/** Split into user-visible characters (Intl.Segmenter where available, else code points). */
export function graphemes(s: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(seg.segment(s), (x) => x.segment);
  }
  return Array.from(s);
}

/** Normalise, strip unsafe characters, collapse whitespace and cut to `max` visible characters. */
export function cleanText(input: unknown, max: number): string {
  if (typeof input !== 'string') return '';
  const s = input.normalize('NFC').replace(CONTROL, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  const g = graphemes(s);
  return g.length > max ? g.slice(0, max).join('').trim() : s;
}

/** Accept only plain https links with no embedded credentials. Returns the cleaned URL or null. */
export function cleanUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let raw = input.trim();
  if (!raw || raw.length > LIMITS.link) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.')) return null;
  const out = url.toString();
  return out.length > LIMITS.link ? null : out;
}
