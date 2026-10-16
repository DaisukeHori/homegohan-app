/**
 * #1193 / #1708 段 A: 送信待ち (email_outbox) の migration の静的な契約 (DB を使わない)
 *   supabase/migrations/20261016234000_email_outbox.sql と supabase/rollbacks/20261016234000_email_outbox.down.sql
 *   正典: docs/design/operator/10-logs-and-mail-retry.md §5 (表・RPC 8 本・prepare_account_deletion の段 1b・1c・pg_cron・ロールバック)
 *
 * 実 DB での挙動は tests/integration/rls/email-outbox.test.ts が確かめる。ここでは、SQL の形が正典から外れていないこと
 * (権限の完全形・伏せ字の条件・通知の数え方と印の付け方の条件の一致・prepare_account_deletion の本体の逐語) を見る。
 *
 * 段 A の時点では、アプリの定数 (src/lib/emails/outbox.ts の上限・既定、§9.2 の EMAIL_OUTBOX_REDACTED_EMAIL) はまだ木に無い
 * (段 B・C で足す)。そのため、アプリ側と突き合わせる値は、設計書 §6.1・§9.2 の値をこのファイルの定数 (DESIGN_*) に置いて比べる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectMigrationCronJobs } from './helpers/migration-cron-jobs';

const ROOT = path.resolve(__dirname, '..');
const VERSION = '20261016234000';
const MIGRATION_PATH = path.join(ROOT, 'supabase', 'migrations', `${VERSION}_email_outbox.sql`);
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${VERSION}_email_outbox.down.sql`);
const BASE_MIGRATION_PATH = path.join(ROOT, 'supabase', 'migrations', '20261010000100_auth_users_fk_on_delete.sql');
const CRON_DOC_PATH = path.join(ROOT, 'docs', 'design', 'operator', '08-cron-batches.md');

/** 設計書 §9.2 の EMAIL_OUTBOX_REDACTED_EMAIL (段 C で src/lib/super-admin/email-outbox.ts に置く値)・20261010000100 の c_masked_email */
const DESIGN_REDACTED_EMAIL = 'redacted@redacted.invalid';
/** 設計書 §6.1 の EMAIL_OUTBOX_MAX_ATTEMPTS_MAX (fail_email_outbox の上限と同じ) */
const DESIGN_MAX_ATTEMPTS_MAX = 20;
/** 設計書 §6.1 の EMAIL_OUTBOX_BATCH_SIZE (claim_email_outbox の p_limit の既定) と EMAIL_OUTBOX_BATCH_SIZE_MAX (上限) */
const DESIGN_BATCH_SIZE = 20;
const DESIGN_BATCH_SIZE_MAX = 100;
/** 設計書 §6.1 の EMAIL_OUTBOX_LEASE_SECONDS (claim_email_outbox の p_lease_seconds の既定) */
const DESIGN_LEASE_SECONDS = 120;
/** 設計書 §6.1 の EMAIL_OUTBOX_RETRY_DELAYS_SECONDS の最大 (4 時間)。fail_email_outbox の retry_after の上限 (7 日) に収まる */
const DESIGN_RETRY_DELAY_MAX_SECONDS = 14_400;
/** 設計書 §8 の通知の上位件数 (email_outbox_dead_counts / mark_email_outbox_dead_alerted の p_limit の既定) */
const DESIGN_DEAD_COUNT_LIMIT = 10;
/** 設計書 §14 の RPC 8 本 (名前 → 引数の型。REVOKE / GRANT / DROP の完全形と同じ) */
const RPC_SIGNATURES: Readonly<Record<string, string>> = {
  claim_email_outbox: 'TEXT, INTEGER, INTEGER',
  complete_email_outbox: 'UUID, TEXT, TEXT',
  fail_email_outbox: 'UUID, TEXT, TEXT, TEXT, INTEGER, BOOLEAN, INTEGER, INTEGER',
  requeue_email_outbox: 'UUID',
  email_outbox_dead_counts: 'INTEGER',
  cleanup_email_outbox: '',
  mark_email_outbox_dead_alerted: 'TIMESTAMPTZ, INTEGER',
  unmark_email_outbox_dead_alerted: 'TIMESTAMPTZ',
};
/** 設計書 §5.1 の列 (27 列) */
const TABLE_COLUMNS = [
  'id', 'created_at', 'updated_at', 'status', 'template', 'to_email', 'from_email', 'reply_to', 'subject', 'text_body',
  'html_body', 'user_id', 'idempotency_key', 'redact_after_send', 'attempts', 'requeue_count', 'next_attempt_at',
  'lease_expires_at', 'worker_id', 'last_error_code', 'last_error_message', 'last_status_code', 'sent_at',
  'resend_message_id', 'dead_at', 'requeued_at', 'dead_alerted_at',
] as const;
const INDEXES = [
  'idx_email_outbox_claim',
  'idx_email_outbox_status_created',
  'idx_email_outbox_dead_at',
  'idx_email_outbox_sent_at',
  'idx_email_outbox_user_id',
] as const;
/** 通知の数える条件 (§5.2 (5)) と印を付ける条件 (§5.2 (7)) に共通の 5 行 */
const DEAD_ALERT_CONDITIONS = [
  "o.status = 'dead'",
  'o.dead_alerted_at IS NULL',
  "o.last_error_code IS DISTINCT FROM 'suppressed'",
  "o.last_error_code IS DISTINCT FROM 'recipient_deleted'",
  "o.template NOT LIKE 'ops\\_%'",
] as const;

const migration = fs.readFileSync(MIGRATION_PATH, 'utf-8');
const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf-8');
const baseMigration = fs.readFileSync(BASE_MIGRATION_PATH, 'utf-8');

/** SQL の行コメント (--) を取り除く。コメントの中の語を拾わないように (文字列の中の -- はこの migration に無い) */
function stripLineComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

/** 空白を 1 つにそろえる (書式の差で比較が外れないように) */
function squash(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

const code = stripLineComments(migration);

/** CREATE OR REPLACE FUNCTION public.<name>( から、その関数の本体の終わり (END $$; または $function$;) まで */
function functionBlock(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} の CREATE OR REPLACE FUNCTION が無い`).toBeGreaterThanOrEqual(0);
  const ends = ['END $$;', '$function$;'].map((marker) => {
    const at = sql.indexOf(marker, start);
    return at < 0 ? Number.POSITIVE_INFINITY : at + marker.length;
  });
  const end = Math.min(...ends);
  expect(Number.isFinite(end), `${name} の本体の終わりが無い`).toBe(true);
  return sql.slice(start, end);
}

/** 関数の引数の宣言から型だけを取り出す ("p_id UUID, p_limit INTEGER DEFAULT 10" → "UUID, INTEGER") */
function argumentTypes(block: string): string {
  const open = block.indexOf('(');
  let depth = 0;
  let close = open;
  for (let i = open; i < block.length; i += 1) {
    if (block[i] === '(') depth += 1;
    if (block[i] === ')') depth -= 1;
    if (depth === 0) {
      close = i;
      break;
    }
  }
  const inner = block.slice(open + 1, close).trim();
  if (inner === '') return '';
  return inner
    .split(',')
    .map((arg) => squash(arg).split(' ')[1])
    .join(', ');
}

/** UPDATE ... SET の右辺の列名 (SET から WHERE まで) */
function setColumns(update: string): string[] {
  const set = /\bSET\b([\s\S]*?)\bWHERE\b/.exec(update);
  expect(set, 'UPDATE の SET が無い').not.toBeNull();
  return [...(set?.[1] ?? '').matchAll(/(?:^|,)\s*([a-z_]+)\s*=/g)].map((m) => m[1]);
}

/** prepare_account_deletion の 1 ブロック (CREATE から COMMENT ON FUNCTION の文の終わりまで) */
function prepareBlock(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.prepare_account_deletion(p_user_id uuid)');
  expect(start).toBeGreaterThanOrEqual(0);
  const comment = sql.indexOf('COMMENT ON FUNCTION public.prepare_account_deletion(uuid) IS', start);
  expect(comment).toBeGreaterThan(start);
  return sql.slice(start, sql.indexOf("';", comment) + 2);
}

/** prepare_account_deletion の関数の本体 (CREATE から $function$; まで) */
function prepareBody(sql: string): string {
  const block = prepareBlock(sql);
  return block.slice(0, block.indexOf('$function$;') + '$function$;'.length);
}

describe('#1193 email_outbox migration: ファイルの対', () => {
  it('migration と rollback が対 (同じ版・rollback は job の登録解除 → prepare_account_deletion の復元 → RPC 8 本 → 表の順に消す)', () => {
    expect(rollback.startsWith(`-- rollback: ${VERSION}_email_outbox.sql`)).toBe(true);
    const rollbackCode = stripLineComments(rollback);
    const steps = [
      rollbackCode.indexOf("jobname = 'cleanup-email-outbox'"),
      rollbackCode.indexOf('CREATE OR REPLACE FUNCTION public.prepare_account_deletion(p_user_id uuid)'),
      rollbackCode.indexOf('DROP FUNCTION IF EXISTS public.claim_email_outbox('),
      rollbackCode.indexOf('DROP TABLE IF EXISTS public.email_outbox;'),
    ];
    for (const step of steps) expect(step).toBeGreaterThanOrEqual(0);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    for (const [name, args] of Object.entries(RPC_SIGNATURES)) {
      expect(rollbackCode, `${name} の DROP`).toContain(`DROP FUNCTION IF EXISTS public.${name}(${args});`);
    }
    // 戻した prepare_account_deletion は 20261010000100 の定義 (REVOKE / GRANT / COMMENT まで) と同じ
    expect(prepareBlock(rollback)).toBe(prepareBlock(baseMigration));
    expect(rollbackCode).not.toContain('email_outbox_dead_counts(INTEGER) TO');
  });
});

describe('#1193 email_outbox migration: 表', () => {
  const table = functionlessTable();

  function functionlessTable(): string {
    const start = code.indexOf('CREATE TABLE IF NOT EXISTS public.email_outbox (');
    expect(start).toBeGreaterThanOrEqual(0);
    return code.slice(start, code.indexOf('\n);', start) + 3);
  }

  it('表の列 (27 列)・CHECK (email_outbox_status_times と email_outbox_dead_alerted_only_dead)・索引 5 本・RLS と完全形の REVOKE/GRANT', () => {
    const columns = table
      .split('\n')
      .slice(1)
      .map((line) => /^\s{2}([a-z_]+)\s+(?:UUID|TIMESTAMPTZ|TEXT|INTEGER|BOOLEAN)\b/.exec(line)?.[1])
      .filter((name): name is string => Boolean(name));
    expect(columns).toEqual([...TABLE_COLUMNS]);
    expect(squash(table)).toContain("status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'dead'))");
    expect(squash(table)).toContain('user_id UUID REFERENCES auth.users (id) ON DELETE SET NULL');
    expect(squash(table)).toContain(
      squash(`CONSTRAINT email_outbox_status_times CHECK (
       (status = 'queued' AND sent_at IS NULL AND dead_at IS NULL)
    OR (status = 'sent'   AND sent_at IS NOT NULL AND dead_at IS NULL)
    OR (status = 'dead'   AND dead_at IS NOT NULL AND sent_at IS NULL)
  )`),
    );
    expect(squash(table)).toContain("CONSTRAINT email_outbox_dead_alerted_only_dead CHECK (dead_alerted_at IS NULL OR status = 'dead')");
    for (const index of INDEXES) expect(code, index).toContain(`CREATE INDEX IF NOT EXISTS ${index}`);
    expect(code.match(/CREATE INDEX IF NOT EXISTS/g)).toHaveLength(INDEXES.length);
    expect(code).toContain('ALTER TABLE public.email_outbox ENABLE ROW LEVEL SECURITY;');
    expect(code).toContain('REVOKE ALL ON public.email_outbox FROM PUBLIC, anon, authenticated, service_role;');
    expect(code).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_outbox TO service_role;');
    expect(squash(code)).toContain(
      'CREATE POLICY email_outbox_deny_client_access ON public.email_outbox FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);',
    );
    // anon / authenticated に権限を付ける文が無い
    expect(code).not.toMatch(/GRANT[^;]*\bTO\s+(?:anon|authenticated|PUBLIC)\b/i);
  });
});

describe('#1193 email_outbox migration: RPC 8 本', () => {
  it('RPC 8 本が SECURITY INVOKER・search_path \'\'・service_role だけ (REVOKE / GRANT の引数の型が関数の定義と同じ)', () => {
    for (const [name, args] of Object.entries(RPC_SIGNATURES)) {
      const block = functionBlock(code, name);
      expect(argumentTypes(block), `${name} の引数の型`).toBe(args);
      expect(block, name).toMatch(/LANGUAGE plpgsql(?: STABLE)? SECURITY INVOKER SET search_path = '' AS \$\$/);
      expect(block, name).not.toContain('SECURITY DEFINER');
      expect(code, `${name} の REVOKE`).toContain(
        `REVOKE ALL ON FUNCTION public.${name}(${args}) FROM PUBLIC, anon, authenticated, service_role;`,
      );
      expect(code, `${name} の GRANT`).toContain(`GRANT EXECUTE ON FUNCTION public.${name}(${args}) TO service_role;`);
      expect(code, `${name} の COMMENT`).toContain(`COMMENT ON FUNCTION public.${name}(${args}) IS`);
    }
    // 関数は 8 本 + prepare_account_deletion だけ
    expect(code.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(Object.keys(RPC_SIGNATURES).length + 1);
  });

  it('claim が SKIP LOCKED で、queued・期日・リースの切れた行だけを取る。上限と既定は設計書 §6.1 の値', () => {
    const claim = functionBlock(code, 'claim_email_outbox');
    expect(claim).toContain('FOR UPDATE SKIP LOCKED');
    expect(claim).toContain("WHERE o.status = 'queued'");
    expect(claim).toContain('AND o.next_attempt_at <= pg_catalog.now()');
    expect(claim).toContain('AND (o.lease_expires_at IS NULL OR o.lease_expires_at <= pg_catalog.now())');
    expect(squash(claim)).toContain(`p_limit INTEGER DEFAULT ${DESIGN_BATCH_SIZE},`);
    expect(squash(claim)).toContain(`p_lease_seconds INTEGER DEFAULT ${DESIGN_LEASE_SECONDS} )`);
    expect(claim).toContain(`p_limit < 1 OR p_limit > ${DESIGN_BATCH_SIZE_MAX}`);
  });

  it('complete_email_outbox と fail_email_outbox と requeue_email_outbox の伏せ字 (c_masked_email) が設計書 §9.2 の EMAIL_OUTBOX_REDACTED_EMAIL・20261010000100 の値と同じ', () => {
    const declaration = `c_masked_email CONSTANT pg_catalog.text := '${DESIGN_REDACTED_EMAIL}';`;
    for (const name of ['complete_email_outbox', 'fail_email_outbox', 'requeue_email_outbox']) {
      expect(functionBlock(code, name), name).toContain(declaration);
    }
    expect(baseMigration).toContain(`c_masked_email   CONSTANT pg_catalog.text := '${DESIGN_REDACTED_EMAIL}';`);
    // complete は worker_id と queued のガードで、redact_after_send の行だけを伏せる
    const complete = functionBlock(code, 'complete_email_outbox');
    expect(complete).toContain("WHERE o.id = p_id AND o.worker_id = p_worker_id AND o.status = 'queued';");
    for (const column of ['to_email', 'subject', 'text_body', 'html_body']) {
      expect(complete, column).toMatch(new RegExp(`${column}\\s*= CASE WHEN o\\.redact_after_send THEN`));
    }
  });

  it('fail_email_outbox は dead にするときだけ redact_after_send の行の to_email・subject・text_body・html_body を伏せ、p_retryable の NULL を 22023 で断る', () => {
    const fail = functionBlock(code, 'fail_email_outbox');
    for (const column of ['to_email', 'subject', 'text_body', 'html_body']) {
      expect(squash(fail), column).toContain(
        `${column} = CASE WHEN o.redact_after_send AND NOT (p_retryable AND o.attempts + 1 < p_max_attempts) THEN`,
      );
    }
    expect(squash(fail)).toContain(
      "IF p_retryable IS NULL THEN RAISE EXCEPTION 'fail_email_outbox: invalid retryable' USING ERRCODE = '22023';",
    );
    expect(fail).toContain("WHERE o.id = p_id AND o.worker_id = p_worker_id AND o.status = 'queued'");
    expect(fail).toContain("RETURN COALESCE(v_status, 'ignored');");
    // アプリの上限・待ちと、DB の受け付ける範囲が合う (§6.1)
    expect(fail).toContain(`p_max_attempts < 1 OR p_max_attempts > ${DESIGN_MAX_ATTEMPTS_MAX}`);
    const retryMax = /p_retry_after_seconds > (\d+)/.exec(fail);
    expect(Number(retryMax?.[1])).toBeGreaterThanOrEqual(DESIGN_RETRY_DELAY_MAX_SECONDS);
  });

  it('email_outbox_dead_counts は窓を持たず (引数は p_limit だけ。make_interval を使わない)、status = dead と dead_alerted_at IS NULL で数え、suppressed / recipient_deleted / ops_ を除く', () => {
    const counts = functionBlock(code, 'email_outbox_dead_counts');
    expect(argumentTypes(counts)).toBe('INTEGER');
    expect(squash(counts)).toContain(`p_limit INTEGER DEFAULT ${DESIGN_DEAD_COUNT_LIMIT} )`);
    expect(counts).not.toContain('make_interval');
    expect(counts).not.toMatch(/interval/i);
    for (const condition of DEAD_ALERT_CONDITIONS) expect(counts, condition).toContain(condition);
  });

  it('mark_email_outbox_dead_alerted の UPDATE の WHERE は email_outbox_dead_counts の WHERE と同じ 5 つの条件で、SET は dead_alerted_at = p_alerted_at と updated_at だけ。unmark は dead_alerted_at = p_alerted_at の行だけを NULL に戻す', () => {
    const counts = functionBlock(code, 'email_outbox_dead_counts');
    const mark = functionBlock(code, 'mark_email_outbox_dead_alerted');
    const whereOf = (block: string, from: string, to: string) => {
      const start = block.indexOf('WHERE o.status', block.indexOf(from));
      return squash(block.slice(start, block.indexOf(to, start)));
    };
    const countsWhere = whereOf(counts, 'FROM public.email_outbox AS o', 'GROUP BY');
    const markWhere = whereOf(mark, 'UPDATE public.email_outbox AS o', 'RETURNING');
    expect(markWhere).toBe(countsWhere);
    expect(countsWhere).toBe(squash(`WHERE ${DEAD_ALERT_CONDITIONS.join(' AND ')}`));
    const update = mark.slice(mark.indexOf('UPDATE public.email_outbox'), mark.indexOf('RETURNING'));
    expect(setColumns(update)).toEqual(['dead_alerted_at', 'updated_at']);
    expect(update).toContain('SET dead_alerted_at = p_alerted_at');
    expect(squash(mark)).toContain(`p_limit INTEGER DEFAULT ${DESIGN_DEAD_COUNT_LIMIT} )`);

    const unmark = functionBlock(code, 'unmark_email_outbox_dead_alerted');
    const unmarkUpdate = unmark.slice(unmark.indexOf('UPDATE public.email_outbox'), unmark.indexOf('GET DIAGNOSTICS'));
    expect(setColumns(unmarkUpdate)).toEqual(['dead_alerted_at', 'updated_at']);
    expect(squash(unmarkUpdate)).toContain('SET dead_alerted_at = NULL');
    expect(squash(unmarkUpdate)).toContain('WHERE o.dead_alerted_at = p_alerted_at;');
    for (const name of ['mark_email_outbox_dead_alerted', 'unmark_email_outbox_dead_alerted']) {
      expect(squash(functionBlock(code, name)), name).toContain(
        `IF p_alerted_at IS NULL THEN RAISE EXCEPTION '${name}: invalid alerted_at' USING ERRCODE = '22023';`,
      );
    }
  });

  it('requeue_email_outbox は dead だけを戻し、伏せ字は redacted で断り、dead_alerted_at = NULL を SET する', () => {
    const requeue = functionBlock(code, 'requeue_email_outbox');
    expect(requeue).toContain("IF v_status <> 'dead' THEN RETURN 'not_dead'; END IF;");
    expect(requeue).toContain("IF v_to = c_masked_email THEN RETURN 'redacted'; END IF;");
    expect(requeue).toContain('dead_alerted_at = NULL');
    expect(requeue).toContain('attempts = 0');
    expect(requeue).toContain('requeue_count = o.requeue_count + 1');
  });

  it('cleanup_email_outbox は sent を 7 日・dead を 30 日で消し、queued は消さない', () => {
    const cleanup = functionBlock(code, 'cleanup_email_outbox');
    expect(cleanup).toContain("c_sent_retention CONSTANT pg_catalog.interval := interval '7 days';");
    expect(cleanup).toContain("c_dead_retention CONSTANT pg_catalog.interval := interval '30 days';");
    expect(cleanup).toContain("o.status = 'sent' AND o.sent_at < pg_catalog.now() - c_sent_retention");
    expect(cleanup).toContain("o.status = 'dead' AND o.dead_at < pg_catalog.now() - c_dead_retention");
    expect(cleanup).not.toContain("'queued'");
  });
});

describe('#1193 email_outbox migration: pg_cron', () => {
  it('pg_cron cleanup-email-outbox が 20 18 * * * (03:20 JST) で cleanup_email_outbox() を呼ぶ。cron.job が無ければ飛ばし、同名・同じ処理のジョブを先に登録解除する', () => {
    expect(squash(code)).toContain(
      "PERFORM cron.schedule( 'cleanup-email-outbox', '20 18 * * *', 'SELECT public.cleanup_email_outbox();' );",
    );
    expect(code).toContain("IF to_regclass('cron.job') IS NULL THEN");
    expect(code).toContain("WHERE jobname = 'cleanup-email-outbox'");
    expect(code).toContain("OR command ~* '[[:<:]]cleanup_email_outbox[[:>:]]'");
    const { names, unresolved } = collectMigrationCronJobs(path.join(ROOT, 'supabase', 'migrations'));
    expect(unresolved).toEqual([]);
    expect(names).toContain('cleanup-email-outbox');
  });

  it('08-cron-batches.md に cleanup-email-outbox と、登録した migration の版が書かれている', () => {
    const doc = fs.readFileSync(CRON_DOC_PATH, 'utf-8');
    expect(doc).toContain('cleanup-email-outbox');
    expect(doc).toContain(`${VERSION}_email_outbox.sql`);
  });
});

describe('#1193 email_outbox migration: prepare_account_deletion の段 1b・1c', () => {
  // 段の目印 (-- 1b) / -- 1c)) を使うので、コメントを残した migration から取り出す
  const body = prepareBody(migration);
  const block1b = body.slice(body.indexOf('-- 1b)'), body.indexOf('-- 1c)'));
  const block1c = body.slice(body.indexOf('-- 1c)'), body.indexOf('END IF;', body.indexOf('-- 1c)')) + 'END IF;'.length);

  it('prepare_account_deletion が 20261010000100 の本体を含み、email_outbox の段 (1b・1c)・変数 3 つ・戻り値のキーだけを足している (REVOKE / GRANT は同じ形)', () => {
    const added = [
      '  v_outbox          pg_catalog.int4 := 0;',
      '  v_outbox_mentions pg_catalog.int4 := 0;',
      '  v_email_pattern   pg_catalog.text;',
      "    'email_outbox', v_outbox,",
    ];
    let restored = body;
    // 足した段を外すと、20261010000100 の本体に戻る
    restored = restored.replace(block1b, '').replace(block1c, '');
    for (const line of added) {
      const at = restored.split('\n').findIndex((l) => l.startsWith(line));
      expect(at, `足した行が無い: ${line}`).toBeGreaterThanOrEqual(0);
      const lines = restored.split('\n');
      lines.splice(at, 1);
      restored = lines.join('\n');
    }
    expect(squash(stripLineComments(restored))).toBe(squash(stripLineComments(prepareBody(baseMigration))));
    // 段 1b・1c は 1) メール配信ログの直後、2) 問い合わせの前
    const order = ['GET DIAGNOSTICS v_delivery_logs = ROW_COUNT;', '-- 1b)', '-- 1c)', '-- 2) 問い合わせ'].map((m) => body.indexOf(m));
    for (const at of order) expect(at).toBeGreaterThanOrEqual(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(code).toContain('REVOKE ALL ON FUNCTION public.prepare_account_deletion(uuid) FROM PUBLIC, anon, authenticated, service_role;');
    expect(code).toContain('GRANT EXECUTE ON FUNCTION public.prepare_account_deletion(uuid) TO service_role;');
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain("SET search_path = ''");
  });

  it('1b: 本人の行 (user_id か宛先が一致) の宛先・件名・本文を伏せ、queued を dead (recipient_deleted) にする', () => {
    expect(squash(block1b)).toContain(
      'WHERE (o.user_id = p_user_id OR pg_catalog.lower(o.to_email) = ANY (v_emails)) AND o.to_email <> c_masked_email;',
    );
    expect(squash(block1b)).toContain("status = CASE WHEN o.status = 'queued' THEN 'dead' ELSE o.status END");
    expect(squash(block1b)).toContain(
      "last_error_code = CASE WHEN o.status = 'queued' THEN 'recipient_deleted' ELSE o.last_error_code END",
    );
    expect(block1b).toContain('GET DIAGNOSTICS v_outbox = ROW_COUNT;');
  });

  it("1c: 件名・本文・HTML・返信先を regexp_replace(…, 'gi') で伏せ、照合の正規表現は本人のアドレスの英数字以外を \\ でエスケープして | でつなぐ。1c の UPDATE は status・attempts・next_attempt_at・worker_id・lease_expires_at・idempotency_key・to_email を SET しない", () => {
    expect(block1c).toContain(
      "SELECT pg_catalog.string_agg(pg_catalog.regexp_replace(e.addr, '([^[:alnum:]])', '\\\\\\1', 'g'), '|')",
    );
    expect(block1c).toContain('FROM pg_catalog.unnest(v_emails) AS e(addr);');
    for (const column of ['subject', 'text_body', 'html_body', 'reply_to']) {
      expect(squash(block1c), column).toContain(
        `${column} = pg_catalog.regexp_replace(o.${column}, v_email_pattern, c_masked_email, 'gi')`,
      );
      expect(block1c, column).toContain(`o.${column} ~* v_email_pattern`);
    }
    const update = block1c.slice(block1c.indexOf('UPDATE public.email_outbox'), block1c.indexOf('GET DIAGNOSTICS'));
    expect(setColumns(update)).toEqual(['subject', 'text_body', 'html_body', 'reply_to', 'updated_at']);
    expect(update).toContain('WHERE o.to_email <> c_masked_email');
    expect(block1c).toContain('IF v_email_pattern IS NOT NULL THEN');
    expect(block1c).toContain('v_outbox := v_outbox + v_outbox_mentions;');
    // 照合に使う本人のアドレスは空文字を含まない (空の選択肢を持つ正規表現はどこにでも当たる)
    expect(body).toContain("WHERE s.email IS NOT NULL AND s.email <> '';");
  });
});
