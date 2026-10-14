/**
 * #1524 (#1498 の整合ゲートの残り) の回帰テスト。
 *
 * 1. 運営の LLM 使用量の画面 (src/app/super-admin/llm/page.tsx) は、anomalies の各要素に応答に無い daily_requests が
 *    あると宣言していた (応答は requests / cost_usd / is_anomaly)。画面の型は route が返す型 (LlmUsageResponseData) を
 *    そのまま使い、別の型を書かない。
 * 2. 献立生成の「1日だけ」の上限 (今日から 30 日先。説明「今日から1ヶ月先まで」) は、@homegohan/shared の
 *    menu-generation-range に置き、Web の日付の欄 (input の max) とモバイルの欄の確定 (commitSingleDayInput) が同じ値を使う。
 *    モバイルの確定のときの挙動 (上限より先は上限に収める・下限は今日) は apps/mobile の jest
 *    (__tests__/menus-weekly/v4-generate-modal-range-max.test.tsx) で確かめる。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MENU_GENERATION_SINGLE_DAY_MAX_DAYS_AHEAD, menuGenerationSingleDayMax } from '@homegohan/shared';
import { generateSingleDayMax } from '@/components/ai-assistant/V4GenerateModal';
import { LlmUsageSummaryRpcSchema, toLlmUsageResponseData } from '@/lib/super-admin/llm-usage-summary';
import { LLM_USAGE_ANOMALY_DAILY_REQUESTS } from '@/lib/super-admin/llm-usage-anomaly';

const ROOT = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');

/** 画面の説明「今日から1ヶ月先まで」の日数 (手で書いた期待値) */
const EXPECTED_SINGLE_DAY_MAX_DAYS_AHEAD = 30;

describe('1. 運営の LLM 使用量の画面の型は、route の応答の型そのもの', () => {
  const page = read('src/app/super-admin/llm/page.tsx');
  /** コメントを除いた画面のコード (以前の型の説明のコメントに daily_requests の語が残るので、コードだけを見る) */
  const pageCode = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('画面は LlmUsageResponseData を import して使い、別の型 (daily_requests を含む) を書かない', () => {
    expect(page).toMatch(/import type \{ LlmUsageResponseData \} from "@\/lib\/super-admin\/llm-usage-summary"/);
    expect(page).toContain('useState<LlmUsageResponseData | null>');
    expect(pageCode).not.toContain('daily_requests');
    expect(pageCode).not.toMatch(/interface \w+ \{[^}]*anomalies/);
  });

  it('使われていなかった古い型 (LLMUsageSummary。anomalies に daily_requests / detected_at) も残さない', () => {
    expect(read('src/lib/super-admin/llm-schemas.ts')).not.toContain('daily_requests');
  });

  it('応答の anomalies の各要素は user_id / email / requests / cost_usd / is_anomaly (画面の型が言うとおり)', () => {
    const summary = LlmUsageSummaryRpcSchema.parse({
      total_requests: LLM_USAGE_ANOMALY_DAILY_REQUESTS + 1,
      total_tokens: 0,
      total_cost_usd: 0,
      by_model: [],
      by_function: [],
      top_users: [],
      timeseries: [],
      anomalous_users: [
        {
          user_id: 'u1',
          max_daily_requests: LLM_USAGE_ANOMALY_DAILY_REQUESTS + 1,
          requests: LLM_USAGE_ANOMALY_DAILY_REQUESTS + 1,
          cost_usd: 0,
        },
      ],
    });
    const data = toLlmUsageResponseData(summary, { from: '2026-10-01', to: '2026-10-07' });
    expect(data.anomalies).toHaveLength(1);
    expect(Object.keys(data.anomalies[0]).sort()).toEqual(['cost_usd', 'email', 'is_anomaly', 'requests', 'user_id']);
  });
});

describe('2. 献立生成の「1日だけ」の上限は、Web とモバイルで共有の値', () => {
  it('上限の値は今日から 30 日先', () => {
    expect(MENU_GENERATION_SINGLE_DAY_MAX_DAYS_AHEAD).toBe(EXPECTED_SINGLE_DAY_MAX_DAYS_AHEAD);
    expect(menuGenerationSingleDayMax('2026-10-14')).toBe('2026-11-13');
    expect(menuGenerationSingleDayMax('2026-12-15')).toBe('2027-01-14');
  });

  it('Web の日付の欄の上限 (generateSingleDayMax) は共有の関数そのもので、欄の max に使う (別の数値を書かない)', () => {
    expect(generateSingleDayMax).toBe(menuGenerationSingleDayMax);
    const web = read('src/components/ai-assistant/V4GenerateModal.tsx');
    expect(web).toContain('max={generateSingleDayMax(todayStr)}');
    expect(web).not.toContain('SINGLE_DAY_MAX_DAYS_AHEAD');
  });

  it('モバイルの「1日だけ」の確定 (commitSingleDayInput) は、共有の上限を使う', () => {
    const mobile = read('apps/mobile/src/components/menu/V4GenerateModal.tsx');
    expect(mobile).toMatch(/import \{[^}]*menuGenerationSingleDayMax[^}]*\} from "@homegohan\/shared"/);
    const body = mobile.slice(mobile.indexOf('export function commitSingleDayInput'));
    expect(body.slice(0, body.indexOf('\n}'))).toContain('clampDay(value, today, menuGenerationSingleDayMax(today))');
  });
});
