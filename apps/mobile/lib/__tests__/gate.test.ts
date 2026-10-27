import { gate } from '../gate';

const S = { consented: true, backend: true, session: 'in', profile: 'ok' } as const;

test('consent comes before everything', () => expect(gate({ ...S, consented: false })).toBe('consent'));
test('consent unknown → loading (never flashes consent for someone who already agreed)', () =>
  expect(gate({ ...S, consented: null })).toBe('loading'));
test('no backend keys → app without login', () => expect(gate({ ...S, backend: false, session: 'none' })).toBe('app'));
test('no backend keys but not consented → still consent', () =>
  expect(gate({ ...S, backend: false, session: 'none', consented: false })).toBe('consent'));
test('session loading → loading', () => expect(gate({ ...S, session: 'loading' })).toBe('loading'));
test('signed out → login', () => expect(gate({ ...S, session: 'none' })).toBe('login'));
test('signed in, profile missing → profile', () => expect(gate({ ...S, profile: 'missing' })).toBe('profile'));
test('signed in, profile loading → loading', () => expect(gate({ ...S, profile: 'loading' })).toBe('loading'));
test('signed in with profile → app', () => expect(gate(S)).toBe('app'));
