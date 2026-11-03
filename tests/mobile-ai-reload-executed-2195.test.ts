/**
 * #2195 V3: モバイルの AI 相談のシートが、応答 (SSE の finalData) を受け取れずに会話を取り直したとき、
 * 送った文への返答の提案が自動で実行されていたかを、提案の記録 (ai_action_logs) の状態で見分ける
 * (apps/mobile/src/lib/ai-chat-timeout.ts の hasExecutedActionLog・AIAdvisorSheet.tsx の replyActionStateOf。#2201 U3 で決まりを packages/shared へ移した)。
 *
 * ここではサーバーの側の前提を確かめる:
 *   1. モバイルが見る「実行できた」の値は、サーバーが行に書く値 (AI_ACTION_LOG_STATUS.executed) と同じ
 *   2. 会話の GET は、実行できた提案と断った提案を同じ「出さない」(hidden) にする (GET だけでは実行できたかを見分けられない。
 *      モバイルが記録を読む理由)
 *   3. ai_action_logs は RLS が有効で、利用者 (authenticated) は自分の相談の行を読める (モバイルの読み取りが通る)。
 *      後の migration でこの読み取りを外していない
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { AI_ACTION_LOG_STATUS, proposedActionViewOf } from '@/lib/ai/consultation-action-lifecycle';

import { AI_ACTION_LOG_STATUS_EXECUTED, hasExecutedActionLog } from '../apps/mobile/src/lib/ai-chat-timeout';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const BASELINE_MIGRATION = '20251126124224_create_meal_planner_tables.sql';
const AI_ACTION_LOGS_OWNER_POLICY = 'Users can manage actions in own sessions';

describe('#2195 V3: モバイルが見る提案の記録の「実行できた」はサーバーの値と同じ', () => {
  it('AI_ACTION_LOG_STATUS_EXECUTED === AI_ACTION_LOG_STATUS.executed', () => {
    expect(AI_ACTION_LOG_STATUS_EXECUTED).toBe(AI_ACTION_LOG_STATUS.executed);
  });

  it('サーバーのほかの状態 (実行を待つ・実行中・失敗・断った) は「実行できた」と読まない', () => {
    for (const status of Object.values(AI_ACTION_LOG_STATUS).filter((value) => value !== AI_ACTION_LOG_STATUS.executed)) {
      expect(hasExecutedActionLog([{ status }]), status).toBe(false);
    }
    expect(hasExecutedActionLog([{ status: AI_ACTION_LOG_STATUS.executed }])).toBe(true);
  });

  it('会話の GET は、実行できた提案と断った提案を同じ「出さない」にする (GET だけでは見分けられない)', () => {
    expect(proposedActionViewOf([AI_ACTION_LOG_STATUS.executed])).toBe('hidden');
    expect(proposedActionViewOf([AI_ACTION_LOG_STATUS.rejected])).toBe('hidden');
  });
});

describe('#2195 V3: 利用者は自分の相談の提案の記録を読める (RLS)', () => {
  const baseline = fs.readFileSync(path.join(MIGRATIONS_DIR, BASELINE_MIGRATION), 'utf8');

  it('ai_action_logs は RLS が有効で、自分の相談の行だけの決まりが authenticated にある', () => {
    expect(baseline).toContain('ALTER TABLE "public"."ai_action_logs" ENABLE ROW LEVEL SECURITY;');
    const policy = new RegExp(
      `CREATE POLICY "${AI_ACTION_LOGS_OWNER_POLICY}" ON "public"\\."ai_action_logs" TO "authenticated" USING \\(\\(EXISTS \\( SELECT 1\\s+FROM "public"\\."ai_consultation_sessions"\\s+WHERE \\(\\("ai_consultation_sessions"\\."id" = "ai_action_logs"\\."session_id"\\) AND \\("ai_consultation_sessions"\\."user_id" = "auth"\\."uid"\\(\\)\\)\\)\\)\\)\\)`,
    );
    expect(baseline).toMatch(policy);
    expect(baseline).toMatch(/GRANT [A-Z, ]*\bSELECT\b[A-Z, ]* ON TABLE public\."ai_action_logs" TO "authenticated";/);
  });

  it('後の migration で、ai_action_logs の決まりを消したり authenticated の読み取りを外したりしていない', () => {
    const later = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql') && name > BASELINE_MIGRATION)
      .sort();
    expect(later.length).toBeGreaterThan(0);
    const offending = later.filter((name) => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8').replace(/--[^\n]*/g, '');
      return (
        /DROP\s+POLICY[^;]*ai_action_logs/i.test(sql) ||
        /REVOKE[^;]*ON\s+(?:TABLE\s+)?(?:"?public"?\.)?"?ai_action_logs"?[^;]*FROM[^;]*authenticated/i.test(sql) ||
        /ALTER\s+TABLE[^;]*ai_action_logs[^;]*DISABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(sql)
      );
    });
    expect(offending).toEqual([]);
  });
});
