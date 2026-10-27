// 앱이 어느 화면 묶음을 보여 줄지 정하는 순수 함수. Task 4(로그인)가 GateState·Gate를 넓힌다.
export type GateState = { consented: boolean | null }; // null = 아직 저장소를 못 읽음
export type Gate = 'loading' | 'consent' | 'app';

export function gate(s: GateState): Gate {
  if (s.consented === null) return 'loading';
  return s.consented ? 'app' : 'consent';
}
