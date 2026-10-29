// 웹 Enter 처리. 한글 조합 중 Enter(isComposing 또는 keyCode 229)는 글자 확정이지 보내기가 아니다.
export function shouldSubmitOnKey(e: { key: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number }): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229;
}
