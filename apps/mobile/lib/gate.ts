// 앱이 어느 화면 묶음을 보여 줄지 정하는 순수 함수. _layout이 결과대로 Stack.Protected를 연다.
export type GateState = {
  consented: boolean | null; // null = 아직 저장소를 못 읽음
  backend: boolean; // Supabase 키가 있는가. 없으면 로그인 없이 앱(키 없이 화면 작업용)
  session: 'loading' | 'none' | 'in';
  profile: 'loading' | 'missing' | 'ok';
};
export type Gate = 'loading' | 'consent' | 'login' | 'profile' | 'app';

// 'loading'일 때 _layout은 아무것도 그리지 않는다. 로그인한 사람에게 로그인 화면이 번쩍이지 않게 하려는 것이다.
export function gate(s: GateState): Gate {
  if (s.consented === null) return 'loading';
  if (!s.consented) return 'consent';
  if (!s.backend) return 'app';
  if (s.session === 'loading') return 'loading';
  if (s.session === 'none') return 'login';
  if (s.profile === 'loading') return 'loading';
  return s.profile === 'missing' ? 'profile' : 'app';
}
