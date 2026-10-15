// src/__tests__/app/menus/weekly/request-watch-guard.test.ts
// Issue #1622:
//   週間献立の画面 (page.tsx) の subscribeToRequestStatus は、Realtime の接続の失敗 (TIMED_OUT / CLOSED / CHANNEL_ERROR) と
//   監視を始めて 5 秒後の確認で、Realtime がつながっていなければポーリングを始め直す。
//   以前は、生成が終わった (完了・失敗・中止で cleanupRealtime した) あとでも、removeChannel が出す CLOSED や、
//   残っていた 5 秒のタイマーからポーリングを始め直し、終わった要求の状態をもう一度読んでいた
//   (失敗の表示を出し直す・別の週に切り替えたあとで古い週の献立を読み直す)。
//   また Realtime で終わりを受け取っても、並行しているポーリングを止めず、同じ終わりをポーリングがもう一度処理していた。
//   → 監視 1 回分の印 (requestWatchRef / watch.active) を置き、cleanupRealtime で下ろす。始め直しは印が立っているときだけ。
//     Realtime で終わりを受け取ったら cleanupPolling も呼ぶ。
//
// page.tsx は巨大なクライアントコンポーネントで、全体の描画での検証は現実的でないため、既存の配線テスト
// (pending-restore-progress.test.ts・regenerate-improve-polling-guard.test.ts) と同じくソースを検査する。
// 画面の振る舞い (終わったあと生成中に戻らない・status を読み直さない) は tests/e2e/w5-3-menu-gen-adversarial.spec.ts の
// B-6・E-18・F-22 が確かめる。

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const PAGE_TSX_PATH = path.resolve(__dirname, '../../../../app/(main)/menus/weekly/page.tsx');
const pageSource = fs.readFileSync(PAGE_TSX_PATH, 'utf-8');

/** コメントの行を除いたソース (経緯のコメントに当たらないように、コードの行だけを検査する) */
function stripCommentLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line))
    .join('\n');
}

const pageCode = stripCommentLines(pageSource);

/** start から始まり、その後で最初に end が現れるところまで (end を含む) のコード */
function sliceBetween(code: string, start: string, end: string): string {
  const from = code.indexOf(start);
  if (from < 0) throw new Error(`開始の印が見つからない: ${start}`);
  const to = code.indexOf(end, from);
  if (to < 0) throw new Error(`終わりの印が見つからない: ${end}`);
  return code.slice(from, to + end.length);
}

const cleanupRealtimeCode = sliceBetween(pageCode, 'const cleanupRealtime = useCallback(', '}, []);');
const subscribeCode = sliceBetween(
  pageCode,
  'const subscribeToRequestStatus = useCallback(',
  '}, [cleanupRealtime, cleanupPolling, startPolling',
);

describe('週間献立の画面の監視の印 (#1622)', () => {
  it('cleanupRealtime は、チャンネルを外す前に監視の印を下ろす (removeChannel の CLOSED でポーリングを始め直さない)', () => {
    const lowerAt = cleanupRealtimeCode.indexOf('requestWatchRef.current.active = false');
    const removeAt = cleanupRealtimeCode.indexOf('removeChannel(');
    expect(lowerAt).toBeGreaterThanOrEqual(0);
    expect(removeAt).toBeGreaterThanOrEqual(0);
    expect(lowerAt).toBeLessThan(removeAt);
    expect(cleanupRealtimeCode).toContain('requestWatchRef.current = null');
  });

  it('subscribeToRequestStatus は、監視を始めるときに新しい印を立てる (前の監視を片付けたあと)', () => {
    const cleanupAt = subscribeCode.indexOf('cleanupRealtime();');
    const watchAt = subscribeCode.indexOf('const watch = { active: true };');
    const assignAt = subscribeCode.indexOf('requestWatchRef.current = watch;');
    expect(cleanupAt).toBeGreaterThanOrEqual(0);
    expect(watchAt).toBeGreaterThan(cleanupAt);
    expect(assignAt).toBeGreaterThan(watchAt);
  });

  it('Realtime の接続の失敗からのポーリングの始め直しは、印が立っているときだけ', () => {
    const fallback = sliceBetween(subscribeCode, "status === 'CHANNEL_ERROR'", 'startPolling(targetDate, requestId, ultimateMode);');
    expect(fallback).toContain('watch.active');
  });

  it('5 秒後の確認からのポーリングの始め直しは、印が立っているときだけ', () => {
    const timer = sliceBetween(subscribeCode, 'setTimeout(() => {', 'startPolling(targetDate, requestId, ultimateMode);');
    expect(timer).toContain('!realtimeConnected');
    expect(timer).toContain('!pollingIntervalRef.current');
    expect(timer).toContain('watch.active');
  });

  it('Realtime で完了・失敗を受け取ったら、Realtime とポーリングの両方を止める', () => {
    const completed = sliceBetween(subscribeCode, "if (newStatus === 'completed')", "} else if (newStatus === 'failed')");
    expect(completed).toContain('cleanupRealtime();');
    expect(completed).toContain('cleanupPolling();');
    const failed = sliceBetween(subscribeCode, "} else if (newStatus === 'failed')", "type: 'GEN_FAIL'");
    expect(failed).toContain('cleanupRealtime();');
    expect(failed).toContain('cleanupPolling();');
  });
});
