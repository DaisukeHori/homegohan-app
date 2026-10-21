/**
 * #1911: 生成のリクエストの行の progress が DB の既定値のまま (ワーカーがまだ進捗を書いていない) でも、
 * 既定値の文 (未完成を表す語) を画面に出さない
 *
 * weekly_menu_requests / shopping_list_requests の progress 列の既定値 (supabase/migrations の DEFAULT) は、
 * progress を渡さずに行を作る経路 (週の献立の依頼 /api/ai/menu/weekly/request など) で、そのまま画面に届く。
 * 画面に出す前に src/lib/request-progress-display.ts の requestProgressForDisplay で置き換える。ここでは、
 * 本物の既定値 (SQL から読んだもの) を入力にして、届く経路ごとに確かめる。
 *   - 週の献立の画面の進捗の変換 (convertV4ProgressToUIFormat。ポーリング・Realtime・入り直しの復元が通る)
 *   - 進捗のカード (ProgressTodoCard。週の献立の生成と買い物リストの作り直しが使う)
 *   - 進捗の購読 (useV4MenuGeneration の subscribeToProgress。週の献立の画面と AI 相談の吹き出しが使う)
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RealtimeHandler = (payload: { new: Record<string, unknown> }) => void;

const realtime = vi.hoisted(() => ({ handler: null as null | ((payload: { new: Record<string, unknown> }) => void) }));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const channel = {
      on: (_event: string, _filter: unknown, handler: RealtimeHandler) => {
        realtime.handler = handler;
        return channel;
      },
      subscribe: () => channel,
      unsubscribe: () => undefined,
    };
    return { channel: () => channel };
  },
}));

import {
  DB_DEFAULT_REQUEST_PROGRESS_PHASE,
  REQUEST_PROGRESS_STARTING_MESSAGE,
  requestProgressForDisplay,
} from '@/lib/request-progress-display';
import { convertV4ProgressToUIFormat } from '@/app/(main)/menus/weekly/_state/v4ProgressUi';
import { ProgressTodoCard } from '@/app/(main)/menus/weekly/_components/ProgressTodoCard';
import { useV4MenuGeneration } from '@/hooks/useV4MenuGeneration';
import { findProgressDefaults } from './helpers/db-progress-defaults';

/** 既定値の文 (未完成を表す語) */
const PENDING_WORD = '準備中';

const COLORS = { accent: '#5B8266', purple: '#8B5CF6' };

/** SQL から読んだ、本物の progress の既定値 (weekly_menu_requests と shopping_list_requests。baseline も含む) */
const progressDefaults = findProgressDefaults();

/** 週の献立 (weekly_menu_requests。割合なし) と買い物リスト (shopping_list_requests。割合あり) の既定値 */
const weeklyDefault = progressDefaults.find((d) => d.progress.message !== undefined && !('percentage' in d.progress));
const shoppingDefault = progressDefaults.find((d) => 'percentage' in d.progress);

describe('#1911 progress の既定値の置き換え (requestProgressForDisplay)', () => {
  it('SQL に、週の献立 (割合なし) と買い物リスト (割合あり) の既定値があり、どちらも既定値の文を持つ', () => {
    expect(weeklyDefault).toBeDefined();
    expect(shoppingDefault).toBeDefined();
    for (const d of progressDefaults) {
      expect(d.progress.phase, `${d.file}:${d.line}`).toBe(DB_DEFAULT_REQUEST_PROGRESS_PHASE);
      expect(String(d.progress.message), `${d.file}:${d.line}`).toContain(PENDING_WORD);
    }
  });

  it('既定値の message を置き換え、phase と割合は変えない', () => {
    for (const d of progressDefaults) {
      const display = requestProgressForDisplay(d.progress as Record<string, unknown>);
      expect(display.message).toBe(REQUEST_PROGRESS_STARTING_MESSAGE);
      expect(display.phase).toBe(d.progress.phase);
      expect((display as Record<string, unknown>).percentage).toBe((d.progress as Record<string, unknown>).percentage);
    }
    expect(REQUEST_PROGRESS_STARTING_MESSAGE).not.toContain(PENDING_WORD);
  });

  it('ワーカー・API が書いた進捗 (既定値の phase でない) は、同じものをそのまま返す', () => {
    const written = { phase: 'starting', message: '開始中...', percentage: 0 };
    expect(requestProgressForDisplay(written)).toBe(written);
    const v4 = { currentStep: 1, totalSteps: 3, message: 'ユーザー情報を取得中...' };
    expect(requestProgressForDisplay(v4)).toBe(v4);
  });
});

describe('#1911 週の献立の画面の進捗の変換 (convertV4ProgressToUIFormat) は既定値の文を出さない', () => {
  it.each([false, true])('既定値 (割合なし) を変換すると、置き換えた文で生成中として出す (ultimateMode=%s)', (ultimateMode) => {
    const ui = convertV4ProgressToUIFormat(weeklyDefault!.progress as Record<string, unknown>, ultimateMode);
    expect(ui.message).toBe(REQUEST_PROGRESS_STARTING_MESSAGE);
    expect(ui.phase).toBe('generating');
    expect(ui.percentage).toBe(0);
    expect(ui.isUltimateMode).toBe(ultimateMode);
  });

  it('既定値 (割合あり) も、置き換えた文で返す', () => {
    const ui = convertV4ProgressToUIFormat(shoppingDefault!.progress as Record<string, unknown>, false);
    expect(ui.message).toBe(REQUEST_PROGRESS_STARTING_MESSAGE);
  });
});

describe('#1911 進捗のカード (ProgressTodoCard) は既定値の文を出さない', () => {
  it.each(progressDefaults.map((d) => [`${d.file}:${d.line}`, d] as const))('%s の既定値をそのまま渡しても出さない', (_label, d) => {
    const progress = { percentage: 0, ...(d.progress as { phase: string; message: string }) };
    const html = renderToStaticMarkup(
      React.createElement(ProgressTodoCard, { progress, colors: COLORS, defaultMessage: '買い物リストを生成中...' }),
    );
    expect(html).not.toContain(PENDING_WORD);
    expect(html).toContain(REQUEST_PROGRESS_STARTING_MESSAGE);
  });

  it('ワーカーが書いた進捗の文は、そのまま出す', () => {
    const html = renderToStaticMarkup(
      React.createElement(ProgressTodoCard, {
        progress: { phase: 'starting', message: '開始中...', percentage: 0 },
        colors: COLORS,
      }),
    );
    expect(html).toContain('開始中...');
  });
});

// React の act() を使う検査であることを React に伝える (伝えないと act の警告が出る)
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('#1911 進捗の購読 (useV4MenuGeneration の subscribeToProgress) は既定値の文を渡さない', () => {
  let container: HTMLDivElement;
  let root: Root;
  let subscribe: ReturnType<typeof useV4MenuGeneration>['subscribeToProgress'] | null = null;

  function Harness() {
    subscribe = useV4MenuGeneration().subscribeToProgress;
    return null;
  }

  beforeEach(() => {
    realtime.handler = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container);
      root.render(React.createElement(Harness));
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    subscribe = null;
  });

  it('Realtime で届いた行の progress が既定値なら、置き換えた文を渡す (AI 相談の吹き出しはこの文を出す)', () => {
    const received: Array<Record<string, unknown>> = [];
    subscribe!('req-1911', (progress) => received.push(progress));
    expect(realtime.handler).not.toBeNull();
    act(() => {
      realtime.handler!({ new: { status: 'processing', progress: weeklyDefault!.progress, error_message: null } });
    });
    expect(received).toHaveLength(1);
    expect(received[0].message).toBe(REQUEST_PROGRESS_STARTING_MESSAGE);
    expect(received[0].status).toBe('processing');
  });

  it('ワーカーが書いた進捗の文は、そのまま渡す', () => {
    const received: Array<Record<string, unknown>> = [];
    subscribe!('req-1911', (progress) => received.push(progress));
    act(() => {
      realtime.handler!({
        new: { status: 'processing', progress: { currentStep: 1, totalSteps: 3, message: 'ユーザー情報を取得中...' }, error_message: null },
      });
    });
    expect(received[0].message).toBe('ユーザー情報を取得中...');
  });
});
