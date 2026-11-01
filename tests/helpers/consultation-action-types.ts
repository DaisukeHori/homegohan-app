/**
 * AI 相談の提案の種類を、ソースから読み取る (#2189 W1。DB を使わない)。
 *
 * 種類の一覧は 3 か所にある。どれかに足し忘れると、利用者に見える形で壊れる:
 *   - 実行の側: src/lib/ai/consultation-action-executor.ts の runConsultationAction の case
 *   - 画面の名前: src/components/AIChatBubble.tsx の ACTION_LABELS (無いと、カードの見出しに英字の種類名が出る)
 *   - 記録の制約: ai_action_logs の CHECK 制約 ai_action_logs_action_type_check (無いと行を作れず、実行されない)
 * tests/ai-action-type-registry-2189.test.ts と tests/integration/rls/ai-action-logs-action-type.test.ts が使う。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
export const CONSULTATION_ACTION_EXECUTOR_FILE = path.join(ROOT, 'src', 'lib', 'ai', 'consultation-action-executor.ts');
export const AI_CHAT_BUBBLE_FILE = path.join(ROOT, 'src', 'components', 'AIChatBubble.tsx');
export const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');

/** 種類の制約の名前 */
export const AI_ACTION_LOGS_ACTION_TYPE_CHECK = 'ai_action_logs_action_type_check';
/** generate_single_meal を制約に足した migration の名前 (版の番号を除く) */
export const AI_ACTION_LOGS_ACTION_TYPE_MIGRATION_NAME = 'ai_action_logs_action_type_generate_single_meal';
/** 種類の制約に合わない値を書いたときの SQLSTATE (check_violation) */
export const CHECK_VIOLATION_SQLSTATE = '23514';

/** 実行の関数の見出し (ここから後ろの case を数える) */
const EXECUTOR_FUNCTION_HEAD = 'export async function runConsultationAction(';
const EXECUTOR_CASE = /^\s*case '([a-z_]+)':/gm;
const ACTION_LABELS_HEAD = 'const ACTION_LABELS';
const ACTION_LABELS_KEY = /^\s*([a-z_]+):\s*\{\s*label:/gm;
const CHECK_TYPE_LITERAL = /'([a-z_]+)'::text/g;
/** ADD CONSTRAINT ai_action_logs_action_type_check の文 (終わりの ; まで) */
const ADD_CHECK_STATEMENT = new RegExp(`ADD\\s+CONSTRAINT\\s+"?${AI_ACTION_LOGS_ACTION_TYPE_CHECK}"?\\s+CHECK\\s*\\(([\\s\\S]*?)\\)\\s*(?:NOT\\s+VALID\\s*)?;`, 'gi');
const SQL_LINE_COMMENT = /--[^\n]*/g;

function matchAll(text: string, pattern: RegExp): string[] {
  return Array.from(text.matchAll(pattern), (m) => m[1]);
}

/** 実行の側 (runConsultationAction の switch) の種類 (書かれた順) */
export function executorActionTypes(): string[] {
  const source = fs.readFileSync(CONSULTATION_ACTION_EXECUTOR_FILE, 'utf8');
  const start = source.indexOf(EXECUTOR_FUNCTION_HEAD);
  if (start < 0) throw new Error(`${EXECUTOR_FUNCTION_HEAD} が見つからない`);
  return matchAll(source.slice(start), EXECUTOR_CASE);
}

/** 画面の ACTION_LABELS の鍵 (書かれた順) */
export function actionLabelKeys(): string[] {
  const source = fs.readFileSync(AI_CHAT_BUBBLE_FILE, 'utf8');
  const start = source.indexOf(ACTION_LABELS_HEAD);
  if (start < 0) throw new Error(`${ACTION_LABELS_HEAD} が見つからない`);
  const end = source.indexOf('\n};', start);
  if (end < 0) throw new Error('ACTION_LABELS の終わりが見つからない');
  return matchAll(source.slice(start, end), ACTION_LABELS_KEY);
}

/**
 * migration を番号順に流したあとの、種類の制約が許す種類 (最後に制約を作った migration の一覧)。
 * 見つからなければ例外 (読み取りが壊れて素通りしないように)
 */
export function latestAiActionLogsActionTypeCheck(): { migration: string; types: string[] } {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort();
  let latest: { migration: string; types: string[] } | null = null;
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8').replace(SQL_LINE_COMMENT, '');
    const statements = Array.from(sql.matchAll(ADD_CHECK_STATEMENT), (m) => m[1]);
    const inlineIndex = sql.indexOf(`CONSTRAINT "${AI_ACTION_LOGS_ACTION_TYPE_CHECK}" CHECK`);
    if (statements.length > 0) {
      latest = { migration: file, types: matchAll(statements[statements.length - 1], CHECK_TYPE_LITERAL) };
    } else if (inlineIndex >= 0) {
      // ベースライン (CREATE TABLE の中の制約。"..."::"text" の形)
      const rest = sql.slice(inlineIndex);
      const body = rest.slice(0, rest.indexOf(')))'));
      latest = { migration: file, types: matchAll(body, /'([a-z_]+)'::"text"/g) };
    }
  }
  if (!latest) throw new Error(`${AI_ACTION_LOGS_ACTION_TYPE_CHECK} を作る migration が見つからない`);
  return latest;
}
