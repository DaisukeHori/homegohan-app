/**
 * #1136 Push 通知の送信待ち (supabase/migrations/<番号>_push_outbox.sql) の静的な突き合わせ (DB 無し。SQL の文面を読む。
 * 設計 docs/design/mobile/06-push-send.md §5・§10)
 *
 * 確かめること:
 *   - 表・索引 7 本・ポリシー・RPC 8 本・トリガー関数とトリガーが migration にある
 *   - RPC 8 本は SECURITY INVOKER・search_path ''・EXECUTE は service_role だけ (REVOKE は完全形)
 *   - トリガー関数は SECURITY DEFINER・search_path ''・EXECUTE を誰にも付けない (anon-definer-execute の番兵の対象)
 *   - down.sql がトリガー・関数 9 本・表を全部消す
 *   - トリガーの定型の文 (c_cancelled_message / c_stale_message) が Edge Function と共用の stored-failure-messages.ts と同じ値
 *   - token の長さの上限 (enqueue の c_max_token_chars と push_outbox.expo_push_token の CHECK) が src/lib/push-tokens.ts の
 *     MAX_EXPO_PUSH_TOKEN_LENGTH と同じ
 * 実 DB での確認は tests/integration/rls/push-outbox.test.ts。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_EXPO_PUSH_TOKEN_LENGTH } from '@/lib/push-tokens';
import {
  MENU_REQUEST_CANCELLED_MESSAGE,
  MENU_REQUEST_STALE_MESSAGE,
} from '../supabase/functions/_shared/stored-failure-messages';

const ROOT = path.resolve(__dirname, '..');
const NAME = 'push_outbox';

function findOne(dir: string, pattern: RegExp): string {
  const files = fs.readdirSync(path.join(ROOT, dir)).filter((f) => pattern.test(f));
  expect(files).toHaveLength(1);
  return path.join(ROOT, dir, files[0]);
}

/** SQL のコメント (-- から行末) を外す。説明文の中の語に当たらないようにする */
function stripSqlComments(sql: string): string {
  return sql.replace(/--.*$/gm, '');
}

const migrationPath = findOne('supabase/migrations', new RegExp(`^\\d{14}_${NAME}\\.sql$`));
const rollbackPath = findOne('supabase/rollbacks', new RegExp(`^\\d{14}_${NAME}\\.down\\.sql$`));
const migration = stripSqlComments(fs.readFileSync(migrationPath, 'utf8'));
const rollback = stripSqlComments(fs.readFileSync(rollbackPath, 'utf8'));

/** 空白を 1 つにそろえる */
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
const migrationFlat = squash(migration);

/** 送信待ちの RPC 8 本 (名前 → 引数の型の並び。REVOKE / GRANT / DROP FUNCTION で書く形) */
const RPC_SIGNATURES: Readonly<Record<string, string>> = {
  enqueue_push_notification: 'uuid, text, jsonb, text',
  claim_push_outbox: 'text, integer, integer',
  complete_push_outbox: 'uuid, text, text',
  fail_push_outbox: 'uuid, text, text, text, integer, boolean, integer, integer',
  defer_push_outbox: 'uuid, text, timestamptz',
  claim_push_receipts: 'text, integer, integer, integer',
  record_push_receipt: 'uuid, text, text, text',
  cleanup_push_outbox: '',
};
const RPC_NAMES = Object.keys(RPC_SIGNATURES);
const TRIGGER_FUNCTION = 'enqueue_weekly_menu_result_push';
const TRIGGER_NAME = 'weekly_menu_requests_enqueue_push';
const INDEXES = [
  'idx_push_outbox_claim',
  'idx_push_outbox_receipt_pending',
  'idx_push_outbox_sent_at',
  'idx_push_outbox_dead_at',
  'idx_push_outbox_user_id',
  'idx_push_outbox_push_token_id',
  'idx_push_outbox_dedupe_key',
] as const;
const ALL_ROLES = 'PUBLIC, anon, authenticated, service_role';

/** CREATE OR REPLACE FUNCTION public.<name>( から AS $$ までの宣言部 (空白を 1 つにそろえる) */
function functionHeader(name: string): string {
  const m = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(([\\s\\S]*?)AS \\$\\$`).exec(migration);
  expect(m, `${name} の CREATE OR REPLACE FUNCTION`).not.toBeNull();
  return squash(m?.[1] ?? '');
}

/** CREATE OR REPLACE FUNCTION public.<name>( の本体 ($$ と $$ のあいだ) */
function functionBody(name: string): string {
  const m = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`).exec(migration);
  expect(m, `${name} の本体`).not.toBeNull();
  return m?.[1] ?? '';
}

/** 関数の DECLARE にある定数 (<名前> CONSTANT <型> := <値>;) の値の式 */
function constantOf(name: string, constant: string): string {
  const m = new RegExp(`\\b${constant}\\s+CONSTANT\\s+\\w+\\s*:=\\s*([^;]+);`).exec(functionBody(name));
  expect(m, `${name} の ${constant}`).not.toBeNull();
  return (m?.[1] ?? '').trim();
}

/** SQL の文字列リテラル ('…') の中身 ('' は ' に戻す) */
function sqlStringLiteral(expr: string): string {
  const m = /^'((?:[^']|'')*)'$/.exec(expr);
  expect(m, `文字列リテラルでない: ${expr}`).not.toBeNull();
  return (m?.[1] ?? '').replace(/''/g, "'");
}

describe('push_outbox の migration (表・索引・ポリシー・RPC 8 本・トリガー)', () => {
  it('migration と down の番号が同じ', () => {
    expect(path.basename(rollbackPath).replace('.down.sql', '.sql')).toBe(path.basename(migrationPath));
  });

  it('表・索引・ポリシー・RPC 8 本・トリガーが migration にある', () => {
    expect(migrationFlat).toContain('CREATE TABLE IF NOT EXISTS public.push_outbox (');
    expect(migrationFlat).toContain('user_id UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE');
    expect(migrationFlat).toContain('push_token_id UUID NOT NULL REFERENCES public.user_push_tokens (id) ON DELETE CASCADE');
    expect(migrationFlat).toContain('CONSTRAINT push_outbox_status_times CHECK');
    expect(migrationFlat).toContain('CONSTRAINT push_outbox_receipt_consistency CHECK');
    for (const index of INDEXES) {
      expect(migrationFlat, index).toMatch(new RegExp(`CREATE (UNIQUE )?INDEX IF NOT EXISTS ${index} ON public\\.push_outbox `));
    }
    expect(migrationFlat).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_push_outbox_dedupe_key ON public.push_outbox (dedupe_key) WHERE dedupe_key IS NOT NULL',
    );
    expect(migrationFlat).toContain('ALTER TABLE public.push_outbox ENABLE ROW LEVEL SECURITY');
    expect(migrationFlat).toContain(
      'CREATE POLICY push_outbox_deny_client_access ON public.push_outbox FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)',
    );
    const created = [...migration.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((m) => m[1]).sort();
    expect(created).toEqual([...RPC_NAMES, TRIGGER_FUNCTION].sort());
    expect(migrationFlat).toContain(
      `CREATE TRIGGER ${TRIGGER_NAME} AFTER UPDATE OF status ON public.weekly_menu_requests FOR EACH ROW ` +
        `WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('completed', 'failed')) ` +
        `EXECUTE FUNCTION public.${TRIGGER_FUNCTION}()`,
    );
  });

  it('表は service_role だけが読み書きできる (REVOKE は完全形・GRANT は service_role だけ)', () => {
    expect(migrationFlat).toContain(`REVOKE ALL ON public.push_outbox FROM ${ALL_ROLES}`);
    const tableGrants = [...migrationFlat.matchAll(/GRANT ([A-Z, ]+) ON public\.push_outbox TO (\w+)/g)];
    expect(tableGrants.map((m) => `${m[1]}→${m[2]}`)).toEqual(['SELECT, INSERT, UPDATE, DELETE→service_role']);
  });

  it("RPC は SECURITY INVOKER・search_path ''・EXECUTE は service_role だけ", () => {
    for (const name of RPC_NAMES) {
      const header = functionHeader(name);
      expect(header, name).toMatch(/LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''$/);
      expect(header, name).not.toContain('SECURITY DEFINER');
      const signature = RPC_SIGNATURES[name];
      expect(migrationFlat, `${name} の REVOKE`).toContain(
        `REVOKE ALL ON FUNCTION public.${name}(${signature}) FROM ${ALL_ROLES};`,
      );
      const grants = [...migrationFlat.matchAll(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(([^)]*)\\) TO ([\\w, ]+);`, 'g'))];
      expect(grants.map((m) => `${m[1]}→${m[2]}`), `${name} の GRANT`).toEqual([`${signature}→service_role`]);
    }
  });

  it('トリガー関数は SECURITY DEFINER で EXECUTE を誰にも付けない', () => {
    const header = functionHeader(TRIGGER_FUNCTION);
    expect(header).toMatch(/^\) RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''$/);
    expect(migrationFlat).toContain(`REVOKE ALL ON FUNCTION public.${TRIGGER_FUNCTION}() FROM ${ALL_ROLES};`);
    expect(migrationFlat).not.toMatch(new RegExp(`GRANT [A-Z ]+ON FUNCTION public\\.${TRIGGER_FUNCTION}\\(`));
    // 登録の失敗で献立の最終の書き込みを止めない (R-02): 例外は WARNING にして NEW を返す
    expect(squash(functionBody(TRIGGER_FUNCTION))).toMatch(/EXCEPTION WHEN OTHERS THEN RAISE WARNING .+; RETURN NEW; END;$/);
  });

  it('down.sql が全部を消す', () => {
    const statements = rollback
      .split(';')
      .map(squash)
      .filter(Boolean);
    const expected = [
      `DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON public.weekly_menu_requests`,
      `DROP FUNCTION IF EXISTS public.${TRIGGER_FUNCTION}()`,
      ...RPC_NAMES.map((name) => `DROP FUNCTION IF EXISTS public.${name}(${RPC_SIGNATURES[name]})`),
      'DROP TABLE IF EXISTS public.push_outbox',
    ];
    expect([...statements].sort()).toEqual([...expected].sort());
    // トリガーは関数より先に、表は最後に消す
    expect(statements[0]).toBe(expected[0]);
    expect(statements[statements.length - 1]).toBe('DROP TABLE IF EXISTS public.push_outbox');
  });

  it('トリガーの c_cancelled_message / c_stale_message が stored-failure-messages.ts の MENU_REQUEST_CANCELLED_MESSAGE / MENU_REQUEST_STALE_MESSAGE と同じ値', () => {
    expect(sqlStringLiteral(constantOf(TRIGGER_FUNCTION, 'c_cancelled_message'))).toBe(MENU_REQUEST_CANCELLED_MESSAGE);
    expect(sqlStringLiteral(constantOf(TRIGGER_FUNCTION, 'c_stale_message'))).toBe(MENU_REQUEST_STALE_MESSAGE);
    const body = squash(functionBody(TRIGGER_FUNCTION));
    expect(body).toContain("IF NEW.status = 'failed' AND NEW.error_message IN (c_cancelled_message, c_stale_message) THEN RETURN NEW; END IF;");
  });

  it('enqueue の c_max_token_chars と push_outbox.expo_push_token の CHECK の上限 (256) が src/lib/push-tokens.ts の MAX_EXPO_PUSH_TOKEN_LENGTH と同じ', () => {
    expect(Number(constantOf('enqueue_push_notification', 'c_max_token_chars'))).toBe(MAX_EXPO_PUSH_TOKEN_LENGTH);
    const check = /expo_push_token TEXT NOT NULL CHECK \(char_length\(expo_push_token\) BETWEEN 1 AND (\d+)\)/.exec(migrationFlat);
    expect(check).not.toBeNull();
    expect(Number(check?.[1])).toBe(MAX_EXPO_PUSH_TOKEN_LENGTH);
    expect(squash(functionBody('enqueue_push_notification'))).toContain(
      'AND char_length(t.expo_push_token) BETWEEN 1 AND c_max_token_chars',
    );
  });
});
