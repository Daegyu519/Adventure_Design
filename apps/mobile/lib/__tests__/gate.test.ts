import { gate } from '../gate';

test('gate: unknown consent → loading', () => expect(gate({ consented: null })).toBe('loading'));
test('gate: not consented → consent', () => expect(gate({ consented: false })).toBe('consent'));
test('gate: consented → app', () => expect(gate({ consented: true })).toBe('app'));
