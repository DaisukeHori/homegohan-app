// T15 (#1154) 保存・集計と AI を兼ねる API が、同意が無くて AI の部分を省いたこと (応答の aiSkipped) を画面に出す
//
// サーバー (健康診断・血液検査の保存、ホームの栄養の集計、AI 相談を閉じる) は、同意が無ければ AI へ送らずに
// 保存・集計だけをして、aiSkipped (AI_CONSENT_REQUIRED / AI_CONSENT_CHECK_FAILED) を返す。
// 画面がこれを読まないと、「AI分析を実行できませんでした」という事実と違う表示になり、同意が必要だと知らされない。
//   1. aiSkippedReasonOf / aiSummarySkippedNote: aiSkipped を出し分けの理由・一文に直す
//   2. AiSkippedNotice (Web): 同意が無いときは、同意が必要な旨の一文と同意のページへのリンク。読めないときは「一時的に」の一文
//   3. aiSkipped を返す API を呼ぶ画面 (Web・アプリ) は、どれも aiSkipped を読んでいる (読まない画面は理由つきで載せる)
//
// NOTE: tsconfig の jsx: "preserve" の都合で、拡張子 .ts + React.createElement で書く。

import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import {
  AI_CONSENT_AUTOMATIC_LOCKED_NOTE,
  AI_CONSENT_CHECK_FAILED_CODE,
  AI_CONSENT_CHECK_FAILED_MESSAGE,
  AI_CONSENT_CHECK_FAILED_SKIPPED_NOTE,
  AI_CONSENT_REQUIRED_CODE,
  AI_CONSENT_SKIPPED_NOTE,
  AI_CONSENT_SUMMARY_CHECK_FAILED_NOTE,
  AI_CONSENT_SUMMARY_SKIPPED_NOTE,
  aiConsentSkippedField,
  aiSkippedReasonOf,
  aiSummarySkippedNote,
} from '../supabase/functions/_shared/ai-consent';

const ROOT = path.resolve(__dirname, '..');
const h = React.createElement;

vi.mock('next/link', async () => {
  const react = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode } & Record<string, unknown>) =>
      react.createElement('a', { href, ...rest }, children),
  };
});

import { AiSkippedNotice } from '@/components/consent/AiSkippedNotice';

describe('aiSkippedReasonOf / aiSummarySkippedNote', () => {
  it('サーバーが足す aiSkipped (aiConsentSkippedField) を、そのまま出し分けの理由に直す', () => {
    expect(aiSkippedReasonOf(aiConsentSkippedField({ allowed: false, reason: 'not_consented' }))).toBe('consent_required');
    expect(aiSkippedReasonOf(aiConsentSkippedField({ allowed: false, reason: 'check_failed' }))).toBe('check_failed');
    expect(aiSkippedReasonOf(aiConsentSkippedField({ allowed: true }))).toBeNull();
  });

  it('aiSkipped が無い・知らない値・本文が無いときは null (従来どおりの表示)', () => {
    expect(aiSkippedReasonOf({ checkup: {} })).toBeNull();
    expect(aiSkippedReasonOf({ aiSkipped: 'OTHER' })).toBeNull();
    expect(aiSkippedReasonOf(null)).toBeNull();
    expect(aiSkippedReasonOf('AI_CONSENT_REQUIRED')).toBeNull();
  });

  it('AI 相談を閉じた応答: 同意が無いとき・読めないときの一文を選び、省いていなければ null', () => {
    expect(aiSummarySkippedNote({ success: true, summary: null, aiSkipped: AI_CONSENT_REQUIRED_CODE })).toBe(AI_CONSENT_SUMMARY_SKIPPED_NOTE);
    expect(aiSummarySkippedNote({ success: true, summary: null, aiSkipped: AI_CONSENT_CHECK_FAILED_CODE })).toBe(
      AI_CONSENT_SUMMARY_CHECK_FAILED_NOTE,
    );
    expect(aiSummarySkippedNote({ success: true, summary: null })).toBeNull();
  });
});

describe('AiSkippedNotice (Web)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function render(props: React.ComponentProps<typeof AiSkippedNotice>) {
    act(() => {
      root.render(h(AiSkippedNotice, props));
    });
    return {
      text: container.querySelector('[data-testid="ai-skipped-notice"] p')?.textContent ?? null,
      link: container.querySelector<HTMLAnchorElement>('[data-testid="ai-skipped-open-consent"]'),
    };
  }

  it('保存の画面・同意が無い: 記録は保存した旨と同意が必要な旨の一文、同意のページへのリンク', () => {
    const { text, link } = render({ reason: 'consent_required', variant: 'saved' });
    expect(text).toBe(AI_CONSENT_SKIPPED_NOTE);
    expect(text).not.toContain('実行できませんでした');
    expect(link?.getAttribute('href')).toBe('/settings/ai-consent');
  });

  it('保存の画面・同意の状況を読めない: 「一時的に」の一文だけ (同意のページへは案内しない)', () => {
    const { text, link } = render({ reason: 'check_failed', variant: 'saved' });
    expect(text).toBe(AI_CONSENT_CHECK_FAILED_SKIPPED_NOTE);
    expect(link).toBeNull();
  });

  it('自動で作る AI のコメント: 同意が無いときは案内の一文とリンク、読めないときは「一時的に」の一文', () => {
    const required = render({ reason: 'consent_required', variant: 'automatic' });
    expect(required.text).toBe(AI_CONSENT_AUTOMATIC_LOCKED_NOTE);
    expect(required.link?.getAttribute('href')).toBe('/settings/ai-consent');
    const failed = render({ reason: 'check_failed', variant: 'automatic' });
    expect(failed.text).toBe(AI_CONSENT_CHECK_FAILED_MESSAGE);
    expect(failed.link).toBeNull();
  });
});

// ─────────────────────────────────────────────
// 3. aiSkipped を返す API を呼ぶ画面
// ─────────────────────────────────────────────

/** aiSkipped を返す API の呼び出し (コメントを外したソースで探す) */
const SKIPPING_CALLS: Array<{ label: string; pattern: RegExp }> = [
  // POST /api/health/checkups (GET の一覧・[id] の詳細は aiSkipped を返さない)
  { label: 'POST /api/health/checkups', pattern: /\.post(?:<[^>]*>)?\(\s*["'`]\/api\/health\/checkups["'`]|fetch\(\s*["'`]\/api\/health\/checkups["'`]\s*,\s*\{\s*method:\s*['"]POST['"]/ },
  { label: 'POST /api/health/blood-tests', pattern: /\.post(?:<[^>]*>)?\(\s*["'`]\/api\/health\/blood-tests["'`]|fetch\(\s*["'`]\/api\/health\/blood-tests["'`]\s*,\s*\{\s*method:\s*['"]POST['"]/ },
  { label: 'GET /api/ai/nutrition-analysis (AI のアドバイス付き)', pattern: /\/api\/ai\/nutrition-analysis\?[^"'`]*include(?:Advice|Suggestion)=true/ },
  { label: 'POST /api/ai/consultation/sessions/:id/close', pattern: /\/api\/ai\/consultation\/sessions\/\$\{[^}]+\}\/close/ },
];

/** aiSkipped を読む関数 */
const READS_SKIPPED = /\baiSkippedReasonOf\(|\baiSummarySkippedNote\(/;

/** aiSkipped を返す API を呼ぶが、読まなくてよい画面 → 理由 (省いたことを表示する場所が無い) */
const SKIPPED_NOT_SHOWN: Record<string, string> = {
  'src/app/(main)/meals/new/page.tsx':
    '健康診断の写真の読み取り (同意の確認を通ったあと) の結果を保存して、すぐ一覧へ移る。AI のレビューを表示しない',
  'apps/mobile/app/meals/new.tsx': '同上 (アプリ)。保存して、すぐ血液検査の一覧へ移る',
  'apps/mobile/app/ai/[sessionId].tsx': '相談を閉じたら、すぐ前の画面へ戻る (要約を表示しない)',
  'apps/mobile/src/hooks/useHomeData.ts': 'アプリのホームは、この集計 (nutritionAnalysis) をどの画面にも出していない',
};

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'api') continue;
      out.push(...listSources(rel));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

describe('aiSkipped を返す API を呼ぶ画面は、aiSkipped を読む', () => {
  const sources = ['src/app', 'src/components', 'src/hooks', 'apps/mobile/app', 'apps/mobile/src'].flatMap(listSources);
  const callers = sources
    .map((file) => ({ file, text: stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8')) }))
    .filter(({ text }) => SKIPPING_CALLS.some((c) => c.pattern.test(text)));

  it('呼び出しを見つけられている (検査が空振りしていない)', () => {
    const files = callers.map((c) => c.file);
    for (const expected of [
      'src/app/(main)/health/checkups/new/page.tsx',
      'src/hooks/useHomeData.ts',
      'src/components/AIChatBubble.tsx',
      'apps/mobile/app/health/checkups/new.tsx',
      'apps/mobile/app/health/blood-tests.tsx',
      'apps/mobile/src/components/ai/AIAdvisorSheet.tsx',
    ]) {
      expect(files).toContain(expected);
    }
  });

  it('読んでいない画面は、表示する場所が無い理由つきで載っているものだけ', () => {
    const notReading = callers.filter(({ text }) => !READS_SKIPPED.test(text)).map((c) => c.file).sort();
    expect(notReading).toEqual(Object.keys(SKIPPED_NOT_SHOWN).sort());
  });

  it('読む画面は、省いたことを表示する (Web は AiSkippedNotice、アプリは AiSkippedNotice か相談のメッセージ)', () => {
    for (const { file, text } of callers.filter(({ text }) => READS_SKIPPED.test(text))) {
      if (/aiSummarySkippedNote\(/.test(text)) {
        expect(text, file).toMatch(/content:\s*skippedNote/);
      } else if (file.endsWith('useHomeData.ts')) {
        // ホームは集計の状態に理由を持ち、ホームの画面が AiSkippedNotice で出す
        expect(stripComments(fs.readFileSync(path.join(ROOT, 'src/app/(main)/home/page.tsx'), 'utf8'))).toMatch(
          /<AiSkippedNotice[\s\S]*?reason=\{nutritionAnalysis\.aiSkipped\}/,
        );
      } else {
        expect(text, file).toMatch(/<AiSkippedNotice\b/);
      }
    }
  });
});
