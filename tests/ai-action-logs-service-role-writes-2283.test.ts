// @vitest-environment node
/**
 * #2283 判断待ち 8 の前段 Y1: AI 相談の提案の記録 (ai_action_logs) への書き込みは、service role (getAiActionLogWriter) からだけ
 *
 * ai_action_logs は、利用者 (authenticated) には読むだけにした (後段の Y2 = supabase/migrations/20261107120000_ai_action_logs_select_only.sql
 * (#2291) で RLS と GRANT を絞った)。利用者のセッションのクライアント (createClient) で書くと、書き込みが権限で拒まれ (42501)、
 * 提案の行が実行中の印のまま残る (書き戻しの関数はエラーを返すだけなので、黙って起きる)。
 * このテストは、ソースから次を確かめる (Y2 で絞ったあとも、書き手を service role だけに保つ)。
 *
 *   1. 書き込みの経路の一覧 (WRITE_PATHS) が、ソースの書き込みと一致する (足したら一覧にも足す)
 *   2. 書き込み (.from('ai_action_logs').insert / update / upsert / delete) の受け手は actionLogDb だけ
 *      (受け手が式 ((await createClient()) など) や別の名前なら違反)
 *   3. actionLogDb は getAiActionLogWriter() だけから作る。関数の引数で受け取るのは決まった箇所 (PARAM_RECEIVERS) だけ
 *   4. 書き戻しの関数 writeBackAiActionLog の呼び出しは、1 つ目の引数に actionLogDb を渡す
 *   5. getAiActionLogWriter は service role のクライアント (getSupabaseAdmin) を返す
 *   6. 画面 ('use client')・モバイル (apps/mobile) は書かない。Edge Function (supabase/functions) も書かない。
 *      走査の対象 (APP_DIRS) には運用のスクリプト (scripts/) も入れる (利用者の鍵で書く経路を足したら捕まえる。#2292)
 *   7. .from('ai_action_logs') の直後は select か書き込み (問い合わせを変数に入れてから書く形は見分けられないので禁止)。
 *      表の名前を文字列で持つのは決まった箇所 (TABLE_NAME_LITERALS。読むだけ) と、失敗のログの文脈 (internalError の引数) だけ
 *   8. migration の SQL の関数・トリガーが ai_action_logs に書かない (書く RPC を作ったら、この一覧と Y2 を見直す)
 *
 * 限界 (見張りであって、証明ではない): 書いてよい行か (持ち主の確認) は見ない。それは route のテスト
 * (tests/ai-action-logs-writer-routes-2283.test.ts) が、持ち主でない行・相談に書かないことで確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, rel, stripComments } from './helpers/ai-reach';

const TABLE = 'ai_action_logs';
const WRITER_FACTORY = 'getAiActionLogWriter';
const WRITER_RECEIVER = 'actionLogDb';
const WRITER_FILE = 'src/lib/ai/ai-action-log-writer.ts';
const WRITE_BACK_HELPER = 'writeBackAiActionLog';

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs)$/;
const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|jsx)$/;
const SKIP_DIRS = new Set(['node_modules', '.next', '.expo', 'dist', 'build', '__tests__', '__mocks__']);

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...walk(path.join(dir, entry.name)));
    } else if (SOURCE_EXT.test(entry.name) && !TEST_FILE.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/**
 * Next.js・共有のライブラリ・画面の部品・モバイルのソースと、運用のスクリプト (scripts/。#2292。Edge Function は別に見る)。
 * スクリプトが利用者の鍵 (anon と利用者のセッション) で書く経路を足すと、本番では権限で拒まれる (42501) ので、ここで捕まえる
 */
const APP_DIRS = ['src', 'lib', 'components', 'shared', 'packages', 'apps/mobile/app', 'apps/mobile/src', 'apps/mobile/lib', 'scripts'];
const appFiles = APP_DIRS.flatMap((dir) => walk(path.join(ROOT, dir))).map(rel).sort();
const edgeFiles = walk(path.join(ROOT, 'supabase/functions')).map(rel).sort();

const sourceCache = new Map<string, string>();
/** コメントを外した本文 (読むのは 1 回だけ) */
const codeOf = (file: string) => {
  let code = sourceCache.get(file);
  if (code === undefined) {
    code = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    sourceCache.set(file, code);
  }
  return code;
};
const mentionsTable = (file: string) => codeOf(file).includes(TABLE);

interface TableAccess {
  /** .from の前の受け手 (識別子のつながり。式なら '<式>') */
  receiver: string;
  /** .from の直後の呼び出し (select / insert / update / upsert / delete。ほかは '<その他>') */
  op: string;
}

const WRITE_OPS = new Set(['insert', 'update', 'upsert', 'delete']);
const FROM_TABLE = new RegExp(`\\.from\\(\\s*['"\`]${TABLE}['"\`]\\s*\\)\\s*(?:\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\()?`, 'g');

/** .from('ai_action_logs') のすべての出現と、その受け手・直後の呼び出し (複数行の書き方も拾う) */
function findTableAccesses(code: string): TableAccess[] {
  return [...code.matchAll(FROM_TABLE)].map((match) => {
    const before = code.slice(0, match.index).replace(/\s+$/, '');
    const receiverMatch = /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)$/.exec(before);
    const precededByIdentifierOnly = receiverMatch !== null && !/[)\]]\s*\.?\s*$/.test(before.slice(0, receiverMatch.index));
    const receiver = receiverMatch && precededByIdentifierOnly ? receiverMatch[1].replace(/\s+/g, '') : '<式>';
    const next = match[1];
    const op = next === 'select' || (next !== undefined && WRITE_OPS.has(next)) ? next : '<その他>';
    return { receiver, op };
  });
}
const writesOf = (file: string) => findTableAccesses(codeOf(file)).filter((a) => WRITE_OPS.has(a.op));

/**
 * ai_action_logs に書く経路の一覧 (#2283 Y1 の表)。ファイル → 書き込みの数と、どの書き込みか。
 * 種類はすべて service role (getAiActionLogWriter)。持ち主の確認は、それぞれの route のコードが行う。
 */
const WRITE_PATHS: Record<string, { ops: string[]; what: string }> = {
  'src/app/api/ai/consultation/actions/[actionId]/execute/route.ts': {
    ops: ['update', 'update'],
    what: 'POST: pending → 実行中の印 (approved) を取る条件つきの更新 (取るたびに新しい claim_token を書く。#2299 の B) / DELETE: pending → 却下 (rejected) の条件つきの更新 (#2292)。どちらも行の相談の持ち主を isAiActionLogOwnedBy で確かめてから',
  },
  'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts': {
    ops: ['insert'],
    what: 'POST の自動実行: 行を実行中の印で作る (新しい claim_token も書く。#2299 の B)。相談の持ち主を isConsultationSessionOwnedBy で確かめてから',
  },
  'src/lib/ai/consultation-action-log-writes.ts': {
    ops: ['update'],
    what: '実行のあとの書き戻し (writeBackAiActionLog。execute の POST と messages の POST の自動実行が呼ぶ)。行が実行中の印 (approved) で、印がその実行の claim_token のときだけ書く条件つきの更新 (#2295・#2299 の B。claim_token は書き換えない)',
  },
};

/** actionLogDb を関数の引数で受け取る、決まった箇所 (呼び出し側が actionLogDb を渡すことは 4. が確かめる) */
const PARAM_RECEIVERS: Record<string, RegExp> = {
  'src/lib/ai/consultation-action-log-writes.ts': /export async function writeBackAiActionLog\(\s*actionLogDb: AiActionLogWriter,/,
};

/** 表の名前を .from の外で文字列として持つ箇所 (読むだけ)。ファイル → 出現の数と理由 */
const TABLE_NAME_LITERALS: Record<string, { count: number; why: string }> = {
  // アカウントの書き出し (#1172)。src/lib/account-export.ts が .from(spec.table).select で読む (書かない)
  'src/lib/account-export-tables.ts': { count: 1, why: '書き出しの表の一覧 (読むだけ)' },
};

/** 失敗のログの文脈 (internalError(…, { table: 'ai_action_logs' })) の呼び出し。表の名前はログの印で、問い合わせには使わない */
const LOG_LABEL_CALL = 'internalError(';

/** 失敗のログの文脈の呼び出し (引数の括弧の中) を外した本文 */
function withoutLogLabelCalls(code: string): string {
  let out = '';
  let from = 0;
  for (let start = code.indexOf(LOG_LABEL_CALL); start >= 0; start = code.indexOf(LOG_LABEL_CALL, from)) {
    let depth = 0;
    let end = start + LOG_LABEL_CALL.length - 1;
    for (; end < code.length; end++) {
      if (code[end] === '(') depth += 1;
      else if (code[end] === ')' && --depth === 0) break;
    }
    out += code.slice(from, start);
    from = end + 1;
  }
  return out + code.slice(from);
}

const isClientComponent = (file: string) => /^\s*['"]use client['"]/.test(codeOf(file));
const isMobile = (file: string) => file.startsWith('apps/mobile/');

describe('ai_action_logs への書き込みは service role (getAiActionLogWriter) だけ (#2283 Y1)', () => {
  it('走査が対象のファイルを見ている (route・モバイルの画面・読み込み直しを含む)', () => {
    expect(appFiles).toContain('src/app/api/ai/consultation/actions/[actionId]/execute/route.ts');
    expect(appFiles).toContain('apps/mobile/src/components/ai/AIAdvisorSheet.tsx');
    expect(mentionsTable('apps/mobile/src/components/ai/AIAdvisorSheet.tsx')).toBe(true);
    expect(appFiles).toContain('src/lib/ai/consultation-reply-reload.ts');
    // 運用のスクリプト (#2292): .mjs と .ts のどちらも走査に入っている
    expect(appFiles).toContain('scripts/backup-db.mjs');
    expect(appFiles).toContain('scripts/benchmark-v4-fast-llm.ts');
    expect(appFiles.some((file) => file.includes('node_modules'))).toBe(false);
    // 読み取りも拾えている (検出の正規表現が壊れていない)
    const reads = appFiles.filter(mentionsTable).flatMap((file) => findTableAccesses(codeOf(file))).filter((a) => a.op === 'select');
    expect(reads.length).toBeGreaterThanOrEqual(Object.keys(WRITE_PATHS).length);
  });

  it('書き込みの経路の一覧 (WRITE_PATHS) がソースの書き込みと一致する', () => {
    const found: Record<string, string[]> = {};
    for (const file of appFiles.filter(mentionsTable)) {
      const ops = writesOf(file).map((w) => w.op);
      if (ops.length > 0) found[file] = ops;
    }
    const expected = Object.fromEntries(Object.entries(WRITE_PATHS).map(([file, { ops }]) => [file, ops]));
    expect(found, 'ai_action_logs に書く経路を足したら、WRITE_PATHS にも足し、service role (actionLogDb) で書くこと').toEqual(expected);
  });

  it('書き込みの受け手は actionLogDb だけ (利用者のセッションのクライアント・式で書かない)', () => {
    const offenders = appFiles
      .filter(mentionsTable)
      .flatMap((file) => writesOf(file).filter((w) => w.receiver !== WRITER_RECEIVER).map((w) => `${file}: ${w.receiver}.from('${TABLE}').${w.op}`));
    expect(
      offenders,
      '利用者のセッションのクライアントでは書かない。持ち主を確かめたあとで const actionLogDb = getAiActionLogWriter() を作り、actionLogDb で書くこと',
    ).toEqual([]);
  });

  it('actionLogDb は getAiActionLogWriter() だけから作る (引数で受け取るのは決まった箇所だけ)', () => {
    const offenders: string[] = [];
    for (const file of appFiles.filter((f) => codeOf(f).includes(WRITER_RECEIVER))) {
      const code = codeOf(file);
      for (const match of code.matchAll(new RegExp(`\\b${WRITER_RECEIVER}\\s*(?::[^=;\\n,)]+)?=\\s*([^;\\n]+)`, 'g'))) {
        if (match[1].trim() !== `${WRITER_FACTORY}();` && match[1].trim() !== `${WRITER_FACTORY}()`) {
          offenders.push(`${file}: ${WRITER_RECEIVER} = ${match[1].trim()}`);
        }
      }
      const writes = writesOf(file).filter((w) => w.receiver === WRITER_RECEIVER);
      const created = new RegExp(`\\bconst ${WRITER_RECEIVER} = ${WRITER_FACTORY}\\(\\)`).test(code);
      const receivedAsParam = PARAM_RECEIVERS[file]?.test(code) ?? false;
      if (writes.length > 0 && !created && !receivedAsParam) {
        offenders.push(`${file}: ${WRITER_RECEIVER} で書いているのに ${WRITER_FACTORY}() で作っていない`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('引数で受け取る決まった箇所は、いまも actionLogDb を受け取る形のまま', () => {
    for (const [file, evidence] of Object.entries(PARAM_RECEIVERS)) {
      expect(codeOf(file), file).toMatch(evidence);
    }
  });

  it('書き戻しの関数 writeBackAiActionLog の呼び出しは、1 つ目の引数に actionLogDb を渡す', () => {
    const offenders: string[] = [];
    let calls = 0;
    for (const file of appFiles.filter((f) => codeOf(f).includes(WRITE_BACK_HELPER))) {
      for (const match of codeOf(file).matchAll(new RegExp(`(?<!function\\s)\\b${WRITE_BACK_HELPER}\\(\\s*([^,)]*)`, 'g'))) {
        calls += 1;
        if (match[1].trim() !== WRITER_RECEIVER) offenders.push(`${file}: ${WRITE_BACK_HELPER}(${match[1].trim()}, …)`);
      }
    }
    // execute の POST の 3 箇所 (実行の失敗・今日の上限・確定) と messages の自動実行の 2 箇所 (確定・実行の失敗)
    expect(calls).toBeGreaterThanOrEqual(Object.keys(WRITE_PATHS).length);
    expect(offenders).toEqual([]);
  });

  it('getAiActionLogWriter は service role のクライアント (getSupabaseAdmin) を返す', () => {
    expect(codeOf(WRITER_FILE)).toMatch(new RegExp(`export function ${WRITER_FACTORY}\\(\\): SupabaseClient \\{\\s*return getSupabaseAdmin\\(\\);\\s*\\}`));
    expect(codeOf(WRITER_FILE)).toMatch(/import \{ getSupabaseAdmin \} from '@\/lib\/supabase\/server';/);
  });

  it('画面 (use client)・モバイルは書かない (読むのはよい)。Edge Function も書かない', () => {
    const clientOffenders = appFiles
      .filter((file) => mentionsTable(file) && (isMobile(file) || isClientComponent(file)))
      .flatMap((file) => writesOf(file).map((w) => `${file}: ${w.receiver}.from('${TABLE}').${w.op}`));
    expect(clientOffenders, '画面・モバイルからは API ルートを呼ぶこと (route が service role で書く)').toEqual([]);
    expect(edgeFiles.length).toBeGreaterThan(0);
    const edgeOffenders = edgeFiles.filter((file) => mentionsTable(file)).map((file) => `${file}: ${TABLE} に触れている`);
    expect(edgeOffenders).toEqual([]);
  });

  it(".from('ai_action_logs') の直後は select か書き込み。表の名前を文字列で持つのは決まった箇所だけ", () => {
    const unknownAccesses = appFiles
      .filter(mentionsTable)
      .flatMap((file) => findTableAccesses(codeOf(file)).filter((a) => a.op === '<その他>').map((a) => `${file}: ${a.receiver}.from('${TABLE}')`));
    expect(unknownAccesses, '問い合わせを変数に入れてから書く形は見分けられない。.from の直後に select / 書き込みを書くこと').toEqual([]);

    const literal = new RegExp(`['"\`]${TABLE}['"\`]`, 'g');
    const found: Record<string, number> = {};
    for (const file of appFiles.filter(mentionsTable)) {
      const code = withoutLogLabelCalls(codeOf(file));
      const outsideFrom = (code.match(literal)?.length ?? 0) - findTableAccesses(code).length;
      if (outsideFrom > 0) found[file] = outsideFrom;
    }
    expect(found, '表の名前を .from(変数) で使って書くと、上の検査をすり抜ける').toEqual(
      Object.fromEntries(Object.entries(TABLE_NAME_LITERALS).map(([file, { count }]) => [file, count])),
    );
    const templateFrom = appFiles.filter((file) => mentionsTable(file) && new RegExp(`\\.from\\(\\s*\`[^\`]*${TABLE}`).test(codeOf(file)));
    expect(templateFrom).toEqual([]);
  });

  it('migration の SQL の関数・トリガーが ai_action_logs に書かない (書くのはサーバーの service role だけ)', () => {
    const dir = path.join(ROOT, 'supabase/migrations');
    const sqlFiles = fs.readdirSync(dir).filter((name) => name.endsWith('.sql'));
    expect(sqlFiles.length).toBeGreaterThan(0);
    const tableRef = String.raw`(?:ONLY\s+)?(?:"?public"?\s*\.\s*)?"?${TABLE}"?\b`;
    const writeSql = new RegExp(String.raw`\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO)\s+${tableRef}`, 'i');
    const triggerSql = new RegExp(String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER[^;]*\bON\s+${tableRef}`, 'i');
    const offenders = sqlFiles.flatMap((name) => {
      const sql = fs.readFileSync(path.join(dir, name), 'utf8').replace(/--.*$/gm, '');
      return [
        ...(writeSql.test(sql) ? [`${name}: SQL で ${TABLE} に書いている`] : []),
        ...(triggerSql.test(sql) ? [`${name}: ${TABLE} にトリガーを作っている`] : []),
      ];
    });
    expect(offenders).toEqual([]);
  });
});
