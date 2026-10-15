// tests/helpers/design-doc-pending-1598.ts
// #1598 設計書 (docs/design/) の見張りが、まだ直していない名指しを「設計書ごと・名指しごとの数」で固定するための型と突き合わせ。
//
// 設計書は設計の正典で、実装のレーン (画面を消す枝) は書き換えない。見張り (tests/design-doc-removed-mobile-screens.test.ts・
// tests/design-doc-push-paths-resolve.test.ts) に消した画面を足すと、設計書がまだその画面を名指ししている行で赤になる。
// その行を設計書の側で直すまでのあいだ、いまある名指しを下の 2 つの一覧に数で書き、見張りは一覧と突き合わせる。
//   - tests/helpers/design-doc-pending-notes-1598.ts: 同じ行に「削除した」と注記すれば済む名指し (設計の判断を変えない)
//   - tests/helpers/design-doc-pending-revisions-1598.ts: 注記では直らない名指し (設計の判断を変える。設計の改定で直す)
// 1 つの設計書は、どちらか一方の一覧にだけ載せる (2 つの差分が同じ設計書に触れず、どちらを先に当てても当たるように)。
// 突き合わせは両方向に厳しい:
//   - 一覧より多い名指し (新しく名指しを足した設計書。同じ設計書・同じ名指しでも 1 行増えたもの) は「一覧に無い」で赤
//   - 一覧より少ない名指し (設計書を直したのに一覧が残っているもの) は「直したのに一覧に残っている」で赤
//     (設計書を直す差分と同じコミットで、一覧の数を減らす・0 になった行を消す)

/** 見張りが数える名指しの種類 */
export type PendingKind =
  /** 消した画面のファイルを名指しする行 (target は apps/mobile/app からの相対) */
  | 'screen'
  /** 消した部品・テスト・maestro の flow・根のファイルを名指しする行 (target はリポジトリの根からの相対) */
  | 'file'
  /** 消した画面・区画を指すコードの文字列 (target は apps/mobile/app からの相対) */
  | 'codeLiteral'
  /** Push の設計書の通知の行き先のうち、アプリが同じパスとして開かないもの (target はパス) */
  | 'pushPath';

/** まだ直していない名指し (設計書ごと・種類ごと・名指しごとの数) */
export type PendingEntry = {
  /** 設計書 (リポジトリの根からの相対。docs/design/ の下の .md) */
  readonly file: string;
  readonly kind: PendingKind;
  readonly target: string;
  /** その設計書の中の、注記の無い名指しの数 (行ごとに 1 つ。通知の行き先は宣言ごとに 1 つ) */
  readonly count: number;
};

/** 見張りが見つけた、まだ直していない名指し 1 つ */
export type FoundMention = {
  readonly file: string;
  readonly target: string;
  /** 設計書の行 (分からないものは書かない) */
  readonly line?: number;
};

/** 一覧との突き合わせの結果 (どちらも空なら一覧のとおり) */
export type PendingReconciliation = {
  /** 一覧より多い名指し (新しく足した名指し) */
  readonly unlisted: string[];
  /** 一覧より少ない名指し (直したのに一覧に残っているもの) */
  readonly resolved: string[];
};

/** 設計書と名指しの組の鍵 (区切りはパスに出ない文字) */
const KEY_SEPARATOR = '\u0000';
const keyOf = (file: string, target: string): string => `${file}${KEY_SEPARATOR}${target}`;

/** 見つけた名指しを、一覧 (同じ種類の行) と数で突き合わせる */
export function reconcilePending(
  found: readonly FoundMention[],
  kind: PendingKind,
  pending: readonly PendingEntry[],
): PendingReconciliation {
  const actual = new Map<string, FoundMention[]>();
  for (const mention of found) {
    const key = keyOf(mention.file, mention.target);
    actual.set(key, [...(actual.get(key) ?? []), mention]);
  }
  const listed = new Map<string, PendingEntry>();
  for (const entry of pending) {
    if (entry.kind === kind) listed.set(keyOf(entry.file, entry.target), entry);
  }

  const unlisted: string[] = [];
  for (const [key, mentions] of actual) {
    const [first] = mentions;
    const listedCount = listed.get(key)?.count ?? 0;
    if (mentions.length <= listedCount) continue;
    const lines = mentions.flatMap((mention) => (mention.line === undefined ? [] : [mention.line]));
    const where = lines.length > 0 ? ` (行 ${lines.join(', ')})` : '';
    unlisted.push(`${first.file} (${first.target}): 一覧 ${listedCount}・実際 ${mentions.length}${where}`);
  }

  const resolved: string[] = [];
  for (const [key, entry] of listed) {
    const actualCount = actual.get(key)?.length ?? 0;
    if (actualCount < entry.count) {
      resolved.push(`${entry.file} (${entry.target}): 一覧 ${entry.count}・実際 ${actualCount}`);
    }
  }
  return { unlisted, resolved };
}

/** 一覧そのものの形の誤り (同じ組の重複・数が 1 以上の整数でない) */
export function pendingEntryShapeProblems(pending: readonly PendingEntry[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of pending) {
    const key = `${entry.kind}${KEY_SEPARATOR}${keyOf(entry.file, entry.target)}`;
    if (seen.has(key)) problems.push(`重複: ${entry.file} (${entry.kind}: ${entry.target})`);
    seen.add(key);
    if (!Number.isInteger(entry.count) || entry.count < 1) {
      problems.push(`数が 1 以上の整数でない: ${entry.file} (${entry.kind}: ${entry.target}) = ${entry.count}`);
    }
  }
  return problems;
}

/** 2 つの一覧の両方に載っている設計書 (1 つの設計書はどちらか一方にだけ載せる) */
export function filesInBothLedgers(a: readonly PendingEntry[], b: readonly PendingEntry[]): string[] {
  const filesOfB = new Set(b.map((entry) => entry.file));
  return [...new Set(a.map((entry) => entry.file))].filter((file) => filesOfB.has(file)).sort();
}
