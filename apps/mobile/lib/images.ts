import { launchImageLibraryAsync } from 'expo-image-picker';
import { useEffect, useState } from 'react';

import { supabase } from './supabase';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Storage 버킷 한도와 같다
export const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }; // gif는 자동 재생(WCAG 2.2.2) 때문에 뺐다;

// 메시지 image_path와 Storage 정책이 같은 모양을 요구한다: <room_id>/<파일 이름> 한 단계.
export function imagePath(roomId: string, mime: string, rand: string): string | null {
  const ext = Object.prototype.hasOwnProperty.call(IMAGE_TYPES, mime) ? IMAGE_TYPES[mime] : null;
  return ext && /^[A-Za-z0-9_-]+$/.test(rand) ? `${roomId}/${rand}.${ext}` : null;
}

const SIGN_SECONDS = 3600;
const REFRESH_MS = (SIGN_SECONDS - 300) * 1000; // 만료 5분 전에 다시 받는다
const EARLY_MS = 60_000; // 주소가 안 쓰이게 되기 60초 전에 다시 받아, 그림이 자리 상자로 깜빡이지 않게 한다
const MAX_CACHE = 100;
const cache = new Map<string, { url: string; until: number }>();

// 로그아웃 때 부른다: 서명 주소는 그 자체로 열람 권한이다.
export const clearSignedUrls = () => cache.clear();

export async function pickAndSendImage(roomId: string, send: (m: { text: string; image_path: string }) => Promise<unknown>, onStart?: () => void): Promise<'sent' | 'cancelled' | 'unsupported' | 'toolarge' | 'failed'> {
  if (!supabase) return 'failed';
  const picked = await launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7 });
  const asset = picked.canceled ? null : picked.assets?.[0];
  if (!asset) return 'cancelled';
  const mime = asset.mimeType ?? '';
  const path = imagePath(roomId, mime, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  if (!path) return 'unsupported';
  if ((asset.fileSize ?? 0) > MAX_IMAGE_BYTES) return 'toolarge';
  onStart?.(); // 사진을 골랐다: 이제부터 올린다
  try {
    const body = await (await fetch(asset.uri)).arrayBuffer();
    if (body.byteLength > MAX_IMAGE_BYTES) return 'toolarge';
    const { error } = await supabase.storage.from('chat-images').upload(path, body, { contentType: mime, upsert: false });
    if (error) return 'failed';
    await send({ text: '', image_path: path }); // 올리기에 성공해야 메시지를 보낸다. 엔진은 부르지 않는다(규칙 11·12)
    return 'sent';
  } catch {
    return 'failed';
  }
}

export function useSignedUrl(path: string | null): { url: string | null; failed: boolean; retry(): void } {
  const [, tick] = useState(0);
  const [failedPath, setFailedPath] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!path || !supabase) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (until: number) => {
      timer = setTimeout(sign, Math.max(0, until - EARLY_MS - Date.now()));
    };
    const sign = () => {
      void Promise.resolve(supabase!.storage.from('chat-images').createSignedUrl(path, SIGN_SECONDS)).then(
        ({ data }) => {
          if (!alive) return;
          if (!data) return setFailedPath(path);
          const until = Date.now() + REFRESH_MS;
          if (!cache.has(path) && cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
          cache.set(path, { url: data.signedUrl, until });
          setFailedPath(null);
          tick((n) => n + 1);
          arm(until); // 보이는 동안 만료되기 전에 다시 받는다
        },
        () => alive && setFailedPath(path),
      );
    };
    const hit = cache.get(path);
    if (hit && hit.until > Date.now()) arm(hit.until);
    else sign();
    return () => {
      alive = false;
      clearTimeout(timer);
      setFailedPath(null); // 다른 사진으로 바뀌면 이전 실패를 끌고 가지 않는다
    };
  }, [path, tries]);
  const hit = path ? cache.get(path) : undefined;
  const url = hit && hit.until > Date.now() ? hit.url : null;
  return { url, failed: !!path && !url && failedPath === path, retry: () => (setFailedPath(null), setTries((n) => n + 1)) };
}
