import type { Member } from './rooms';

type M = Pick<Member, 'user_id' | 'name'>;
const WS = /\s/;
const END = /[\s.,!?;:)\]}"'~…]/;

// i의 '@' 뒤에 오는 가장 긴 이름. '@' 앞은 줄 처음이나 공백, 이름 뒤는 끝이나 공백·문장부호일 때만.
function matchAt(text: string, i: number, names: string[]): string | null {
  if (text[i] !== '@' || (i > 0 && !WS.test(text[i - 1]))) return null;
  for (const n of [...names].sort((a, b) => b.length - a.length)) {
    const end = i + 1 + n.length;
    if (n && text.startsWith(n, i + 1) && (end === text.length || END.test(text[end]))) return n;
  }
  return null;
}

export function activeMentionQuery(text: string, cursor: number): string | null {
  const before = text.slice(0, cursor);
  const at = before.lastIndexOf('@');
  if (at < 0 || (at > 0 && !WS.test(before[at - 1]))) return null;
  const q = before.slice(at + 1);
  return WS.test(q) ? null : q;
}

export function insertMention(text: string, cursor: number, name: string): { text: string; cursor: number } {
  const before = text.slice(0, cursor);
  const at = before.lastIndexOf('@');
  const head = `${text.slice(0, at)}@${name} `;
  return { text: head + text.slice(cursor), cursor: head.length };
}

export function extractMentions(text: string, members: M[], me: string): string[] {
  const ids = new Set<string>();
  for (let i = 0; i < text.length; i++) {
    const n = matchAt(text, i, members.map((m) => m.name));
    if (!n) continue;
    const m = members.find((x) => x.name === n && x.user_id !== me);
    if (m) ids.add(m.user_id);
    i += n.length;
  }
  return [...ids];
}

export function splitMentions(text: string, names: string[]): { text: string; mention: boolean }[] {
  const out: { text: string; mention: boolean }[] = [];
  let from = 0;
  const plain = (to: number) => to > from && out.push({ text: text.slice(from, to), mention: false });
  for (let i = 0; i < text.length; i++) {
    const n = matchAt(text, i, names);
    if (!n) continue;
    plain(i);
    out.push({ text: text.slice(i, i + 1 + n.length), mention: true });
    i += n.length;
    from = i + 1;
  }
  plain(text.length);
  return out;
}
