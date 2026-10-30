import { createDraftTracker } from '../draftTracker';
import type { Hint } from '../hintScheduler';

const A: Hint = { title: 'A', detail: '' };
const B: Hint = { title: 'B', detail: '' };

test('hint visible at send -> sent_with_hint', () => {
  const t = createDraftTracker();
  t.shown(A);
  expect(t.send()).toBe('sent_with_hint');
});
test('shown then cleared by editing -> sent_after_fix', () => {
  const t = createDraftTracker();
  t.shown(A);
  t.cleared();
  expect(t.send()).toBe('sent_after_fix');
});
test('never shown -> null', () => expect(createDraftTracker().send()).toBeNull());
test('dismissed then send -> sent_with_hint', () => {
  const t = createDraftTracker();
  t.shown(A);
  t.dismissed();
  expect(t.send()).toBe('sent_with_hint');
});
test('same title twice -> shown() true once', () => {
  const t = createDraftTracker();
  expect(t.shown(A)).toBe(true);
  expect(t.shown(A)).toBe(false);
  expect(t.shown(B)).toBe(true);
});
test('dismissed title is suppressed until the next send', () => {
  const t = createDraftTracker();
  t.shown(A);
  t.dismissed();
  expect(t.suppressed(A)).toBe(true);
  expect(t.suppressed(B)).toBe(false);
  t.send();
  expect(t.suppressed(A)).toBe(false);
});
test('state is cleared after send', () => {
  const t = createDraftTracker();
  t.shown(A);
  t.send();
  expect(t.send()).toBeNull();
});
