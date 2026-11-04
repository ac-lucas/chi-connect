import { describe, expect, it } from 'vitest';
import { checkDraft, createProfile, emptyDraft, toSharedProfile } from './profile';
import { resolveTag } from './tags';

describe('checkDraft', () => {
  it('requires a name', () => {
    expect(checkDraft(emptyDraft()).errors.displayName).toBeTruthy();
  });
  it('cleans fields and flags bad links by position', () => {
    const d = { ...emptyDraft(), displayName: '  Ana ', links: ['example.com', 'javascript:x', ''] };
    const { clean, errors } = checkDraft(d);
    expect(clean.displayName).toBe('Ana');
    expect(clean.links).toEqual(['https://example.com/']);
    expect(errors.link1).toBeTruthy();
    expect(errors.link0).toBeUndefined();
  });
});

describe('createProfile and toSharedProfile', () => {
  it('makes a random device ID', () => {
    const d = { ...emptyDraft(), displayName: 'Ana' };
    expect(createProfile(d).deviceId).not.toBe(createProfile(d).deviceId);
    expect(createProfile(d).deviceId).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
  it('shares only the name plus chosen fields', () => {
    const p = createProfile({
      ...emptyDraft(),
      displayName: 'Ana',
      role: 'Designer',
      company: 'Somewhere',
      links: ['https://example.com/'],
      tags: [resolveTag('VR')!],
      share: { role: true, company: false, links: false, tags: true },
    });
    const shared = toSharedProfile(p);
    expect(shared).toEqual({ displayName: 'Ana', role: 'Designer', tags: [{ key: 'vr', label: 'Virtual reality' }] });
    expect(shared).not.toHaveProperty('deviceId');
    expect(shared).not.toHaveProperty('comfort');
  });
});
