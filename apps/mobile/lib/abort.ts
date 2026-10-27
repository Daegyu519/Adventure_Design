// 호출자가 끊었을 때의 오류. 엔진 클라이언트와 mock이 같이 쓴다(서로 import하면 순환이 생긴다).
export const abortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });
