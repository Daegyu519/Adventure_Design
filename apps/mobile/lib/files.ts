import * as DocumentPicker from 'expo-document-picker';

import { supabase } from './supabase';

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // Storage 버킷 chat-files 한도와 같다
// 버킷 allowed_mime_types(20261102000002_platform_chat_files.sql)와 같은 목록. 이 밖의 형식(html·svg·xml·js·빈 형식…)은 octet-stream으로 올린다.
export const FILE_TYPES = [
  'application/pdf', 'text/plain', 'text/csv', 'application/zip', 'application/x-zip-compressed',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/x-hwp', 'application/haansofthwp', 'application/vnd.hancom.hwp', 'application/vnd.hancom.hwpx',
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/gif',
  'video/mp4', 'video/quicktime', 'audio/mpeg', 'audio/mp4',
];

export const uploadMime = (mime: string | undefined | null) => (mime && FILE_TYPES.includes(mime.toLowerCase()) ? mime.toLowerCase() : 'application/octet-stream');

// 표시 이름: 제어 문자 제거, 앞뒤 공백 제거, 200자까지(메시지 file_name 제약과 같다).
export const cleanFileName = (name: string | undefined | null) => (name ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 200) || '파일';

// 메시지 file_path·Storage 정책과 같은 모양: <room_id>/<시각-무작위>[.<확장자>]. 확장자는 영숫자 8자 이하일 때만.
export function filePath(roomId: string, name: string, rand: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return `${roomId}/${rand}${m ? `.${m[1].toLowerCase()}` : ''}`;
}

export type FileSend = (m: { text: string; file_path: string; file_name: string; file_size: number }) => Promise<unknown>;

export async function pickAndSendFile(roomId: string, send: FileSend, onStart?: () => void): Promise<'sent' | 'cancelled' | 'toolarge' | 'failed'> {
  if (!supabase) return 'failed';
  const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
  const asset = picked.canceled ? null : picked.assets?.[0];
  if (!asset) return 'cancelled';
  if ((asset.size ?? 0) > MAX_FILE_BYTES) return 'toolarge';
  onStart?.();
  try {
    const body = await (await fetch(asset.uri)).arrayBuffer();
    if (body.byteLength > MAX_FILE_BYTES) return 'toolarge';
    if (body.byteLength === 0) return 'failed'; // 빈 파일은 DB 제약(크기 1 이상)에도 걸린다
    const path = filePath(roomId, asset.name ?? '', `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    const { error } = await supabase.storage.from('chat-files').upload(path, body, { contentType: uploadMime(asset.mimeType), upsert: false });
    if (error) return 'failed';
    await send({ text: '', file_path: path, file_name: cleanFileName(asset.name), file_size: body.byteLength }); // 올리기에 성공해야 보낸다. 엔진은 부르지 않는다(규칙 11·12)
    return 'sent';
  } catch {
    return 'failed';
  }
}

export const formatSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
