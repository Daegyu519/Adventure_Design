import { cleanFileName, filePath, formatSize, MAX_FILE_BYTES, pickAndSendFile, uploadMime } from '../files';

let mockPick: unknown;
let mockUpload: jest.Mock;
jest.mock('expo-document-picker', () => ({ getDocumentAsync: (o: unknown) => (mockLaunch(o), Promise.resolve(mockPick)) }));
const mockLaunch = jest.fn();
jest.mock('../supabase', () => ({ supabase: { storage: { from: (b: string) => ({ upload: (...a: unknown[]) => mockUpload(b, ...a) }) } } }));

const doc = (name: string, mimeType?: string, size = 10) => ({ canceled: false, assets: [{ uri: 'file:///x', name, mimeType, size }] });
beforeEach(() => {
  mockUpload = jest.fn().mockResolvedValue({ error: null });
  mockLaunch.mockClear();
  global.fetch = jest.fn().mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(4) }) as never;
});

test('cancel sends nothing; picker options', async () => {
  mockPick = { canceled: true, assets: null };
  const send = jest.fn();
  expect(await pickAndSendFile('r1', send)).toBe('cancelled');
  expect(send).not.toHaveBeenCalled();
  expect(mockLaunch).toHaveBeenCalledWith({ copyToCacheDirectory: true, multiple: false });
});

test('over 20 MB: toolarge, nothing uploaded or sent', async () => {
  mockPick = doc('a.pdf', 'application/pdf', MAX_FILE_BYTES + 1);
  const send = jest.fn();
  expect(await pickAndSendFile('r1', send)).toBe('toolarge');
  expect(mockUpload).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test('uploads to chat-files with upsert:false, then sends file fields (upload first)', async () => {
  mockPick = doc('보고서 최종.PDF', 'application/pdf');
  const order: string[] = [];
  mockUpload.mockImplementation(async () => (order.push('upload'), { error: null }));
  const send = jest.fn().mockImplementation(async () => order.push('send'));
  const onStart = jest.fn();
  expect(await pickAndSendFile('r1', send, onStart)).toBe('sent');
  const [bucket, path, , o] = mockUpload.mock.calls[0];
  expect(bucket).toBe('chat-files');
  expect(path).toMatch(/^r1\/\d+-[a-z0-9]+\.pdf$/);
  expect(o).toEqual({ contentType: 'application/pdf', upsert: false });
  expect(send).toHaveBeenCalledWith({ text: '', file_path: path, file_name: '보고서 최종.PDF', file_size: 4 });
  expect(order).toEqual(['upload', 'send']);
  expect(onStart).toHaveBeenCalledTimes(1);
});

test('upload failure: nothing is sent', async () => {
  mockPick = doc('a.pdf', 'application/pdf');
  mockUpload.mockResolvedValue({ error: { message: 'x' } });
  const send = jest.fn();
  expect(await pickAndSendFile('r1', send)).toBe('failed');
  expect(send).not.toHaveBeenCalled();
});

test('text/html and other types upload as octet-stream', async () => {
  mockPick = doc('x.html', 'text/html');
  await pickAndSendFile('r1', jest.fn().mockResolvedValue({}));
  expect(mockUpload.mock.calls[0][3].contentType).toBe('application/octet-stream');
  expect(uploadMime('image/svg+xml')).toBe('application/octet-stream');
  expect(uploadMime('')).toBe('application/octet-stream');
  expect(uploadMime(undefined)).toBe('application/octet-stream');
  expect(uploadMime('video/mp4')).toBe('video/mp4');
});

test('path extension only when [A-Za-z0-9]{1,8}, lowercased; never from the name otherwise', () => {
  expect(filePath('r', 'a.b.TXT', 'k')).toBe('r/k.txt');
  expect(filePath('r', 'noext', 'k')).toBe('r/k');
  expect(filePath('r', 'a.toolongext1', 'k')).toBe('r/k');
  expect(filePath('r', 'a.p/../df', 'k')).toBe('r/k');
  expect(filePath('r', 'a.한글', 'k')).toBe('r/k');
});

test('file name: control chars removed, trimmed, 200 max, fallback', () => {
  expect(cleanFileName('  a\u0007b\nc.pdf ')).toBe('abc.pdf');
  expect(cleanFileName('x'.repeat(300))).toHaveLength(200);
  expect(cleanFileName('\n\t ')).toBe('파일');
  expect(cleanFileName(undefined)).toBe('파일');
});

test('formatSize', () => {
  expect(formatSize(340 * 1024)).toBe('340KB');
  expect(formatSize(1.2 * 1024 * 1024)).toBe('1.2MB');
  expect(formatSize(10)).toBe('1KB');
});
