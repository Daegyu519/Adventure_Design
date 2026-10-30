import { urlBase64ToUint8Array } from '../vapid';

test('decodes base64url', () => expect(Array.from(urlBase64ToUint8Array('AQID'))).toEqual([1, 2, 3]));
test('handles - _ and missing padding', () => expect(Array.from(urlBase64ToUint8Array('-_8'))).toEqual([251, 255]));
test('returns Uint8Array', () => expect(urlBase64ToUint8Array('AQID')).toBeInstanceOf(Uint8Array));
