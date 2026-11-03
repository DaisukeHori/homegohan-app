/**
 * 画面の部品のテストで、非同期の更新 (fetch の応答・予約した setTimeout の後の setState など) が画面に出るまで、
 * act の中で少しずつ実時間を進めながら待つ (#2201)。AI 相談の吹き出し (src/components/AIChatBubble.tsx) のテストで使う。
 *
 * 待ちの上限の根拠: それまで各ファイルは 20ms × 100 回 / 50ms × 40 回 (合わせて 2 秒) だけ実時間で待っていた。
 * 2026-11-03 の main の CI (run 41659836380) は、全件で 315 秒かかる混雑の中で走った。混雑の中では、送信 → 会話の取り直し →
 * 記録の読み取り → setMessages の 1 往復も伸びうるので、待ちの上限は 2 秒の 5 倍 (10 秒) にする
 * (その run の赤 2 件の直接の原因は、待ちの上限ではなく、すぐ消える途中の表示を実時間の読み直しと競って見ようとしたこと。
 * tests/ai-chat-timeout-reload-2201.test.tsx の holdRecheck を参照)。
 * 待ちが 10 秒まで伸びうるので、これを使うファイルは applyHeavyUnitTestTimeout() (1 件のテスト 30 秒) を呼ぶ。
 *
 * 待ちには、テストのファイルを読み込んだときの本物の setTimeout を使う。テストが vi.useFakeTimers で setTimeout を
 * 偽のタイマーにしている間 (部品の予約をテストが進めるまで動かさないとき) も、この待ちは実時間で進む。
 */
import { act } from 'react';

/** 1 回の待ち (ミリ秒)。それまでの 2201 のテストと同じ */
export const ACT_WAIT_POLL_MS = 20;
/** 待ちの上限 (ミリ秒)。根拠は上のコメント (それまでの 2 秒の 5 倍) */
export const ACT_WAIT_TIMEOUT_MS = 10_000;
/** 待ちの回数の上限 */
export const ACT_WAIT_MAX_POLLS = Math.ceil(ACT_WAIT_TIMEOUT_MS / ACT_WAIT_POLL_MS);

/** 読み込んだときの本物の setTimeout (あとで vi.useFakeTimers に置き換えられても、こちらは実時間) */
const realSetTimeout = globalThis.setTimeout;

/** 実時間で ms だけ待つ (偽のタイマーの間も進む) */
export function sleepRealTime(ms: number): Promise<void> {
  return new Promise((resolve) => {
    realSetTimeout(resolve, ms);
  });
}

/**
 * condition が真になるまで、act の中で ACT_WAIT_POLL_MS ずつ実時間を進めて待つ (上限 ACT_WAIT_TIMEOUT_MS)。
 * 真になったかどうかは確かめない (呼ぶ側が、最後に条件そのものを expect する)
 */
export async function pollUntil(condition: () => boolean): Promise<void> {
  for (let i = 0; i < ACT_WAIT_MAX_POLLS && !condition(); i += 1) {
    await act(async () => {
      await sleepRealTime(ACT_WAIT_POLL_MS);
    });
  }
}
