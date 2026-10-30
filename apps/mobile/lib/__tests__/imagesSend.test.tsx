import { act } from 'react';
import { createRoot } from 'test-renderer';

import { pickAndSendImage, useSignedUrl } from '../images';

let mockPick: unknown;
let mockUpload: jest.Mock;
let mockSign: jest.Mock;
jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: (o: unknown) => (mockLaunch(o), Promise.resolve(mockPick)) }));
const mockLaunch = jest.fn();
jest.mock('../supabase', () => ({
  supabase: { storage: { from: (b: string) => ({ upload: (...a: unknown[]) => mockUpload(b, ...a), createSignedUrl: (...a: unknown[]) => mockSign(b, ...a) }) } },
}));

const asset = (mimeType?: string) => ({ canceled: false, assets: [{ uri: 'file:///x', mimeType }] });
beforeEach(() => {
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

let url: string | null = '';
function Probe({ path }: { path: string | null }) {
  url = useSignedUrl(path);
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

test('useSignedUrl: null path or failure gives null', async () => {
  mockSign.mockResolvedValue({ data: null, error: { message: 'x' } });
  const root = createRoot();
  await act(async () => root.render(<Probe path={null} />));
  expect(url).toBeNull();
  await act(async () => root.render(<Probe path="r1/zz.jpg" />));
  expect(url).toBeNull();
});
