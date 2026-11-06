/**
 * #2283 W1: 閉じた AI 相談の要約の引き継ぎの形 (src/lib/ai/consultation-past-sessions.ts) の境目。
 * route を通した振る舞い (作る → 閉じる のくり返し・同時の 2 本) は tests/ai-consultation-snapshot-growth-2283.test.ts。
 */
import { describe, expect, it } from 'vitest';
import {
  PAST_SESSION_SUMMARY_COLUMNS,
  compactContextSnapshot,
  toPastSessionSummary,
} from '@/lib/ai/consultation-past-sessions';

const KEY_FACTS = [{ date: '2026-11-01', category: '体重', content: '62kg' }];
const INSIGHTS = ['朝食を抜きがち'];
const EMPTY_SUMMARY = { id: null, title: null, summary: null, key_topics: [], summary_generated_at: null, key_facts: [], user_insights: [] };

describe('#2283 W1 閉じた相談の要約の形', () => {
  it('読む列は snapshot の丸ごとを含まず、key_facts・user_insights を JSON の path で読む', () => {
    const columns = PAST_SESSION_SUMMARY_COLUMNS.split(',').map((c) => c.trim());
    expect(columns).toEqual([
      'id',
      'title',
      'summary',
      'key_topics',
      'summary_generated_at',
      'key_facts:context_snapshot->key_facts',
      'user_insights:context_snapshot->user_insights',
    ]);
  });

  it('JSON の path で読んだ行は、そのまま小さな形になる (余分なキーは落とす)', () => {
    expect(
      toPastSessionSummary({
        id: 'a',
        title: 't',
        summary: 's',
        key_topics: ['体重'],
        summary_generated_at: '2026-11-01T00:00:00.000Z',
        key_facts: KEY_FACTS,
        user_insights: INSIGHTS,
        extra: { pastSessionSummaries: [] },
      }),
    ).toEqual({ id: 'a', title: 't', summary: 's', key_topics: ['体重'], summary_generated_at: '2026-11-01T00:00:00.000Z', key_facts: KEY_FACTS, user_insights: INSIGHTS });
  });

  it('修正前の形 (context_snapshot の中の key_facts・user_insights) も読む。直下の値があれば直下を使う', () => {
    expect(toPastSessionSummary({ id: 'a', context_snapshot: { key_facts: KEY_FACTS, user_insights: INSIGHTS } })).toMatchObject({ key_facts: KEY_FACTS, user_insights: INSIGHTS });
    expect(toPastSessionSummary({ id: 'a', key_facts: [], user_insights: [], context_snapshot: { key_facts: KEY_FACTS, user_insights: INSIGHTS } })).toMatchObject({ key_facts: [], user_insights: [] });
  });

  it('配列でない値・null・オブジェクトでない行は、空の配列と null にする (読む側が壊れない)', () => {
    expect(toPastSessionSummary({ id: 1, title: null, key_topics: null, key_facts: { category: 'x' }, user_insights: 'text' })).toEqual(EMPTY_SUMMARY);
    expect(toPastSessionSummary(null)).toEqual(EMPTY_SUMMARY);
    expect(toPastSessionSummary(undefined)).toEqual(EMPTY_SUMMARY);
    expect(toPastSessionSummary(['a'])).toEqual(EMPTY_SUMMARY);
  });

  it('閉じる route の土台: pastSessionSummaries を小さな形に詰め直し、ほかのキーは残す', () => {
    const snapshot = {
      profile: { age: 30 },
      pastSessionSummaries: [{ id: 'old', title: '前', context_snapshot: { pastSessionSummaries: [{ id: 'older' }], key_facts: KEY_FACTS } }, 'broken'],
    };
    expect(compactContextSnapshot(snapshot)).toEqual({
      profile: { age: 30 },
      pastSessionSummaries: [
        { ...EMPTY_SUMMARY, id: 'old', title: '前', key_facts: KEY_FACTS },
        EMPTY_SUMMARY,
      ],
    });
    // 元の snapshot は書き換えない
    expect(snapshot.pastSessionSummaries[0]).toHaveProperty('context_snapshot');
  });

  it('閉じる route の土台: pastSessionSummaries が無ければキーを足さない。配列でなければ空の一覧。オブジェクトでなければ空', () => {
    expect(compactContextSnapshot({ profile: null })).toEqual({ profile: null });
    expect(compactContextSnapshot({ pastSessionSummaries: 'x' })).toEqual({ pastSessionSummaries: [] });
    expect(compactContextSnapshot(null)).toEqual({});
    expect(compactContextSnapshot(undefined)).toEqual({});
    expect(compactContextSnapshot([{ a: 1 }])).toEqual({});
  });
});
