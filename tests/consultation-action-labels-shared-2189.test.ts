/**
 * #2189 W2 AI 相談の提案の実行の結果の一文を Web とモバイルで共有する (packages/shared/src/consultation-action-outcome.ts)
 *
 *   - 判定 (成功『✅ …を実行しました！』/ 失敗の文) の本体は @homegohan/shared に置き、Web の
 *     src/lib/ai/consultation-action-outcome.ts は同じものを読み直すだけ (Web の import は変えない)
 *   - 提案の種類の名前の表 (CONSULTATION_ACTION_LABELS) の鍵は、実行の側 (consultation-action-executor.ts の
 *     runConsultationAction の case) の種類と一致する。表に無い種類は成功の一文が『✅ アクションを実行しました！』になり、
 *     実行の側に無い鍵は使われない古い名前になるので、両方向の漏れを見る
 *   - 会話の続きの POST (SSE) の finalData から、自動実行の結果の一文を作る (consultationAutoActionOutcomeOf)。
 *     actionResult が無ければ何も出さない (Web の showAutoActionOutcome と同じ)
 *   - モバイルの AI 相談のシートは一文を自分で書かず、共有の関数を使う
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import * as shared from '@homegohan/shared';
import {
  AI_CONSULTATION_ACTION_FAILED_FALLBACK_MESSAGE,
  CONSULTATION_ACTION_LABELS,
  CONSULTATION_ACTION_LABEL_FALLBACK,
  consultationActionLabelOf,
  consultationActionOutcomeOf,
  consultationAutoActionOutcomeOf,
} from '@homegohan/shared';
import * as webOutcome from '@/lib/ai/consultation-action-outcome';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

/** 実行の側 (runConsultationAction の switch) が受け付ける種類 */
function executorActionTypes(): string[] {
  const source = read('src/lib/ai/consultation-action-executor.ts');
  const types = [...source.matchAll(/^\s*case '([a-z_]+)':/gm)].map((match) => match[1]);
  return [...new Set(types)].sort();
}

describe('#2189 W2: 提案の種類の名前の表は実行の側の種類と一致する', () => {
  it('実行の側の case を読み取れている (走査の場所を間違えて、何も見ずに通ることを防ぐ)', () => {
    const types = executorActionTypes();
    expect(types).toContain('generate_single_meal');
    expect(types).toContain('update_profile_preferences');
  });

  it('表の鍵 = 実行の側の種類 (表に無い種類も、実行の側に無い古い鍵も無い)', () => {
    expect(Object.keys(CONSULTATION_ACTION_LABELS).sort()).toEqual(executorActionTypes());
  });

  it('どの名前も空でなく、固定の名前 (アクション) と違う', () => {
    for (const [type, label] of Object.entries(CONSULTATION_ACTION_LABELS)) {
      expect(label.trim(), type).not.toBe('');
      expect(label, type).not.toBe(CONSULTATION_ACTION_LABEL_FALLBACK);
    }
  });

  it('表に無い種類・文字列でない値・Object の組み込みの名前は、固定の名前 (アクション)', () => {
    expect(consultationActionLabelOf('generate_single_meal')).toBe('1食を作成');
    expect(consultationActionLabelOf('create_meal')).toBe(CONSULTATION_ACTION_LABEL_FALLBACK);
    expect(consultationActionLabelOf('constructor')).toBe(CONSULTATION_ACTION_LABEL_FALLBACK);
    expect(consultationActionLabelOf('toString')).toBe(CONSULTATION_ACTION_LABEL_FALLBACK);
    expect(consultationActionLabelOf(undefined)).toBe(CONSULTATION_ACTION_LABEL_FALLBACK);
    expect(consultationActionLabelOf(null)).toBe(CONSULTATION_ACTION_LABEL_FALLBACK);
    expect(consultationActionLabelOf(1)).toBe(CONSULTATION_ACTION_LABEL_FALLBACK);
  });
});

describe('#2189 W2: Web の consultation-action-outcome は共有の判定を読み直すだけ', () => {
  it('Web の import から読める関数・定数は、@homegohan/shared のものと同じ', () => {
    expect(webOutcome.consultationActionOutcomeOf).toBe(shared.consultationActionOutcomeOf);
    expect(webOutcome.consultationActionFailureMessageOf).toBe(shared.consultationActionFailureMessageOf);
    expect(webOutcome.consultationActionExecutedMessageOf).toBe(shared.consultationActionExecutedMessageOf);
    expect(webOutcome.AI_CONSULTATION_ACTION_FAILED_FALLBACK_MESSAGE).toBe(shared.AI_CONSULTATION_ACTION_FAILED_FALLBACK_MESSAGE);
  });

  it('Web のファイルは判定を持たない (一文の文字を書かない)', () => {
    const source = read('src/lib/ai/consultation-action-outcome.ts');
    expect(source).toContain("from '@homegohan/shared'");
    expect(source).not.toContain('実行しました');
    expect(source).not.toContain(AI_CONSULTATION_ACTION_FAILED_FALLBACK_MESSAGE);
  });
});

describe('#2189 W2: SSE の finalData から自動実行の結果の一文を作る', () => {
  it('成功: 提案の種類の名前で『✅ …を実行しました！』', () => {
    const outcome = consultationAutoActionOutcomeOf({
      aiMessage: { id: 'a1', content: '作りました', proposedActions: { type: 'generate_single_meal', params: {} } },
      actionExecuted: true,
      actionResult: { success: true, result: { mealId: 'm1' } },
    });
    expect(outcome).toEqual({
      outcome: { kind: 'executed', content: '✅ 1食を作成を実行しました！' },
      actionType: 'generate_single_meal',
    });
  });

  it('失敗: result.error の文 (実行しましたとは出さない)', () => {
    const outcome = consultationAutoActionOutcomeOf({
      aiMessage: { proposedActions: { type: 'add_to_shopping_list' } },
      actionResult: { success: false, result: { error: '買い物リストに追加できませんでした' } },
    });
    expect(outcome).toEqual({
      outcome: { kind: 'failed', content: '買い物リストに追加できませんでした' },
      actionType: 'add_to_shopping_list',
    });
  });

  it('失敗で result が null (自動実行の例外): 固定の文', () => {
    const outcome = consultationAutoActionOutcomeOf({
      aiMessage: { proposedActions: { type: 'generate_week_menu' } },
      actionResult: { success: false, result: null },
    });
    expect(outcome?.outcome).toEqual({ kind: 'failed', content: AI_CONSULTATION_ACTION_FAILED_FALLBACK_MESSAGE });
  });

  it('success が欠けている・true でない値は失敗として扱う', () => {
    for (const actionResult of [{ result: {} }, { success: 'true', result: {} }, { success: 1, result: {} }]) {
      expect(consultationAutoActionOutcomeOf({ actionResult })?.outcome.kind).toBe('failed');
    }
  });

  it('種類は actionResult.actionType が文字列ならそれを先に使い、無ければ提案の種類。どちらも無ければ固定の名前', () => {
    expect(
      consultationAutoActionOutcomeOf({
        aiMessage: { proposedActions: { type: 'update_meal' } },
        actionResult: { success: true, result: {}, actionType: 'delete_meal' },
      }),
    ).toEqual({ outcome: { kind: 'executed', content: '✅ 献立を削除を実行しました！' }, actionType: 'delete_meal' });
    expect(consultationAutoActionOutcomeOf({ actionResult: { success: true, result: {} } })).toEqual({
      outcome: { kind: 'executed', content: `✅ ${CONSULTATION_ACTION_LABEL_FALLBACK}を実行しました！` },
      actionType: null,
    });
  });

  it('成功の一文は consultationActionOutcomeOf と同じ (Web の手の実行の一文とそろう)', () => {
    const auto = consultationAutoActionOutcomeOf({
      aiMessage: { proposedActions: { type: 'like_recipe' } },
      actionResult: { success: true, result: {} },
    });
    expect(auto?.outcome).toEqual(consultationActionOutcomeOf({ success: true, result: {}, label: 'レシピにいいね' }));
  });

  it('actionResult が無い・null・オブジェクトでない (提案が無く実行していない) ときは null', () => {
    for (const finalData of [
      {},
      { actionResult: null },
      { actionResult: 'x' },
      { aiMessage: { proposedActions: null }, actionExecuted: false, actionResult: null },
      null,
      undefined,
      'data',
    ]) {
      expect(consultationAutoActionOutcomeOf(finalData)).toBeNull();
    }
  });
});

describe('#2189 W2: モバイルの AI 相談のシートは共有の関数で一文を作る', () => {
  it('AIAdvisorSheet.tsx は consultationAutoActionOutcomeOf を @homegohan/shared から読み、一文を自分で書かない', () => {
    const source = read('apps/mobile/src/components/ai/AIAdvisorSheet.tsx');
    expect(source).toMatch(/import \{[^}]*\bconsultationAutoActionOutcomeOf\b[^}]*\} from "@homegohan\/shared"/);
    expect(source).toContain('consultationAutoActionOutcomeOf(parsed)');
    expect(source).not.toContain('実行しました');
    expect(source).not.toContain(AI_CONSULTATION_ACTION_FAILED_FALLBACK_MESSAGE);
  });
});
