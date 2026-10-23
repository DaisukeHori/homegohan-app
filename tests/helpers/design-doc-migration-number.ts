// tests/helpers/design-doc-migration-number.ts
// 設計書 (docs/design/) が名指す migration のファイル名 (`<版>_<名前>.sql` と対の戻し口 `<版>_<名前>.down.sql`) の版の書き方を確かめる。
//
// 設計書は、migration の版の番号をマージの直前に決めるので、設計の段階では番号の置き場 (`<番号はマージ時に確定>`・`<同じ番号>`・`<番号>`) で書く。
// マージの後に実際の番号へ書き換えるとき、一部の置き場だけが残ると、対になっているはずの箇所 (migration の見出しと
// 戻し口の見出しなど) の番号が食い違う (#1917 の書き換えの差分で、mobile/08 §8.1 の migration の見出しは番号にしたのに、
// 戻し口の 1 行目が置き場のまま残った)。
// ここでは次の 2 つの状態だけを正しいとし、それ以外 (置き場と番号が混ざる・実在しない番号) を問題として返す:
//   - すべてが置き場 (まだ番号を書き入れていない)
//   - すべてが実在する migration の番号 (書き入れ終えた)

/** supabase/migrations の版の番号 = YYYYMMDDHHMMSS の 14 桁 (tests/migration-file-version-integrity.test.ts の VERSION_PATTERN と同じ形) */
const VERSION_SOURCE = String.raw`\d{14}`;
const VERSION_ONLY = new RegExp(`^${VERSION_SOURCE}$`);
/** 番号の置き場 = 山かっこで囲んだ 1 語 (`<番号はマージ時に確定>`・`<同じ番号>`・`<番号>`)。山かっこと改行はまたがない */
const PLACEHOLDER_SOURCE = String.raw`<[^<>\n]+>`;

/** 設計書の中の、migration のファイル名の 1 か所 */
export type MigrationNameMention = {
  /** 設計書の行 (1 から) */
  readonly line: number;
  /** ファイル名の版の部分 (14 桁の番号か、山かっこの置き場) */
  readonly version: string;
  /** 見つけたファイル名 (`<版>_<名前>.sql` / `<版>_<名前>.down.sql`) */
  readonly fileName: string;
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 設計書の本文から、`<版>_<migrationName>.sql` と `<版>_<migrationName>.down.sql` の形のファイル名を行ごとに集める */
export function collectMigrationNameMentions(doc: string, migrationName: string): MigrationNameMention[] {
  // 版の前に数字が続く (14 桁より長い数の末尾) ものは拾わない
  const pattern = new RegExp(`(?<!\\d)(${VERSION_SOURCE}|${PLACEHOLDER_SOURCE})_${escapeRegExp(migrationName)}(?:\\.down)?\\.sql`, 'g');
  const mentions: MigrationNameMention[] = [];
  doc.split('\n').forEach((text, index) => {
    for (const match of text.matchAll(pattern)) {
      mentions.push({ line: index + 1, version: match[1], fileName: match[0] });
    }
  });
  return mentions;
}

/**
 * 集めたファイル名の版が「すべて置き場」か「すべて実在する番号 (realVersion)」のどちらかになっているかを確かめ、外れた箇所を
 * `行: ファイル名 (理由)` の文で返す (問題が無ければ空の配列)。
 */
export function findMigrationNumberProblems(mentions: readonly MigrationNameMention[], realVersion: string): string[] {
  const numbered = mentions.filter((mention) => VERSION_ONLY.test(mention.version));
  if (numbered.length === 0) return [];
  const problems: string[] = [];
  for (const mention of mentions) {
    if (!VERSION_ONLY.test(mention.version)) {
      problems.push(`${mention.line}: ${mention.fileName} (ほかの箇所は番号を書き入れたのに、ここは置き場のまま)`);
    } else if (mention.version !== realVersion) {
      problems.push(`${mention.line}: ${mention.fileName} (実在する migration の番号 ${realVersion} と違う)`);
    }
  }
  return problems;
}
