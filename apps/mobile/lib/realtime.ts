// Realtime 채널 도우미. realtime-js 2.118은 같은 이름이면 열린(닫히는 중인 것도) 채널 객체를 그대로 돌려주고, subscribe 뒤 on()은 던진다.
// 같은 방 화면이 둘이거나(알림 탭·두 번 누름) 닫자마자 같은 이름으로 다시 구독하면 한쪽이 던지거나 조용히 멈춘다.
// postgres_changes 채널은 이름이 거르는 데 쓰이지 않으므로(필터는 입장 요청에 있다) 구독마다 새 이름을 쓴다.
// private 채널(typing:<방 id>)은 realtime.messages 정책이 이름을 보므로 예외다.
let n = 0;
export const freshTopic = (name: string) => `${name}:${++n}`;

// subscribe 콜백: SUBSCRIBED면 up, 끊김(CHANNEL_ERROR·TIMED_OUT·CLOSED)이면 개발 중 경고 + down.
// 오류·시간 초과는 realtime-js가 스스로 다시 들어가 SUBSCRIBED가 다시 오고, 서버가 닫은 CLOSED는 다시 구독해야 한다.
// 내가 removeChannel해서 오는 CLOSED는 부른 쪽이 alive로 거른다.
export function watchStatus(status: string, name: string, up: () => void, down: () => void): void {
  if (status === 'SUBSCRIBED') return up();
  if (__DEV__) console.warn(`[realtime] ${name}: ${status}`);
  down();
}
