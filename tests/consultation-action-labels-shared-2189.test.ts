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
import {
  actionLabelKeys,
  actionLabelsClosingLine,
  actionLabelsSource,
  executorActionTypes as executorActionTypesInOrder,
} from './helpers/consultation-action-types';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * 実行の側 (runConsultationAction の switch) が受け付ける種類 (並べ替え・重複なし)。
 * 読み取りは W1 の helper (runConsultationAction の見出しより後ろの case だけ) に任せる (#2195 V3。
 * 以前はファイル全体の case を拾っていて、executor に別の switch が増えると helper と母集合がずれた)
 */
function executorActionTypes(): string[] {
  return [...new Set(executorActionTypesInOrder())].sort();
}

/** Web の ACTION_LABELS の 1 行の名前の書き方 (鍵と、名前を引く共有の表の鍵) */
const WEB_ACTION_LABEL_FROM_SHARED = /^\s*([a-z_]+):\s*\{\s*label:\s*CONSULTATION_ACTION_LABELS\.([a-z_]+)\s*,/gm;
/** Web の ACTION_LABELS の名前を文字列で直に書いた行 */
const WEB_ACTION_LABEL_LITERAL = /\blabel:\s*['"`]/;

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

describe('#2195 V3: Web の ACTION_LABELS の名前は共有の表から引く (名前の表を 1 つにする)', () => {
  it('どの行も名前を CONSULTATION_ACTION_LABELS の同じ鍵から引き、文字列を直に書かない', () => {
    const source = actionLabelsSource();
    const entries = [...source.matchAll(WEB_ACTION_LABEL_FROM_SHARED)].map((match) => ({ key: match[1], sharedKey: match[2] }));
    // 走査が何も見ずに通ることを防ぐ: 鍵の数 (helper の読み取り) と、共有の表から引く行の数が同じ
    expect(entries.map((entry) => entry.key)).toEqual(actionLabelKeys());
    for (const entry of entries) expect(entry.sharedKey, entry.key).toBe(entry.key);
    expect(WEB_ACTION_LABEL_LITERAL.test(source)).toBe(false);
  });

  it('表の鍵は共有の表の鍵と同じ集合で、型 (ConsultationActionType) でも確かめている', () => {
    expect([...actionLabelKeys()].sort()).toEqual(Object.keys(CONSULTATION_ACTION_LABELS).sort());
    expect(actionLabelsClosingLine()).toMatch(/^\}\s+satisfies\s+Record<ConsultationActionType,/);
    expect(read('src/components/AIChatBubble.tsx')).toMatch(
      /import \{[^}]*\bCONSULTATION_ACTION_LABELS\b[^}]*\btype ConsultationActionType\b[^}]*\} from "@homegohan\/shared"/,
    );
  });

  it('判定の正規表現は、名前を文字列で直に書いた行・別の鍵から引いた行を見分ける (見張りの自己検査)', () => {
    const literal = "  like_recipe: { label: 'レシピにいいね', icon: Heart, color: '#EC4899' },";
    expect(WEB_ACTION_LABEL_LITERAL.test(literal)).toBe(true);
    expect([...literal.matchAll(WEB_ACTION_LABEL_FROM_SHARED)]).toHaveLength(0);
    const otherKey = '  like_recipe: { label: CONSULTATION_ACTION_LABELS.suggest_recipe, icon: Heart, color: "#EC4899" },';
    expect([...otherKey.matchAll(WEB_ACTION_LABEL_FROM_SHARED)].map((match) => [match[1], match[2]])).toEqual([
      ['like_recipe', 'suggest_recipe'],
    ]);
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
