import { act } from 'react';
import { createRoot } from 'test-renderer';

import { clearSignedUrls, MAX_IMAGE_BYTES, pickAndSendImage, useSignedUrl } from '../images';

let mockPick: unknown;
let mockUpload: jest.Mock;
let mockSign: jest.Mock;
jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: (o: unknown) => (mockLaunch(o), Promise.resolve(mockPick)) }));
const mockLaunch = jest.fn();
jest.mock('../supabase', () => ({
  supabase: { storage: { from: (b: string) => ({ upload: (...a: unknown[]) => mockUpload(b, ...a), createSignedUrl: (...a: unknown[]) => mockSign(b, ...a) }) } },
}));

const asset = (mimeType?: string, fileSize?: number) => ({ canceled: false, assets: [{ uri: 'file:///x', mimeType, fileSize }] });
beforeEach(() => {
  clearSignedUrls();
  mockUpload = jest.fn().mockResolvedValue({ error: null });
  mockSign = jest.fn();
  mockLaunch.mockClear();
  global.fetch = jest.fn().mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(4) }) as never;
});

test('cancelled picker sends nothing', async () => {
  mockPick = { canceled: true, assets: null };
  const send = jest.fn();
  expect(await pickAndSendImage('r1', send)).toBe('cancelled');
  expect(send).not.toHaveBeenCalled();
  expect(mockLaunch).toHaveBeenCalledWith({ mediaTypes: ['images'], quality: 0.7 });
});

test('unsupported type: no upload, no send', async () => {
  mockPick = asset('image/heic');
  const send = jest.fn();
  expect(await pickAndSendImage('r1', send)).toBe('unsupported');
  expect(mockUpload).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test('missing mime type counts as unsupported', async () => {
  mockPick = asset(undefined);
  expect(await pickAndSendImage('r1', jest.fn())).toBe('unsupported');
});

test('uploads under <room>/ with upsert:false, then sends text "" + image_path', async () => {
  mockPick = asset('image/png');
  const send = jest.fn().mockResolvedValue({});
  expect(await pickAndSendImage('r1', send)).toBe('sent');
  const [bucket, path, , o] = mockUpload.mock.calls[0];
  expect(bucket).toBe('chat-images');
  expect(path).toMatch(/^r1\/[A-Za-z0-9_-]+\.png$/);
  expect(o).toEqual({ contentType: 'image/png', upsert: false });
  expect(send).toHaveBeenCalledWith({ text: '', image_path: path });
});

test('onStart fires once a valid photo is chosen, not on cancel or unsupported', async () => {
  const onStart = jest.fn();
  mockPick = { canceled: true, assets: null };
  await pickAndSendImage('r1', jest.fn(), onStart);
  mockPick = asset('image/heic');
  await pickAndSendImage('r1', jest.fn(), onStart);
  expect(onStart).not.toHaveBeenCalled();
  mockPick = asset('image/png');
  await pickAndSendImage('r1', jest.fn().mockResolvedValue({}), onStart);
  expect(onStart).toHaveBeenCalledTimes(1);
});

test('upload failure: nothing is sent', async () => {
  mockPick = asset('image/jpeg');
  mockUpload.mockResolvedValue({ error: { message: 'x' } });
  const send = jest.fn();
  expect(await pickAndSendImage('r1', send)).toBe('failed');
  expect(send).not.toHaveBeenCalled();
});

test('send failure and fetch failure report failed', async () => {
  mockPick = asset('image/jpeg');
  expect(await pickAndSendImage('r1', jest.fn().mockRejectedValue(new Error('x')))).toBe('failed');
  (global.fetch as jest.Mock).mockRejectedValue(new Error('net'));
  expect(await pickAndSendImage('r1', jest.fn())).toBe('failed');
});

test('file over 5 MB: "toolarge", nothing uploaded', async () => {
  mockPick = asset('image/jpeg', MAX_IMAGE_BYTES + 1);
  const send = jest.fn();
  expect(await pickAndSendImage('r1', send)).toBe('toolarge');
  expect(mockUpload).not.toHaveBeenCalled();
});

let url: string | null = '';
let retry: () => void = () => {};
let failed = false;
function Probe({ path }: { path: string | null }) {
  const r = useSignedUrl(path);
  url = r.url;
  failed = r.failed;
  retry = r.retry;
  return null;
}
test('useSignedUrl signs for an hour once per path (module cache)', async () => {
  mockSign.mockResolvedValue({ data: { signedUrl: 'https://s/1' }, error: null });
  const root = createRoot();
  await act(async () => root.render(<Probe path="r1/a.jpg" />));
  expect(url).toBe('https://s/1');
  expect(mockSign).toHaveBeenCalledWith('chat-images', 'r1/a.jpg', 3600);
  await act(async () => root.render(<Probe path="r1/b.jpg" />));
  await act(async () => root.render(<Probe path="r1/a.jpg" />));
  expect(url).toBe('https://s/1');
  expect(mockSign.mock.calls.filter((c) => c[1] === 'r1/a.jpg')).toHaveLength(1);
});

test('useSignedUrl re-signs when the URL expires while mounted', async () => {
  jest.useFakeTimers();
  try {
    mockSign.mockResolvedValueOnce({ data: { signedUrl: 'https://s/1' }, error: null }).mockResolvedValueOnce({ data: { signedUrl: 'https://s/2' }, error: null });
    const root = createRoot();
    await act(async () => root.render(<Probe path="r1/e.jpg" />));
    expect(url).toBe('https://s/1');
    await act(async () => void jest.advanceTimersByTime(3300 * 1000 + 1000));
    expect(mockSign).toHaveBeenCalledTimes(2);
    expect(url).toBe('https://s/2');
  } finally {
    jest.useRealTimers();
  }
});

test('useSignedUrl re-signs 60 s before the URL stops being served (no placeholder flash)', async () => {
  jest.useFakeTimers();
  try {
    const seen: (string | null)[] = [];
    mockSign.mockResolvedValueOnce({ data: { signedUrl: 'https://s/1' }, error: null }).mockResolvedValueOnce({ data: { signedUrl: 'https://s/2' }, error: null });
    const root = createRoot();
    await act(async () => root.render(<Probe path="r1/g.jpg" />));
    await act(async () => void jest.advanceTimersByTime((3300 - 60) * 1000 + 500));
    seen.push(url);
    expect(mockSign).toHaveBeenCalledTimes(2);
    expect(seen[0]).toBe('https://s/2');
  } finally {
    jest.useRealTimers();
  }
});

test('useSignedUrl: a failure on one path is not shown for another path', async () => {
  mockSign.mockResolvedValueOnce({ data: null, error: { message: 'x' } }).mockResolvedValue({ data: { signedUrl: 'https://s/9' }, error: null });
  const root = createRoot();
  await act(async () => root.render(<Probe path="r1/h.jpg" />));
  expect(failed).toBe(true);
  await act(async () => root.render(<Probe path="r1/i.jpg" />));
  expect(failed).toBe(false);
  await act(async () => root.render(<Probe path="r1/h.jpg" />));
  expect(url).toBe('https://s/9');
  expect(failed).toBe(false);
});

test('useSignedUrl: failure sets failed (no url); retry signs again', async () => {
  mockSign.mockResolvedValueOnce({ data: null, error: { message: 'x' } }).mockResolvedValueOnce({ data: { signedUrl: 'https://s/3' }, error: null });
  const root = createRoot();
  await act(async () => root.render(<Probe path="r1/f.jpg" />));
  expect(url).toBeNull();
  expect(failed).toBe(true);
  await act(async () => retry());
  expect(failed).toBe(false);
  expect(url).toBe('https://s/3');
});

test('null path gives null, not failed', async () => {
  const root = createRoot();
  await act(async () => root.render(<Probe path={null} />));
  expect(url).toBeNull();
  expect(failed).toBe(false);
});

test('clearSignedUrls drops cached bearer URLs', async () => {
  mockSign.mockResolvedValue({ data: { signedUrl: 'https://s/1' }, error: null });
  const root = createRoot();
  await act(async () => root.render(<Probe path="r1/c.jpg" />));
  clearSignedUrls();
  await act(async () => root.render(<Probe path="r1/d.jpg" />));
  await act(async () => root.render(<Probe path="r1/c.jpg" />));
  expect(mockSign.mock.calls.filter((c) => c[1] === 'r1/c.jpg')).toHaveLength(2);
});
