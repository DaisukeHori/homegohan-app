/**
 * supabase/migrations の SQL が pg_cron に登録しているジョブの名前を数える見張り (DB には接続しない)。
 *
 * 設計書 docs/design/operator/08-cron-batches.md の「いま」の記述 (§3.0・§3.1 の注記のジョブの名前と数) を、
 * 木の実物と突き合わせるのに使う (tests/log-cleanup-dau-snapshot-contract.test.ts)。
 *
 * 数える書き方 (cron.schedule / cron.schedule_in_database の呼び出しの、ジョブの名前の引数):
 *   1. 文字列の直書き                cron.schedule('名前', ...)
 *   2. 名前付きの引数                cron.schedule(job_name := '名前', ...)  (=> も同じ)
 *   3. DECLARE の定数の変数          c_job CONSTANT text := '名前'; ... cron.schedule(c_job, ...)  (#1561 の migration の書き方)
 *      定数は、呼び出しを囲む DECLARE の節 (呼び出しより前の最後の DECLARE から、その次の BEGIN まで) に書かれたものだけを読む。
 *      CONSTANT の付かない変数は、あとで代入し直せるので読まない (解けない形として赤にする)
 *
 * この見張りの限界 (拾えない書き方。空振りせずに「解けない呼び出し」として赤にするものと、そもそも見えないもの):
 *   - 赤にするもの: 名前が式・連結 ('a' || x)・関数の呼び出し (format(...))・E'...' やドル引用の文字列・CONSTANT でない変数・
 *     囲む DECLARE の節に無い定数 (外側のブロックの定数・入れ子のブロックを含む) のとき。
 *     名前の無いジョブ (cron.schedule(schedule, command) の 2 つの引数の形) のとき。閉じかっこが見つからないとき。
 *     EXECUTE の文字列の中の cron.schedule (引用符が 2 つ重なって、名前が解けない形になる)
 *   - 見えないもの: 引用符で囲んだ識別子 ("cron"."schedule")・search_path に頼った schedule(...) の呼び出し。
 *     -- の行コメントは、文字列の中の -- もコメントとして取り除く (いまの migration の文字列には -- を含むものが無い)
 *   - あとの migration がジョブを外したまま登録し直さない (ジョブをやめる) 場合は数えから除かない。そのときはここに除く処理を足す
 */
import fs from 'node:fs';
import path from 'node:path';

export interface MigrationCronJobs {
  /** 登録しているジョブの名前 (重複を除いて並べたもの) */
  names: string[];
  /** 名前を解けなかった呼び出し (「ファイル:行: 理由」)。空でなければ、見張りの数えが信用できない */
  unresolved: string[];
}

/** cron.schedule の引数のうち、ジョブの名前を持つ引数の名前 (pg_cron の関数の引数名) */
const JOB_NAME_ARGUMENT = 'job_name';
/**
 * 名前の無いジョブの形 cron.schedule(schedule, command) の引数の数。
 * これより多ければ、最初の位置の引数がジョブの名前 (cron.schedule(job_name, schedule, command) と schedule_in_database)
 */
const UNNAMED_JOB_ARGUMENT_COUNT = 2;
/** 解けない呼び出しの報告に載せる、引数の先頭の長さ (行が長くなりすぎないように) */
const REPORTED_ARGUMENT_MAX_LENGTH = 60;

const CALL_PATTERN = /\bcron\.schedule(?:_in_database)?\s*\(/gi;
const STRING_LITERAL = /^'((?:[^']|'')*)'$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NAMED_ARGUMENT = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::=|=>)\s*([\s\S]*)$/;
const CONSTANT_DECLARATION =
  /\b([A-Za-z_][A-Za-z0-9_]*)\s+CONSTANT\s+(?:text|varchar|character\s+varying)\s*(?::=|=|DEFAULT)\s*'((?:[^']|'')*)'\s*;/gi;

/** -- の行コメントと、/* *\/ のコメントを取り除く。行の数は変えない (報告の行番号を元のファイルと合わせる) */
export function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
    .replace(/--.*$/gm, '');
}

const unquote = (body: string) => body.replace(/''/g, "'");

/**
 * 開きかっこの直後 (start) から、対応する閉じかっこまでの引数を、上の階層のカンマで分ける。
 * '...' ('' は引用符 1 つ)・"..."・ドル引用 ($tag$...$tag$) の中のカンマとかっこは数えない。閉じかっこが無ければ null
 */
export function splitCallArguments(sql: string, start: number): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  let index = start;
  while (index < sql.length) {
    const char = sql[index];
    if (char === "'" || char === '"') {
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === char) {
          if (sql[end + 1] === char) {
            end += 2;
            continue;
          }
          break;
        }
        end += 1;
      }
      if (end >= sql.length) return null;
      current += sql.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (char === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(index));
      if (tag) {
        const close = sql.indexOf(tag[0], index + tag[0].length);
        if (close < 0) return null;
        current += sql.slice(index, close + tag[0].length);
        index = close + tag[0].length;
        continue;
      }
    }
    if (char === '(') depth += 1;
    if (char === ')') {
      if (depth === 0) {
        args.push(current.trim());
        return args;
      }
      depth -= 1;
    }
    if (char === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += char;
    }
    index += 1;
  }
  return null;
}

/** 呼び出しを囲む DECLARE の節 (offset より前の最後の DECLARE から、その次の BEGIN まで) の、文字列の定数 */
function enclosingConstants(sql: string, offset: number): Map<string, string[]> {
  const constants = new Map<string, string[]>();
  const before = sql.slice(0, offset);
  const declareMatches = [...before.matchAll(/\bDECLARE\b/gi)];
  const declare = declareMatches[declareMatches.length - 1];
  if (!declare || declare.index === undefined) return constants;
  const begin = /\bBEGIN\b/i.exec(before.slice(declare.index));
  if (!begin) return constants;
  const section = before.slice(declare.index, declare.index + begin.index);
  for (const match of section.matchAll(CONSTANT_DECLARATION)) {
    const key = match[1].toLowerCase();
    constants.set(key, [...(constants.get(key) ?? []), unquote(match[2])]);
  }
  return constants;
}

/** ジョブの名前の式を解く。解けなければ理由を返す */
function resolveJobName(expression: string, constants: Map<string, string[]>): { name: string } | { reason: string } {
  const literal = STRING_LITERAL.exec(expression);
  if (literal) return { name: unquote(literal[1]) };
  if (IDENTIFIER.test(expression)) {
    const values = constants.get(expression.toLowerCase()) ?? [];
    if (values.length === 1) return { name: values[0] };
    if (values.length === 0) return { reason: `囲む DECLARE の節に文字列の定数 (CONSTANT) として無い変数 ${expression}` };
    return { reason: `囲む DECLARE の節に ${expression} の定数が ${values.length} つある` };
  }
  return { reason: `名前が文字列の直書きでも定数の変数でもない (式・連結など): ${expression.slice(0, REPORTED_ARGUMENT_MAX_LENGTH)}` };
}

/** 1 つの SQL (コメントを取り除く前のもの) の cron.schedule の呼び出しから、ジョブの名前を読む。label は報告に使うファイルの名前 */
export function scanCronJobNames(sqlWithComments: string, label: string): MigrationCronJobs {
  const sql = stripSqlComments(sqlWithComments);
  const names: string[] = [];
  const unresolved: string[] = [];
  for (const call of sql.matchAll(CALL_PATTERN)) {
    const offset = call.index ?? 0;
    const where = `${label}:${sql.slice(0, offset).split('\n').length}`;
    const args = splitCallArguments(sql, offset + call[0].length);
    if (!args) {
      unresolved.push(`${where}: 閉じかっこ・引用符の終わりが見つからない`);
      continue;
    }
    const named = new Map<string, string>();
    let nameExpression: string | null = null;
    for (const arg of args) {
      const match = NAMED_ARGUMENT.exec(arg);
      if (match) named.set(match[1].toLowerCase(), match[2].trim());
    }
    if (named.has(JOB_NAME_ARGUMENT)) nameExpression = named.get(JOB_NAME_ARGUMENT) ?? null;
    else if (args.length > UNNAMED_JOB_ARGUMENT_COUNT && !NAMED_ARGUMENT.test(args[0])) nameExpression = args[0];
    if (nameExpression === null) {
      unresolved.push(`${where}: ジョブの名前の引数が無い (名前の無いジョブ cron.schedule(schedule, command) の形)`);
      continue;
    }
    const resolved = resolveJobName(nameExpression, enclosingConstants(sql, offset));
    if ('name' in resolved) names.push(resolved.name);
    else unresolved.push(`${where}: ${resolved.reason}`);
  }
  return { names, unresolved };
}

/** ディレクトリ (supabase/migrations) の .sql すべての、pg_cron のジョブの名前 */
export function collectMigrationCronJobs(migrationsDir: string): MigrationCronJobs {
  const names = new Set<string>();
  const unresolved: string[] = [];
  for (const file of fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()) {
    const result = scanCronJobNames(fs.readFileSync(path.join(migrationsDir, file), 'utf-8'), file);
    for (const name of result.names) names.add(name);
    unresolved.push(...result.unresolved);
  }
  return { names: [...names].sort(), unresolved };
}
