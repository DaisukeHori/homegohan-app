/**
 * 受け手のページ (src/lib/ai/consultation-refetch-coverage.ts の AI_CONSULTATION_REFETCH_PAGES の receiver) を描画して、
 * AI 相談の成功の取り直しを確かめるための記録と判定 (#2195 V1)。
 *
 *   - expectRefetchReadsCoverMount: 開いたとき (とユーザーの操作で開いたパネル) に読んだもの全部を、取り直しも読む
 *     (表の mountReadsNotRefetched に理由つきで載せたものを除く)
 *   - expectEmptyRefetchMatchesFreshMount: 中身のある応答で開いたあと、空の応答で取り直した画面が、空の応答で開いた画面と同じ
 *     (取り直しが `if (x.length > 0) set(...)` や `if (x) set(...)` で前の値を残していない)
 *
 * 読み取りの鍵: GET の fetch は 'GET <道>?<並べ替えた問い合わせ>' (同じ起点の '/api/' だけ)、Supabase は 'from:<表>' / 'rpc:<名前>'。
 * tests/ai-consultation-refetch-coverage-2195.test.ts が、受け手ごとに 2 つの判定を呼ぶテストがあることを数える。
 */
import { expect } from 'vitest';
import { AI_CONSULTATION_REFETCH_PAGES } from '@/lib/ai/consultation-refetch-coverage';

/** ページの API の相対 URL を解く起点 */
export const READ_KEY_ORIGIN = 'http://localhost';
const API_PREFIX = '/api/';
const READ_METHOD = 'GET';

/** fetch の呼び出しの読み取りの鍵 (GET でない・外の起点・'/api/' でないものは null) */
export function fetchReadKey(input: unknown, init?: { method?: string }): string | null {
  const method = (init?.method ?? READ_METHOD).toUpperCase();
  if (method !== READ_METHOD) return null;
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String((input as { url?: string })?.url ?? input);
  const url = new URL(raw, READ_KEY_ORIGIN);
  if (url.origin !== READ_KEY_ORIGIN || !url.pathname.startsWith(API_PREFIX)) return null;
  const params = [...url.searchParams.entries()].sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = new URLSearchParams(params).toString();
  return `${READ_METHOD} ${url.pathname}${query === '' ? '' : `?${query}`}`;
}

export const tableReadKey = (table: string): string => `from:${table}`;
export const rpcReadKey = (name: string): string => `rpc:${name}`;

/** 読み取りの鍵を溜める。take() で今までの分を返して空にする */
export class ReadRecorder {
  private keys = new Set<string>();

  record(key: string | null): void {
    if (key !== null) this.keys.add(key);
  }

  take(): Set<string> {
    const out = this.keys;
    this.keys = new Set();
    return out;
  }
}

/**
 * 開いたとき (とパネル) に読んだもの全部を、取り直しも読む。
 * 表の mountReadsNotRefetched に載せた除外 (名前 → 理由) は、テストが名前ごとに今の読み取りの鍵を渡す (excludedKeys。
 * 日付の入った鍵などを表に固定で書けないため)。表とテストで名前が食い違えば赤
 */
export function expectRefetchReadsCoverMount(
  page: string,
  mountReads: ReadonlySet<string>,
  refetchReads: ReadonlySet<string>,
  excludedKeys: Readonly<Record<string, readonly string[]>> = {},
): void {
  const entry = AI_CONSULTATION_REFETCH_PAGES[page];
  expect(entry?.kind, `${page} は AI_CONSULTATION_REFETCH_PAGES の受け手`).toBe('receiver');
  const declared = entry?.kind === 'receiver' ? Object.keys(entry.mountReadsNotRefetched ?? {}).sort() : [];
  expect(Object.keys(excludedKeys).sort(), `${page} の mountReadsNotRefetched の名前とテストが渡す除外の名前`).toEqual(declared);
  const allowed = new Set(Object.values(excludedKeys).flat());
  expect(mountReads.size, `${page} を開いたときに何も読んでいない (検査が空振りしている)`).toBeGreaterThan(0);
  const missing = [...mountReads].filter((key) => !refetchReads.has(key) && !allowed.has(key)).sort();
  expect(missing, `${page} の取り直しが読まないもの`).toEqual([]);
  // 除外が今も当たっている (開いたときに読み、取り直しで読まない) こと。古い除外を残さない
  const stale = [...allowed].filter((key) => !mountReads.has(key) || refetchReads.has(key)).sort();
  expect(stale, `${page} の除外の古い鍵`).toEqual([]);
}

/**
 * 画面の見えるものの印: 文字 (要素の境目で区切る) と、入力の部品の値・選択の状態。
 * 取り直しと読み込み直しで同じものが出ているかを比べる (アニメーションの style などは比べない)
 */
export function screenSignature(root: Element): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === node.TEXT_NODE) {
      const text = (node.textContent ?? '').trim();
      if (text !== '') parts.push(text);
      return;
    }
    if (node instanceof HTMLInputElement) {
      parts.push(`[input ${node.type}=${node.type === 'checkbox' || node.type === 'radio' ? String(node.checked) : node.value}]`);
    } else if (node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) {
      parts.push(`[${node.tagName.toLowerCase()}=${node.value}]`);
    }
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  walk(root);
  return parts.join('|');
}

export interface EmptyRefetchScreens {
  /** 中身のある応答で開いた画面 */
  full: string;
  /** そのあと空の応答で取り直した画面 */
  refetchedToEmpty: string;
  /** 空の応答で開いた (読み込み直した) 画面 */
  freshEmpty: string;
}

/** 空の応答で取り直した画面は、空の応答で開いた画面と同じ (前の値を残さない) */
export function expectEmptyRefetchMatchesFreshMount(page: string, screens: EmptyRefetchScreens): void {
  expect(AI_CONSULTATION_REFETCH_PAGES[page]?.kind, `${page} は AI_CONSULTATION_REFETCH_PAGES の受け手`).toBe('receiver');
  // 中身のある応答で何かが出ていないと、前の値を残すかを確かめられない
  expect(screens.full, `${page} の中身のある応答が、空の応答と同じ画面になっている (検査が空振りしている)`).not.toBe(screens.freshEmpty);
  expect(screens.refetchedToEmpty, `${page} の空の応答の取り直しが、読み込み直しと違う`).toBe(screens.freshEmpty);
}
