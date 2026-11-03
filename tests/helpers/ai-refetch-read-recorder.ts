/**
 * 受け手のページ (src/lib/ai/consultation-refetch-coverage.ts の AI_CONSULTATION_REFETCH_PAGES の receiver) を描画して、
 * AI 相談の成功の取り直しを確かめるための記録と判定 (#2195 V1)。
 *
 *   - expectRefetchReadsCoverMount: 開いたとき (とユーザーの操作で開いたパネル) に読んだもの全部を、取り直しも読む
 *     (表の mountReadsNotRefetched に理由つきで載せたものを除く)
 *   - expectEmptyRefetchMatchesFreshMount: 中身のある応答で開いたあと、空の応答で取り直した画面が、空の応答で開いた画面と同じ
 *     (取り直しが `if (x.length > 0) set(...)` や `if (x) set(...)` で前の値を残していない)
 *   - expectRefetchAlwaysBlockedWhileShown: 除外の alwaysBlockedWhileShown のページが、AI が書く値を出している間、
 *     取り直しの番兵 (isAiConsultationRefetchBlocked) が止める (除外の理由を描画で確かめる)
 *
 * 読み取りの鍵: GET の fetch は 'GET <道>?<並べ替えた問い合わせ>' (同じ起点の '/api/' だけ)、Supabase は 'from:<表>' / 'rpc:<名前>'。
 * Supabase の表の読み取りは select を呼んだときに記録する (ReadRecorder.recordSelect。insert / update / delete だけの書き込みは数えない)。
 * AI_CONSULTATION_WRITTEN_COLUMNS の表 (user_profiles) は、読む列ごとに 'from:<表>?select=<並べ替えた列>' と分ける:
 * 同じ表をいくつもの部品が別の列で読むので (献立表の週の始まりの日・家族・プロフィールの帯)、表だけの鍵では
 * 1 つの読み取りの取り直しがほかの読み取りの抜けを隠す。
 * tests/ai-consultation-refetch-coverage-2195.test.ts が、受け手ごとに 2 つの判定を呼ぶテストがあることを数え、
 * そのテストが部品を消すモック・ログアウトで読み取りを隠していないことも確かめる。
 */
import { expect } from 'vitest';
import { isAiConsultationRefetchBlocked } from '@/lib/ai/consultation-data-refetch';
import { AI_CONSULTATION_REFETCH_PAGES, AI_CONSULTATION_WRITTEN_COLUMNS } from '@/lib/ai/consultation-refetch-coverage';

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
/** select を引数なしで呼んだときの列 (全部) */
const ALL_COLUMNS = '*';

/** select の文字列を最上位の ',' で分ける (埋め込みの関係 'x(a, b)' の中の ',' では分けない) */
function topLevelColumns(select: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of select) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((column) => column.replace(/\s+/g, '')).filter((column) => column !== '');
}

/**
 * Supabase の表の読み取り (select) の鍵。AI_CONSULTATION_WRITTEN_COLUMNS の表は読む列ごとに分ける
 * ('from:<表>?select=<並べ替えた列>')。ほかの表は 'from:<表>'
 */
export function selectReadKey(table: string, select: unknown): string {
  if (!Object.prototype.hasOwnProperty.call(AI_CONSULTATION_WRITTEN_COLUMNS, table)) return tableReadKey(table);
  const columns = typeof select === 'string' ? topLevelColumns(select) : [];
  const listed = columns.length === 0 ? ALL_COLUMNS : [...new Set(columns)].sort().join(',');
  return `${tableReadKey(table)}?select=${listed}`;
}

/** 読み取りの鍵を溜める。take() で今までの分を返して空にする */
export class ReadRecorder {
  private keys = new Set<string>();

  record(key: string | null): void {
    if (key !== null) this.keys.add(key);
  }

  /** Supabase の表の読み取り (`.from(table).select(select)`) を記録する (鍵は selectReadKey) */
  recordSelect(table: string, select: unknown): void {
    this.keys.add(selectReadKey(table, select));
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

/**
 * 除外の alwaysBlockedWhileShown のページ: AI が書く値 (shownText。画面に出ている文字) を出している間、取り直しの番兵が止める。
 * 値が画面に出ていなければ検査が空振りしているので赤 (root は番兵が調べる範囲。ページの描画の document)
 */
export function expectRefetchAlwaysBlockedWhileShown(page: string, root: ParentNode, screen: Element, shownText: string): void {
  const entry = AI_CONSULTATION_REFETCH_PAGES[page];
  expect(entry?.kind === 'excluded' && entry.alwaysBlockedWhileShown === true, `${page} は AI_CONSULTATION_REFETCH_PAGES の alwaysBlockedWhileShown の除外`).toBe(true);
  expect(screen.textContent ?? '', `${page} が AI が書く値を出していない (検査が空振りしている)`).toContain(shownText);
  expect(isAiConsultationRefetchBlocked(root), `${page} が AI が書く値を出している間に、取り直しの番兵が止めない`).toBe(true);
}
