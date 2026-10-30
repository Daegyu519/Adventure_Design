// VAPID 공개키(base64url) → pushManager.subscribe의 applicationServerKey.
export function urlBase64ToUint8Array(s: string): Uint8Array {
  const b64 = (s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
