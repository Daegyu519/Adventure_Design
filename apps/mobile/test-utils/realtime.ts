// 테스트용 Realtime 가짜. realtime-js 2.118(node_modules/@supabase/realtime-js/dist/main)처럼 움직인다:
// - RealtimeClient.channel(name): 같은 topic이 열려 있으면 새로 만들지 않고 그 채널 객체를 그대로 돌려준다.
// - RealtimeChannel.on('postgres_changes' | 'presence'): subscribe() 뒤에 부르면 던진다.
// - removeChannel: 그 하나뿐인 채널을 닫는다 — subscribe 콜백에 CLOSED가 가고 목록에서 빠진다.
// 쓰는 쪽: jest.mock('<supabase>', () => ({ supabase: { ...jest.requireActual('<여기>').realtime, from: ... } }))
type Status = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED';
type Binding = { type: string; filter: { event?: string }; cb: (p: never) => void };
export type FakeChannel = {
  topic: string;
  params: unknown;
  joined: boolean;
  bindings: Binding[];
  onStatus?: (s: Status) => void;
  on(type: string, filter: { event?: string }, cb: (p: never) => void): FakeChannel;
  subscribe(cb?: (s: Status) => void): FakeChannel;
  track(p: unknown): Promise<'ok'>;
  presenceState(): Record<string, unknown>;
};

export const rt = {
  open: [] as FakeChannel[],
  removed: [] as FakeChannel[],
  tracked: [] as unknown[],
  presence: {} as Record<string, unknown>,
  reset() {
    rt.open = [];
    rt.removed = [];
    rt.tracked = [];
    rt.presence = {};
  },
  /** 이름이 name이거나 name:로 시작하는 열린 채널(구독마다 이름 끝에 번호가 붙을 수 있다). */
  find(name: string) {
    return rt.open.filter((c) => c.topic === `realtime:${name}` || c.topic.startsWith(`realtime:${name}:`));
  },
  one(name: string) {
    const xs = rt.find(name);
    if (xs.length !== 1) throw new Error(`expected one open channel ${name}, got ${xs.length}`);
    return xs[0];
  },
  /** 서버 쪽 상태. CLOSED는 서버가 닫은 것: realtime-js는 목록에서 빼고 다시 들어가지 않는다(오류·시간 초과는 스스로 다시 들어간다). */
  status(name: string, s: Status) {
    const ch = rt.one(name);
    ch.joined = s === 'SUBSCRIBED';
    if (s === 'CLOSED') rt.open = rt.open.filter((c) => c !== ch);
    ch.onStatus?.(s);
  },
  /** postgres_changes(이벤트가 맞는 것) 또는 presence 콜백을 부른다. */
  emit(name: string, payload: { eventType?: string } & Record<string, unknown>, type = 'postgres_changes') {
    for (const b of rt.one(name).bindings) if (b.type === type && (type !== 'postgres_changes' || !b.filter.event || b.filter.event === '*' || b.filter.event === payload.eventType)) (b.cb as (p: unknown) => void)(payload);
  },
};

export const realtime = {
  channel(name: string, params: unknown = { config: {} }): FakeChannel {
    const topic = `realtime:${name}`;
    const exists = rt.open.find((c) => c.topic === topic);
    if (exists) return exists;
    const ch: FakeChannel = {
      topic,
      params,
      joined: false,
      bindings: [],
      on(type, filter, cb) {
        if (ch.joined && (type === 'postgres_changes' || type === 'presence')) throw new Error(`cannot add \`${type}\` callbacks for ${topic} after \`subscribe()\`.`);
        ch.bindings.push({ type, filter, cb });
        return ch;
      },
      subscribe(cb) {
        ch.joined = true; // 들어가는 중(joining)도 on()을 막는다
        ch.onStatus = cb;
        return ch;
      },
      track: async (p) => (rt.tracked.push(p), 'ok'),
      presenceState: () => rt.presence,
    };
    rt.open.push(ch);
    return ch;
  },
  async removeChannel(ch: FakeChannel) {
    rt.open = rt.open.filter((c) => c !== ch);
    rt.removed.push(ch);
    ch.joined = false;
    ch.onStatus?.('CLOSED');
    return 'ok' as const;
  },
};
