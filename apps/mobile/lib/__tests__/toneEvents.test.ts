const mockInsert = jest.fn();
const mockSession = jest.fn();
jest.mock('../supabase', () => ({ supabase: { auth: { getSession: () => mockSession() }, from: (t: string) => ({ insert: (r: unknown) => mockInsert(t, r) }) } }));
import { logToneEvent } from '../toneEvents';

const flush = () => new Promise((r) => setTimeout(r, 0));
beforeEach(() => {
  mockInsert.mockReset().mockResolvedValue({ error: null });
  mockSession.mockReset().mockResolvedValue({ data: { session: { user: { id: 'me' } } } });
});

test('inserts with current user, signals as object', async () => {
  logToneEvent({ room_id: 'r', kind: 'hint_shown', signals: { trace_id: 't' } });
  await flush();
  expect(mockInsert).toHaveBeenCalledWith('tone_events', { room_id: 'r', kind: 'hint_shown', signals: { trace_id: 't' }, user_id: 'me' });
});
test('swallows insert failure and does nothing without a session', async () => {
  mockInsert.mockRejectedValue(new Error('x'));
  expect(() => logToneEvent({ room_id: 'r', kind: 'sent_with_hint' })).not.toThrow();
  await flush();
  mockInsert.mockClear();
  mockSession.mockResolvedValue({ data: { session: null } });
  logToneEvent({ room_id: 'r', kind: 'sent_with_hint' });
  await flush();
  expect(mockInsert).not.toHaveBeenCalled();
});
