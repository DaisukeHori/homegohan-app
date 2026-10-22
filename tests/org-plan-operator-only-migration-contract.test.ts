/**
 * #1912 組織のプランの段階は運営だけが変える: migration 20261022170000_org_plan_operator_only.sql と戻し口の contract テスト
 * (DB を使わない静的な検査。DB の上の挙動は tests/integration/rls/ai-plan-feature-caps-rpc.test.ts が owner / admin の JWT と
 * service_role で確かめる)
 *
 * 確かめること:
 *   1. migration は、トリガー関数 guard_organizations_plan_value の本体と説明だけを作り直す
 *      (関数の本体の外の文は SET LOCAL lock_timeout・CREATE OR REPLACE FUNCTION・COMMENT ON FUNCTION の 3 つだけ。
 *      トリガー・権限 (REVOKE / GRANT)・データは触らない。消さない)
 *   2. 本体は、ログインした利用者 (authenticated) と anon が plan を変えるとき、値に関わらず ORG_PLAN_OPERATOR_ONLY (42501) で拒む。
 *      service_role・SECURITY DEFINER の中・plan を変えない UPDATE は通す (止める条件は current_user と IS DISTINCT FROM だけ)
 *   3. この関数の最後の定義は本 migration (後の migration が作り直していない)
 *   4. 戻し口は、関数の定義と説明を、直前の定義 (20261021110000_org_plan_ai_daily_limits.sql) と逐語で同じものに戻す。
 *      トリガーと関数を消さない (消すのは 20261021110000 の戻し口の役目)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = 'supabase/migrations';
const OURS = '20261022170000_org_plan_operator_only';
const OUR_MIGRATION = `${MIGRATIONS_DIR}/${OURS}.sql`;
const OUR_ROLLBACK = `supabase/rollbacks/${OURS}.down.sql`;
/** この migration の直前の定義 (戻し口が逐語で戻す先) */
const PREVIOUS_DEFINITION = `${MIGRATIONS_DIR}/20261021110000_org_plan_ai_daily_limits.sql`;

const FUNCTION_NAME = 'guard_organizations_plan_value';
const TRIGGER_NAME = 'trg_guard_organizations_plan_value';
const FUNCTION_HEAD = `CREATE OR REPLACE FUNCTION public.${FUNCTION_NAME}()`;
const COMMENT_HEAD = `COMMENT ON FUNCTION public.${FUNCTION_NAME}() IS`;

const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');
/** `--` から行末までのコメントを除く (ここで読む SQL の文の部分は文字列の中に `--` を書いていない) */
const stripSqlLineComments = (sql: string): string => sql.replace(/--[^\n]*/g, '');
/** 空白を 1 つに詰める */
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();
/** ドル引用の本体 ($$ … $$) を空にする (関数の本体の外の文だけを見るため) */
const withoutBodies = (sql: string): string => sql.replace(/\$\$[\s\S]*?\$\$/g, '$$$$');
/** 文 (関数の本体の外・コメントを除く・空白を詰める) */
const statementsOf = (relative: string): string[] =>
  withoutBodies(stripSqlLineComments(read(relative)))
    .split(';')
    .map(squash)
    .filter((statement) => statement.length > 0);

/** 関数の定義の原文 (`CREATE OR REPLACE FUNCTION …` から `END $$;` まで。コメント・改行もそのまま) */
function functionDefinitionOf(relative: string): string {
  const sql = read(relative);
  const at = sql.indexOf(FUNCTION_HEAD);
  expect(at, `${relative} に ${FUNCTION_HEAD}`).toBeGreaterThan(-1);
  const end = sql.indexOf('END $$;', at);
  expect(end, `${relative} の関数の終わり`).toBeGreaterThan(at);
  return sql.slice(at, end + 'END $$;'.length);
}

/** 説明 (COMMENT ON FUNCTION) の原文 (文の終わりの `;` まで。説明の文字列の中に `;` は無い) */
function commentStatementOf(relative: string): string {
  const sql = read(relative);
  const at = sql.indexOf(COMMENT_HEAD);
  expect(at, `${relative} に ${COMMENT_HEAD}`).toBeGreaterThan(-1);
  return sql.slice(at, sql.indexOf(';', at) + 1);
}

/** 関数の本体 ($$ の中) を、コメントを除き空白を詰めたもの */
function bodyOf(relative: string): string {
  const definition = functionDefinitionOf(relative);
  return squash(stripSqlLineComments(definition.slice(definition.indexOf('$$') + 2, definition.lastIndexOf('$$'))));
}

const migrationFiles = fs
  .readdirSync(path.join(ROOT, MIGRATIONS_DIR))
  .filter((name) => /^\d{14}_.+\.sql$/.test(name))
  .sort();

describe('#1912 migration 20261022170000_org_plan_operator_only.sql', () => {
  it('outside the function body, the migration only sets the lock timeout, replaces the trigger function and its comment (no trigger, privilege or data change)', () => {
    const statements = statementsOf(OUR_MIGRATION);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '10s'");
    expect(statements[1]).toBe(
      `CREATE OR REPLACE FUNCTION public.${FUNCTION_NAME}() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$`,
    );
    expect(statements[2].startsWith(COMMENT_HEAD)).toBe(true);
    expect(statements[2]).toContain('ORG_PLAN_OPERATOR_ONLY (42501)');
    for (const statement of statements) {
      expect(statement).not.toMatch(/^(DROP|REVOKE|GRANT|ALTER|INSERT|UPDATE|DELETE|CREATE (OR REPLACE )?TRIGGER)\b/i);
    }
  });

  it('the body rejects every plan change by authenticated / anon with ORG_PLAN_OPERATOR_ONLY (42501), whatever the new value, and lets everything else through', () => {
    expect(bodyOf(OUR_MIGRATION)).toBe(
      "BEGIN IF current_user IN ('authenticated', 'anon') AND NEW.plan IS DISTINCT FROM OLD.plan THEN RAISE EXCEPTION 'ORG_PLAN_OPERATOR_ONLY' USING ERRCODE = '42501'; END IF; RETURN NEW; END",
    );
    // 値の一覧 (ORG_PLAN_VALUES) で通す枝は無い
    expect(bodyOf(OUR_MIGRATION)).not.toMatch(/NOT IN|'standard'|'premium'|'enterprise'/);
  });

  it('is the latest definition of the trigger function, and no migration recreates or drops the trigger after the first one', () => {
    const definers = migrationFiles.filter((file) => read(`${MIGRATIONS_DIR}/${file}`).includes(FUNCTION_HEAD));
    expect(definers[definers.length - 1]).toBe(`${OURS}.sql`);
    const triggerCreators = migrationFiles.filter((file) =>
      statementsOf(`${MIGRATIONS_DIR}/${file}`).some((statement) => /^CREATE (OR REPLACE )?TRIGGER\b/i.test(statement) && statement.includes(TRIGGER_NAME)),
    );
    expect(triggerCreators).toEqual(['20261021110000_org_plan_ai_daily_limits.sql']);
    const droppers = migrationFiles.filter((file) =>
      statementsOf(`${MIGRATIONS_DIR}/${file}`).some(
        (statement) => /^DROP (TRIGGER|FUNCTION)\b/i.test(statement) && (statement.includes(FUNCTION_NAME) || statement.includes(TRIGGER_NAME)),
      ),
    );
    expect(droppers).toEqual([]);
  });

  it('the rollback restores the previous definition and comment verbatim (20261021110000), and does not drop the trigger or the function', () => {
    expect(functionDefinitionOf(OUR_ROLLBACK)).toBe(functionDefinitionOf(PREVIOUS_DEFINITION));
    expect(commentStatementOf(OUR_ROLLBACK)).toBe(commentStatementOf(PREVIOUS_DEFINITION));

    const statements = statementsOf(OUR_ROLLBACK);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '10s'");
    expect(statements[1].startsWith(FUNCTION_HEAD)).toBe(true);
    expect(statements[2].startsWith(COMMENT_HEAD)).toBe(true);
    // 戻した本体は、値を ORG_PLAN_VALUES に限る形 (変えること自体は止めない)
    expect(bodyOf(OUR_ROLLBACK)).toContain("RAISE EXCEPTION 'ORG_PLAN_NOT_ALLOWED' USING ERRCODE = '42501'");
    expect(bodyOf(OUR_ROLLBACK)).not.toContain('ORG_PLAN_OPERATOR_ONLY');
  });
});
