import { describe, expect, it } from 'vitest';
import a2a from '../../electron/a2a.cjs';

const { normalizeUrl, textFromMessage, isPrivateAddress, safeEqual } = a2a._internals;

describe('a2a message parsing', () => {
  it('joins text parts and trims the goal', () => {
    expect(textFromMessage({ role: 'user', parts: [{ kind: 'text', text: '  hello' }, { kind: 'text', text: 'world  ' }] })).toBe('hello\nworld');
  });

  it('accepts a part without an explicit kind when it has text', () => {
    expect(textFromMessage({ parts: [{ text: 'plain' }] })).toBe('plain');
  });

  it('refuses file parts instead of guessing at them', () => {
    expect(() => textFromMessage({ parts: [{ kind: 'file', file: { uri: 'file:///etc/passwd' } }] })).toThrow(/Only text parts/);
  });

  it('refuses an empty message', () => {
    expect(() => textFromMessage({ parts: [] })).toThrow(/no parts/);
    expect(() => textFromMessage({ parts: [{ kind: 'text', text: '   ' }] })).toThrow(/empty/);
    expect(() => textFromMessage(null)).toThrow(/required/);
  });

  it('caps the goal length', () => {
    expect(() => textFromMessage({ parts: [{ kind: 'text', text: 'x'.repeat(9000) }] })).toThrow(/longer/);
  });
});

describe('a2a peer urls', () => {
  it('accepts http(s) and strips a trailing /a2a', () => {
    expect(normalizeUrl('http://192.168.1.20:47831/a2a')).toBe('http://192.168.1.20:47831');
    expect(normalizeUrl('https://agent.example.com/')).toBe('https://agent.example.com');
  });

  it('rejects non-http schemes and embedded credentials', () => {
    expect(() => normalizeUrl('ftp://127.0.0.1')).toThrow(/http/i);
    expect(() => normalizeUrl('http://user:pass@127.0.0.1:47831')).toThrow(/token field/);
    expect(() => normalizeUrl('not a url')).toThrow(/full http/i);
  });

  it('keeps private LAN detection strict', () => {
    expect(isPrivateAddress('192.168.0.5')).toBe(true);
    expect(isPrivateAddress('::ffff:10.1.2.3')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('172.32.0.1')).toBe(false);
  });

  it('compares tokens in constant time without leaking length', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abc-longer')).toBe(false);
  });
});
