import { launchImageLibraryAsync } from 'expo-image-picker';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { supabase } from './supabase';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Storage 버킷 한도와 같다
export const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }; // gif는 자동 재생(WCAG 2.2.2) 때문에 뺐다;

// 메시지 image_path와 Storage 정책이 같은 모양을 요구한다: <room_id>/<파일 이름> 한 단계.
export function imagePath(roomId: string, mime: string, rand: string): string | null {
  const ext = Object.prototype.hasOwnProperty.call(IMAGE_TYPES, mime) ? IMAGE_TYPES[mime] : null;
  return ext && /^[A-Za-z0-9_-]+$/.test(rand) ? `${roomId}/${rand}.${ext}` : null;
}

const MAX_SIDE = 2048;

// 웹: expo-image-picker는 quality를 무시하고 원본을 준다. 캔버스로 긴 변 2048 이하 JPEG로 줄여 올린다(HEIC·큰 사진도 통과, EXIF·위치 제거). 풀 수 없으면 null.
function webJpeg(uri: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const nw = img.naturalWidth;
          const nh = img.naturalHeight;
          if (!nw || !nh) return resolve(null);
          const k = Math.min(1, MAX_SIDE / Math.max(nw, nh)); // 키우지 않는다
          const w = Math.max(1, Math.round(nw * k));
          const h = Math.max(1, Math.round(nh * k));
          const cv = document.createElement('canvas');
          cv.width = w;
          cv.height = h;
          const ctx = cv.getContext('2d');
          if (!ctx) return resolve(null);
          ctx.fillStyle = 'white'; // 투명 PNG가 검게 나오지 않게
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          cv.toBlob((b) => resolve(b), 'image/jpeg', 0.82);
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = uri;
    } catch {
      resolve(null);
    }
  });
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
  let started = false;
  const start = () => {
    if (!started) (started = true), onStart?.(); // 사진을 골랐다: 이제부터 올린다
  };
  let mime = asset.mimeType ?? '';
  let blob: Blob | null = null;
  if (Platform.OS === 'web') {
    start(); // 줄이는 동안에도 버튼은 바쁨
    blob = await webJpeg(asset.uri);
    if (blob) mime = 'image/jpeg';
  }
  const path = imagePath(roomId, mime, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  if (!path) return 'unsupported';
  if ((blob?.size ?? asset.fileSize ?? 0) > MAX_IMAGE_BYTES) return 'toolarge';
  start();
  try {
    const body = blob ?? (await (await fetch(asset.uri)).arrayBuffer());
    if ((blob ? blob.size : (body as ArrayBuffer).byteLength) > MAX_IMAGE_BYTES) return 'toolarge';
    const { error } = await supabase.storage.from('chat-images').upload(path, body, { contentType: mime, upsert: false });
    if (error) return 'failed';
    await send({ text: '', image_path: path }); // 올리기에 성공해야 메시지를 보낸다. 엔진은 부르지 않는다(규칙 11·12)
    return 'sent';
  } catch {
    return 'failed';
  }
}

type Bucket = 'chat-images' | 'chat-files';

// download를 주면 첨부 파일로 내려받게 서명한다(파일 안의 활성 내용이 앱 출처에서 열리지 않게).
export function useSignedUrl(path: string | null, opts: { bucket?: Bucket; download?: string } = {}): { url: string | null; failed: boolean; retry(): void } {
  const bucket = opts.bucket ?? 'chat-images';
  const download = opts.download;
  const key = path ? `${bucket}/${download ?? ''}/${path}` : null;
  const [, tick] = useState(0);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!path || !key || !supabase) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (until: number) => {
      timer = setTimeout(sign, Math.max(0, until - EARLY_MS - Date.now()));
    };
    const sign = () => {
      const store = supabase!.storage.from(bucket);
      void Promise.resolve(download ? store.createSignedUrl(path, SIGN_SECONDS, { download }) : store.createSignedUrl(path, SIGN_SECONDS)).then(
        ({ data }) => {
          if (!alive) return;
          if (!data) return setFailedKey(key);
          const until = Date.now() + REFRESH_MS;
          if (!cache.has(key) && cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
          cache.set(key, { url: data.signedUrl, until });
          setFailedKey(null);
          tick((n) => n + 1);
          arm(until); // 보이는 동안 만료되기 전에 다시 받는다
        },
        () => alive && setFailedKey(key),
      );
    };
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) arm(hit.until);
    else sign();
    return () => {
      alive = false;
      clearTimeout(timer);
      setFailedKey(null); // 다른 사진으로 바뀌면 이전 실패를 끌고 가지 않는다
    };
  }, [path, key, bucket, download, tries]);
  const hit = key ? cache.get(key) : undefined;
  const url = hit && hit.until > Date.now() ? hit.url : null;
  return { url, failed: !!key && !url && failedKey === key, retry: () => (setFailedKey(null), setTries((n) => n + 1)) };
}
