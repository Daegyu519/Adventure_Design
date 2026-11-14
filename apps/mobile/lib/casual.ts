import AsyncStorage from '@react-native-async-storage/async-storage';

// "편한 사이" 표시(P-46). 보내는 사람이 방마다 자기 기기에서 켠다(웹은 localStorage). 서버에는 저장하지 않고, 보낼 때 확인 요청에만 실어 보낸다.
// 어떻게 읽히는지는 받는 사람의 것이라, 이 표시는 알림을 끄지 않고 가벼운 거친 말의 알림을 한 단계 낮추기만 한다(엔진 layers/level.py).
const key = (roomId: string) => `casual:${roomId}`;

export const CASUAL_NOTE = '상대는 다르게 느낄 수도 있어요. 이 방에서는 가벼운 거친 말 알림을 줄일게요. 방 정보에서 되돌릴 수 있어요.';

export async function loadCasual(roomId: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(key(roomId))) === '1';
  } catch {
    return false; // 저장소를 못 읽으면 표시하지 않은 것으로(알림이 줄지 않는 쪽)
  }
}

export async function saveCasual(roomId: string, on: boolean): Promise<void> {
  try {
    if (on) await AsyncStorage.setItem(key(roomId), '1');
    else await AsyncStorage.removeItem(key(roomId));
  } catch {
    // 저장이 막혀도 이번 화면에서는 그대로 쓴다
  }
}
