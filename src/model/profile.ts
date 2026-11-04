import { randomId } from './ids';
import { cleanTags } from './tags';
import { cleanText, cleanUrl, LIMITS } from './text';
import type { Profile, SharedProfile, ShareChoices, Tag } from './types';

export interface ProfileDraft {
  displayName: string;
  role: string;
  company: string;
  links: string[];
  tags: Tag[];
  share: ShareChoices;
}

export type DraftField = 'displayName' | 'role' | 'company' | `link${number}` | 'tags';
export type DraftErrors = Partial<Record<DraftField, string>>;

export const DEFAULT_SHARE: ShareChoices = { role: true, company: true, links: true, tags: true };

export function emptyDraft(): ProfileDraft {
  return { displayName: '', role: '', company: '', links: ['', '', ''], tags: [], share: { ...DEFAULT_SHARE } };
}

export function draftFromProfile(p: Profile): ProfileDraft {
  const links = [...p.links];
  while (links.length < LIMITS.links) links.push('');
  return { displayName: p.displayName, role: p.role, company: p.company, links, tags: [...p.tags], share: { ...p.share } };
}

/** Clean a draft and report problems. Returns the cleaned values even when there are errors. */
export function checkDraft(d: ProfileDraft): { clean: ProfileDraft; errors: DraftErrors } {
  const errors: DraftErrors = {};
  const displayName = cleanText(d.displayName, LIMITS.displayName);
  if (!displayName) errors.displayName = 'Add the name you’d like people to see.';
  const links: string[] = [];
  d.links.slice(0, LIMITS.links).forEach((raw, i) => {
    if (!raw.trim()) return;
    const url = cleanUrl(raw);
    if (url) links.push(url);
    else errors[`link${i}`] = 'That doesn’t look like a web address. Try something like example.com/you.';
  });
  return {
    clean: {
      displayName,
      role: cleanText(d.role, LIMITS.role),
      company: cleanText(d.company, LIMITS.company),
      links,
      tags: cleanTags(d.tags),
      share: { ...d.share },
    },
    errors,
  };
}

export function createProfile(d: ProfileDraft, now = Date.now()): Profile {
  return {
    deviceId: randomId(),
    ...d,
    comfort: { quietPlaces: false, stepFree: false, dietary: [] },
    createdAt: now,
    updatedAt: now,
  };
}

export function updateProfile(p: Profile, d: ProfileDraft, now = Date.now()): Profile {
  return { ...p, ...d, updatedAt: now };
}

/** What another person receives when you connect: your name plus the fields you chose. */
export function toSharedProfile(p: Pick<Profile, 'displayName' | 'role' | 'company' | 'links' | 'tags' | 'share'>): SharedProfile {
  const out: SharedProfile = { displayName: p.displayName };
  if (p.share.role && p.role) out.role = p.role;
  if (p.share.company && p.company) out.company = p.company;
  if (p.share.links && p.links.length) out.links = [...p.links];
  if (p.share.tags && p.tags.length) out.tags = [...p.tags];
  return out;
}
