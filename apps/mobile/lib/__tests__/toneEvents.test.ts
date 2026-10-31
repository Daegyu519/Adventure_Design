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

// supabase-js는 RLS·제약 위반을 던지지 않고 {error}로 돌려준다(S-I4). 조용히 사라지지 않게 개발 중에는 코드를 알린다.
test('a resolved {error} warns in dev with the error code only', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockInsert.mockResolvedValue({ error: { code: '42501', message: 'new row violates row-level security policy for table "tone_events"' } });
  logToneEvent({ room_id: 'r', kind: 'hint_shown' });
  await flush();
  expect(warn).toHaveBeenCalledWith('[toneEvents] insert failed 42501');
  warn.mockRestore();
});
