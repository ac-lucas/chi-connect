import { describe, expect, it } from 'vitest';
import { cleanText, cleanUrl, LIMITS } from './text';

describe('cleanText', () => {
  it('trims and collapses whitespace', () => {
    expect(cleanText('  Sam \n\t Lee  ', 60)).toBe('Sam Lee');
  });
  it('strips control and bidi override characters', () => {
    expect(cleanText('Sam\u0000‮⁦Lee﻿', 60)).toBe('Sam Lee');
  });
  it('strips invisible marks that make lookalike names', () => {
    expect(cleanText('Mi\u200Bna\u200E Oka\u2060for\u061C', 60)).toBe('Mina Okafor');
  });
  it('keeps joiners used by emoji and scripts', () => {
    const family = '👩‍👩‍👧';
    expect(cleanText(family, 60)).toBe(family);
    expect(cleanText('می‌خواهم', 60)).toBe('می‌خواهم');
  });
  it('cuts to the limit without splitting a character', () => {
    expect(cleanText('ab👩‍👩‍👧cd', 3)).toBe('ab👩‍👩‍👧');
    expect(cleanText('x'.repeat(500), LIMITS.displayName)).toHaveLength(LIMITS.displayName);
  });
  it('handles non-Latin text', () => {
    expect(cleanText('  山田 太郎  ', 60)).toBe('山田 太郎');
  });
  it('returns empty for non-strings', () => {
    expect(cleanText(42, 60)).toBe('');
    expect(cleanText(null, 60)).toBe('');
  });
});

describe('cleanUrl', () => {
  it('accepts https and adds it when missing', () => {
    expect(cleanUrl('https://example.com/me')).toBe('https://example.com/me');
    expect(cleanUrl('example.com/me')).toBe('https://example.com/me');
  });
  it('rejects other schemes', () => {
    expect(cleanUrl('javascript:alert(1)')).toBeNull();
    expect(cleanUrl('http://example.com')).toBeNull();
    expect(cleanUrl('data:text/html,hi')).toBeNull();
  });
  it('rejects credentials, bare words and long input', () => {
    expect(cleanUrl('https://user:pw@example.com')).toBeNull();
    expect(cleanUrl('hello')).toBeNull();
    expect(cleanUrl(`https://example.com/${'a'.repeat(300)}`)).toBeNull();
    expect(cleanUrl(5)).toBeNull();
  });
});
