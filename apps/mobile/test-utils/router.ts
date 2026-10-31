// 테스트용 expo-router 스택 가짜. expo-router 58의 StackRouter(build/react-navigation/routers/StackRouter.js)처럼:
// - push: 새 화면을 쌓는다. 같은 id의 singular 화면이 있으면 그것을 맨 위로 옮긴다(새로 만들지 않는다).
// - navigate: singular 화면이면 push와 같고, 맨 위와 같은 화면이면 params만 바꾸고, 아니면 쌓는다.
// - dismissTo(POP_TO): 그 화면 위를 모두 걷고 params를 바꾼다. 없으면 맨 위를 그것으로 바꾼다.
// '/room/[id]'는 app/_layout.tsx의 dangerouslySingular처럼 id마다 하나다.
type Params = Record<string, string>;
export type Route = { name: string; params: Params };
type Href = string | { pathname: string; params?: Params };

const toRoute = (h: Href): Route => (typeof h === 'string' ? { name: h, params: {} } : { name: h.pathname, params: { ...h.params } });
const singular = (a: Route, b: Route) => a.name === '/room/[id]' && b.name === a.name && a.params.id === b.params.id;

export function fakeStack(initial: Route[]) {
  const stack = initial.map((r) => ({ ...r, params: { ...r.params } }));
  const at = (r: Route) => stack.findIndex((x) => singular(x, r));
  return {
    stack,
    push: jest.fn((h: Href) => {
      const r = toRoute(h);
      const i = at(r);
      if (i >= 0) stack.splice(i, 1);
      stack.push(r);
    }),
    navigate: jest.fn((h: Href) => {
      const r = toRoute(h);
      const i = at(r);
      if (i >= 0) stack.splice(i, 1);
      else if (stack.at(-1)?.name === r.name) stack.pop();
      stack.push(r);
    }),
    dismissTo: jest.fn((h: Href) => {
      const r = toRoute(h);
      let i = at(r);
      if (i < 0) i = stack.map((x) => x.name).lastIndexOf(r.name);
      stack.splice(i < 0 ? stack.length - 1 : i);
      stack.push(r);
    }),
    replace: jest.fn((h: Href) => void stack.splice(stack.length - 1, 1, toRoute(h))),
    back: jest.fn(() => void stack.pop()),
    canGoBack: () => stack.length > 1,
  };
}
