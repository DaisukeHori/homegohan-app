/**
 * migrations / baseline の SQL から、列の既定値 (DEFAULT '...') の文字列を拾う (#1911)
 *
 * 生成のリクエストの行 (weekly_menu_requests / shopping_list_requests) の progress には DB の既定値があり、
 * progress を渡さずに行を作る経路では、その message がそのまま画面に届く。
 * 画面に出る文の置き場所は src/ のソースだけではないので、SQL の既定値も検査の対象にするために使う。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

/** 既定値を探す SQL の置き場所 (migrations と、本番の定義を写した baseline) */
export const DB_DEFAULT_SQL_DIRS = ['supabase/migrations', 'supabase/baseline'] as const;

export interface SqlDefaultLiteral {
  /** リポジトリの根からの相対パス */
  file: string;
  /** 1 始まりの行番号 */
  line: number;
  /** その行 (前後の空白を除く) */
  sourceLine: string;
  /** DEFAULT の文字列 ('' は ' に戻した値) */
  value: string;
}

/** DEFAULT '...' の文字列。SQL の文字列の中の ' は '' と書く */
const DEFAULT_LITERAL = /DEFAULT\s+'((?:[^']|'')*)'/g;

/** -- で始まる行 (SQL のコメント) は見ない */
function isSqlCommentLine(line: string): boolean {
  return line.trimStart().startsWith('--');
}

export function listSqlFiles(): string[] {
  return DB_DEFAULT_SQL_DIRS.flatMap((dir) =>
    fs
      .readdirSync(path.join(ROOT, dir))
      .filter((name) => name.endsWith('.sql'))
      .map((name) => path.join(dir, name)),
  ).sort();
}

/** SQL のファイルすべてから、DEFAULT の文字列を拾う */
export function findSqlDefaultLiterals(): SqlDefaultLiteral[] {
  const found: SqlDefaultLiteral[] = [];
  for (const file of listSqlFiles()) {
    fs.readFileSync(path.join(ROOT, file), 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (isSqlCommentLine(line)) return;
        for (const match of line.matchAll(DEFAULT_LITERAL)) {
          found.push({ file, line: index + 1, sourceLine: line.trim(), value: match[1].replace(/''/g, "'") });
        }
      });
  }
  return found;
}

/** progress 列の既定値 (JSON の object) だけ。画面の検査に、本物の既定値を入力として渡すために使う */
export function findProgressDefaults(): Array<SqlDefaultLiteral & { progress: { phase?: unknown; message?: unknown } }> {
  return findSqlDefaultLiterals()
    .filter((literal) => /"progress"/.test(literal.sourceLine))
    .map((literal) => ({ ...literal, progress: JSON.parse(literal.value) as { phase?: unknown; message?: unknown } }));
}
