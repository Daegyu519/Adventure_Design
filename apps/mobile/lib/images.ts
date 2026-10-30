import { launchImageLibraryAsync } from 'expo-image-picker';
import { useEffect, useState } from 'react';

import { supabase } from './supabase';

export const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

// 메시지 image_path와 Storage 정책이 같은 모양을 요구한다: <room_id>/<파일 이름> 한 단계.
export function imagePath(roomId: string, mime: string, rand: string): string | null {
  const ext = Object.prototype.hasOwnProperty.call(IMAGE_TYPES, mime) ? IMAGE_TYPES[mime] : null;
  return ext && /^[A-Za-z0-9_-]+$/.test(rand) ? `${roomId}/${rand}.${ext}` : null;
}

const SIGN_SECONDS = 3600;
const cache = new Map<string, { url: string; until: number }>(); // 만료 5분 전까지 같은 주소를 쓴다(스크롤로 다시 그려도 다시 받지 않게)

export async function pickAndSendImage(roomId: string, send: (m: { text: string; image_path: string }) => Promise<unknown>): Promise<'sent' | 'cancelled' | 'unsupported' | 'failed'> {
  if (!supabase) return 'failed';
  const picked = await launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7 });
  const asset = picked.canceled ? null : picked.assets?.[0];
  if (!asset) return 'cancelled';
  const mime = asset.mimeType ?? '';
  const path = imagePath(roomId, mime, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  if (!path) return 'unsupported';
  try {
    const body = await (await fetch(asset.uri)).arrayBuffer();
    const { error } = await supabase.storage.from('chat-images').upload(path, body, { contentType: mime, upsert: false });
    if (error) return 'failed';
    await send({ text: '', image_path: path }); // 올리기에 성공해야 메시지를 보낸다. 엔진은 부르지 않는다(규칙 11·12)
    return 'sent';
  } catch {
    return 'failed';
  }
}

export function useSignedUrl(path: string | null): string | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!path || !supabase) return;
    const hit = cache.get(path);
    if (hit && hit.until > Date.now()) return;
    let alive = true;
    void Promise.resolve(supabase.storage.from('chat-images').createSignedUrl(path, SIGN_SECONDS)).then(
      ({ data }) => {
        if (!data) return;
        cache.set(path, { url: data.signedUrl, until: Date.now() + (SIGN_SECONDS - 300) * 1000 });
        if (alive) tick((n) => n + 1);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [path]);
  const hit = path ? cache.get(path) : undefined;
  return hit && hit.until > Date.now() ? hit.url : null;
}
