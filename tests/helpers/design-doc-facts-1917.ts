// tests/helpers/design-doc-facts-1917.ts
// #1917 docs-1024a で指し先を取り直した事実と、それを何か所かで述べる設計書の組 (tests/design-doc-fact-consistency.test.ts が使う)。
// 1 冊の中で、事実ごとの値 (行番号・ファイル) が 1 つにそろうことを確かめる (tests/helpers/design-doc-fact-consistency.ts)。
import type { FactValueReader } from './design-doc-fact-consistency';

/** 確かめる事実と冊の組 */
export type DesignDocFact = {
  /** 何の事実か (テストの題と失敗の文に出す) */
  readonly name: string;
  /** 設計書 (リポジトリの根からの道) */
  readonly doc: string;
  readonly read: FactValueReader;
  /** 冊の中で値を取り出せる箇所の最低の数 (取り出しの形が冊の書き方とずれて、何も見なくなったら赤にする) */
  readonly minMentions: number;
};

/** `<file>:` に続く行番号の並び (`109, 126-128` のような `, ` 区切り) を、並びごとに 1 つずつの番号に分ける */
function pointerLists(text: string, filePattern: string): string[][] {
  const pattern = new RegExp(`${filePattern}:(\\d+(?:-\\d+)?(?:, \\d+(?:-\\d+)?)*)`, 'g');
  return [...text.matchAll(pattern)].map((match) => match[1].split(', '));
}

/** 範囲 (`126-128`) でない 1 行の番号だけ */
function singleLines(items: readonly string[]): string[] {
  return items.filter((item) => !item.includes('-'));
}

/**
 * 画面の表の (auth) の行 (cross/13b §3.3)。auth を呼ぶ行を `login.tsx:<Google>, <メールとパスワード>`・`signup.tsx:<Google>, <メールの登録>`
 * の形で書き、並びの最後がメールの行 (Sign in with Apple の段 A2 の前は `signup.tsx:<メールの登録>` の 1 つだけ)
 */
const AUTH_SCREEN_ROW = /^\| \(auth\) \|/;
const LOGIN_FILE = String.raw`login\.tsx`;
const SIGNUP_FILE = String.raw`signup\.tsx`;

/** findBlocker (退会の 409) を述べる行 */
const FIND_BLOCKER_LINE = /findBlocker|ACCOUNT_DELETE_BLOCKED_(?:ORG_OWNER|FAMILY_REPRESENTATIVE)/;
/** src/lib/account-deletion.ts の範囲 (src/lib/billing/account-deletion.ts は別のファイルなので拾わない) */
const ACCOUNT_DELETION_RANGE = /(?<!billing\/)account-deletion\.ts:(\d+-\d+)/g;

/** findBlocker を述べる行の、src/lib/account-deletion.ts の範囲 */
const readFindBlockerRange: FactValueReader = (text) =>
  FIND_BLOCKER_LINE.test(text) ? [...text.matchAll(ACCOUNT_DELETION_RANGE)].map((match) => match[1]) : [];

/**
 * ログインの後の振り分け routeAfterSignIn の置き場: `login.tsx` の範囲 (Sign in with Apple の段 A2 の前) か、
 * `routeAfterSignIn.ts` (段 A2 で移った)。`login.tsx` の 1 行の番号は呼び出しの行なので拾わない
 */
const readRouteAfterSignInPlace: FactValueReader = (text) =>
  text.includes('routeAfterSignIn')
    ? [...text.matchAll(/(login\.tsx):\d+-\d+|(routeAfterSignIn\.ts)(?!x)/g)].map((match) => match[1] ?? match[2])
    : [];

/** 新規登録の画面のメールの登録 (signUp) の行: (auth) の行は signup.tsx の並びの最後、サインアップを述べる行は最初の 1 行の番号 */
const readSignUpLine: FactValueReader = (text) => {
  const lists = pointerLists(text, SIGNUP_FILE).map(singleLines);
  if (AUTH_SCREEN_ROW.test(text)) return lists.flatMap((items) => items.slice(-1));
  if (text.includes('サインアップ')) return lists.flatMap((items) => items.slice(0, 1));
  return [];
};

/** ログインの画面のメールとパスワード (signInWithPassword) の行: (auth) の行は login.tsx の並びの最後、ほかは「ログイン (`login.tsx:N`)」 */
const readSignInWithPasswordLine: FactValueReader = (text) => {
  if (AUTH_SCREEN_ROW.test(text)) return pointerLists(text, LOGIN_FILE).map(singleLines).flatMap((items) => items.slice(-1));
  return [...text.matchAll(/ログイン \(`login\.tsx:(\d+)`\)/g)].map((match) => match[1]);
};

/** 確認メールの画面 (/auth/verify) が session を確かめてホームへ回す `Redirect` の行 (verify.tsx の 1 行の番号) */
const readVerifyRedirectLine: FactValueReader = (text) =>
  [...text.matchAll(/verify\.tsx:(\d+)(?![\d-])/g)].map((match) => match[1]);

/** 設定の画面の書き出し 2 つ (アカウントのデータ・食事の CSV) の fetch の行の組 (`<アカウント>, <食事>`) */
const readSettingsExportFetchLines: FactValueReader = (text) => {
  const values: string[] = [];
  for (const match of text.matchAll(/書き出し 2 つ \(`settings\.tsx:(\d+), (\d+)`/g)) values.push(`${match[1]}, ${match[2]}`);
  for (const match of text.matchAll(/settings\.tsx:(\d+)-\d+, (\d+)-\d+/g)) values.push(`${match[1]}, ${match[2]}`);
  const account = /`GET \/api\/account\/export` \(`:(\d+)`/.exec(text);
  const meals = /`GET \/api\/export\/meals` \(`:(\d+)`/.exec(text);
  if (account && meals) values.push(`${account[1]}, ${meals[1]}`);
  return values;
};

const CROSS_13B = 'docs/design/cross/13b-legal-consent-mobile.md';

export const DESIGN_DOC_FACTS_1917: readonly DesignDocFact[] = [
  { name: 'findBlocker の範囲', doc: 'docs/design/family/11-self-dissolve.md', read: readFindBlockerRange, minMentions: 2 },
  { name: 'findBlocker の範囲', doc: 'docs/design/cross/20-terms-privacy-text.md', read: readFindBlockerRange, minMentions: 3 },
  { name: 'findBlocker の範囲', doc: 'docs/design/family/10-family-menu-view.md', read: readFindBlockerRange, minMentions: 1 },
  { name: 'routeAfterSignIn の置き場', doc: CROSS_13B, read: readRouteAfterSignInPlace, minMentions: 4 },
  { name: '新規登録の画面の signUp の行', doc: CROSS_13B, read: readSignUpLine, minMentions: 4 },
  { name: 'ログインの画面の signInWithPassword の行', doc: CROSS_13B, read: readSignInWithPasswordLine, minMentions: 2 },
  { name: '確認メールの画面の Redirect の行', doc: CROSS_13B, read: readVerifyRedirectLine, minMentions: 4 },
  { name: '設定の画面の書き出し 2 つの fetch の行', doc: CROSS_13B, read: readSettingsExportFetchLines, minMentions: 3 },
];
