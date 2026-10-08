"use client";

// 外国の AI 事業者への提供の同意: AI の入口で「初回だけ同意画面を出す」ためのフック (T15 / #1154)
//
// 使い方 (AI にデータを送る操作の先頭で呼ぶ):
//
//   const { ensureAiConsent, consentModal } = useAiConsent();
//   ...
//   const onAnalyze = async () => {
//     await ensureAiConsent();   // 同意済みなら即座に戻る。初回だけ画面が出て、「同意する」「あとで」のどちらでも戻る
//     await fetch("/api/ai/...");
//   };
//   return (<>... {consentModal}</>);   // 画面の出る場所 (どこに置いてもよい。body 直下に描画される)
//
// 【AI への送信は止めない】(オーナーの決定。強制は別タスク T18 で、AI_CONSENT_ENFORCEMENT で切り替える予定)
//   - ensureAiConsent() は絶対に失敗しない (reject しない)。「あとで」を選んでも、状況が取れなくても、AI の操作は進む。
//   - 同意の状況の取得は、ページを開いたときに先に済ませておく (prefetch。useAiConsent({ prefetch: false }) で止められる)。
//     操作のときに長く待たせない。取得が終わっていなければ最大 ENSURE_WAIT_MS だけ待ち、それでも取れなければ画面を出さずに進める。
//     取得に失敗した直後は、UNAVAILABLE_BACKOFF_MS のあいだ状況の確認自体を省く (障害時に毎回待たせない)。
//   - 画面は「同意する」「あとで」のどちらを押しても閉じ、Esc は「あとで」。
//     「同意する」の記録に失敗したときは、画面にメッセージを出して閉じずに待つが、「あとで」はいつでも押せる。
//   - 「あとで」は同じブラウザで 24 時間、画面を出さない (localStorage)。サーバーには記録しない (拒否の行は作らない)。
//   - 同意済みの状況は、このページを開いている間は覚えておく。
//   - 画面が出ている間に、その画面を使っているページから離れたとき (戻る操作など) は、待っていた操作を再開しない
//     (同意の確認をしないまま、本人が離れたページの操作を送らないため)。
//   - 呼び出し側が consentModal を描画し忘れた場合も、操作を止めない: 画面が MODAL_SHOWN_TIMEOUT_MS 以内に表示されなければ、
//     'skipped' として進める (console.error で知らせる。tests/ai-consent-entry-points.test.ts が描画し忘れも検査する)。
//
// 戻り値の ensureAiConsent は 'consented' (同意済み・いま同意した) / 'later' (あとで) / 'skipped' (状況が取れず、画面を出さなかった)。
// 現在は呼び出し側がこの値で処理を分けることは無い (T18 で強制するときに使う)。

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AiDataConsentModal } from "@/components/consent/AiDataConsentModal";
import { fetchAiConsentStatus, postAiConsentGrant } from "@/lib/ai/consent-client";
import { AI_CONSENT_LATER_SNOOZE_MS, AI_CONSENT_LATER_STORAGE_KEY } from "@/lib/ai/consent-config";

export type AiConsentOutcome = "consented" | "later" | "skipped";

/** この間に取得済みの状況は、ページを開いたときの確認 (prefetch) で取り直さない */
const STATUS_FRESH_MS = 60_000;
/** 状況の取得に失敗してから、この間は確認を省く */
const UNAVAILABLE_BACKOFF_MS = 60_000;
/** 操作のとき、取得中の状況を待つ最大の時間 */
const ENSURE_WAIT_MS = 1_500;
/** 画面を開く指示を出してから、実際に表示されるまでに待つ最大の時間。過ぎたら画面を出さずに進める */
const MODAL_SHOWN_TIMEOUT_MS = 1_000;

interface KnownStatus {
  consented: boolean;
  fetchedAt: number;
}

// ── ブラウザのタブ (ページ) 全体で共有する状態。フックのインスタンスをまたいで、同じ確認を何度も走らせないためのもの ──
let knownStatus: KnownStatus | null = null;
let unavailableUntil = 0;
let inflightStatus: Promise<KnownStatus | null> | null = null;

/** テスト用: 共有している状態を初期化する */
export function resetAiConsentClientStateForTests(): void {
  knownStatus = null;
  unavailableUntil = 0;
  inflightStatus = null;
}

/** 設定ページで撤回・同意をしたあとなど、覚えている状況を捨てて、次の操作で取り直させる */
export function forgetAiConsentStatus(): void {
  knownStatus = null;
  unavailableUntil = 0;
}

function loadStatus(): Promise<KnownStatus | null> {
  if (inflightStatus) return inflightStatus;
  const run = (async () => {
    // fetchAiConsentStatus は失敗しても例外を投げない作りだが、万一投げても AI の操作を止めない
    let status: Awaited<ReturnType<typeof fetchAiConsentStatus>> = null;
    try {
      status = await fetchAiConsentStatus();
    } catch {
      status = null;
    }
    if (!status) {
      unavailableUntil = Date.now() + UNAVAILABLE_BACKOFF_MS;
      return null;
    }
    unavailableUntil = 0;
    knownStatus = { consented: status.consented, fetchedAt: Date.now() };
    return knownStatus;
  })().finally(() => {
    inflightStatus = null;
  });
  inflightStatus = run;
  return run;
}

/** ページを開いたとき。必要なときだけ、状況の取得を先に始めておく */
function prefetchStatus(): void {
  if (inflightStatus) return;
  if (knownStatus && Date.now() - knownStatus.fetchedAt < STATUS_FRESH_MS) return;
  if (Date.now() < unavailableUntil) return;
  void loadStatus();
}

/** 取得中の状況を最大 ms だけ待つ。間に合わなければ null */
function waitForStatus(ms: number): Promise<KnownStatus | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    loadStatus().then(
      (status) => {
        clearTimeout(timer);
        resolve(status);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

// ── 「あとで」の期限 (localStorage。使えない環境では覚えない) ──
function isLaterActive(): boolean {
  try {
    const raw = window.localStorage.getItem(AI_CONSENT_LATER_STORAGE_KEY);
    const until = raw ? Number(raw) : 0;
    return Number.isFinite(until) && until > Date.now();
  } catch {
    return false;
  }
}

function rememberLater(): void {
  try {
    window.localStorage.setItem(AI_CONSENT_LATER_STORAGE_KEY, String(Date.now() + AI_CONSENT_LATER_SNOOZE_MS));
  } catch {
    // localStorage が使えなくても、この操作は進む
  }
}

function forgetLater(): void {
  try {
    window.localStorage.removeItem(AI_CONSENT_LATER_STORAGE_KEY);
  } catch {
    // 使えない環境では何もしない
  }
}

interface ModalState {
  open: boolean;
  submitting: boolean;
  error: string | null;
}

const CLOSED: ModalState = { open: false, submitting: false, error: null };

export interface UseAiConsentOptions {
  /**
   * ページを開いたときに、同意の状況の取得を先に始めておくか (既定 true)。
   * 全ページに常駐する部品 (AI 相談の吹き出しなど) は、使われるまで取得しないよう false にして、AI を使いそうになったとき
   * (相談の画面を開いたときなど) に true にする。false のままでも、ensureAiConsent() のときに取得する (最大 1.5 秒待つ)。
   */
  prefetch?: boolean;
}

export function useAiConsent(options: UseAiConsentOptions = {}): {
  ensureAiConsent: () => Promise<AiConsentOutcome>;
  consentModal: ReactNode;
} {
  const { prefetch = true } = options;
  const [modal, setModal] = useState<ModalState>(CLOSED);
  const mountedRef = useRef(false);
  const shownRef = useRef(false);
  const shownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 画面で利用者の選択を待っているときの、選択を受け取る口
  const pendingRef = useRef<{ resolve: (outcome: AiConsentOutcome) => void } | null>(null);
  // 同時に何度 ensureAiConsent() が呼ばれても、確認と選択は 1 回にまとめる
  const sharedRef = useRef<Promise<AiConsentOutcome> | null>(null);

  const clearShownTimer = useCallback(() => {
    if (shownTimerRef.current) {
      clearTimeout(shownTimerRef.current);
      shownTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      // 画面を出している間にページを離れたら、待っていた操作は再開しない (pendingRef は解決せずに捨てる)
      mountedRef.current = false;
      pendingRef.current = null;
      sharedRef.current = null;
      clearShownTimer();
    };
  }, [clearShownTimer]);

  // ページを開いたとき (または prefetch が true になったとき) に、必要なら状況の取得を先に始める
  useEffect(() => {
    if (prefetch) prefetchStatus();
  }, [prefetch]);

  const closeWith = useCallback(
    (outcome: AiConsentOutcome) => {
      clearShownTimer();
      setModal(CLOSED);
      const pending = pendingRef.current;
      pendingRef.current = null;
      pending?.resolve(outcome);
    },
    [clearShownTimer],
  );

  const openModal = useCallback((): Promise<AiConsentOutcome> => {
    return new Promise<AiConsentOutcome>((resolve) => {
      const pending = { resolve };
      pendingRef.current = pending;
      shownRef.current = false;
      setModal({ open: true, submitting: false, error: null });

      // 画面が表示されなければ (consentModal を描画していないなど)、待たずに進める
      clearShownTimer();
      shownTimerRef.current = setTimeout(() => {
        shownTimerRef.current = null;
        if (shownRef.current || pendingRef.current !== pending) return;
        console.error(
          "[useAiConsent] 同意の画面が表示されなかったため、待たずに進めます。useAiConsent() の consentModal を描画していますか？",
        );
        closeWith("skipped");
      }, MODAL_SHOWN_TIMEOUT_MS);
    });
  }, [clearShownTimer, closeWith]);

  const ensureAiConsent = useCallback((): Promise<AiConsentOutcome> => {
    try {
      // ページを離れたあとに呼ばれた場合は、画面を出せない。何もせず進める
      if (!mountedRef.current) return Promise.resolve("skipped");
      // 確認中・選択待ちの間に呼ばれたら、同じ選択を待つ
      if (sharedRef.current) return sharedRef.current;
      // 同意済み。ここを通る操作はネットワークを待たない
      if (knownStatus?.consented) return Promise.resolve("consented");
      // 「あとで」を選んでから 24 時間は出さない
      if (isLaterActive()) return Promise.resolve("later");
      // 状況が分からず、直前に取得に失敗している。確認を省いて進める
      if (!knownStatus && Date.now() < unavailableUntil) return Promise.resolve("skipped");

      const run = (async (): Promise<AiConsentOutcome> => {
        const status = knownStatus ?? (await waitForStatus(ENSURE_WAIT_MS));
        if (!status) return "skipped";
        if (status.consented) return "consented";
        if (!mountedRef.current) return "skipped";
        return openModal();
      })()
        .catch((): AiConsentOutcome => "skipped")
        .finally(() => {
          sharedRef.current = null;
        });
      sharedRef.current = run;
      return run;
    } catch {
      return Promise.resolve("skipped");
    }
  }, [openModal]);

  const handleLater = useCallback(() => {
    rememberLater();
    closeWith("later");
  }, [closeWith]);

  const handleAccept = useCallback(async () => {
    const pending = pendingRef.current;
    setModal({ open: true, submitting: true, error: null });
    const result = await postAiConsentGrant();

    if (result.ok && result.data.consented) {
      // 記録できた。利用者が待っている間に「あとで」で閉じていても、状況は更新しておく
      knownStatus = { consented: true, fetchedAt: Date.now() };
      unavailableUntil = 0;
      forgetLater();
      if (pendingRef.current === pending) closeWith("consented");
      return;
    }

    // 記録できなかった。閉じずにメッセージを出す (「あとで」はいつでも押せる)
    if (!mountedRef.current || pendingRef.current !== pending) return;
    const message = result.ok
      ? "同意を記録できませんでした。もう一度お試しください。"
      : result.message;
    setModal({ open: true, submitting: false, error: message });
  }, [closeWith]);

  const handleShown = useCallback(() => {
    shownRef.current = true;
  }, []);

  const consentModal: ReactNode = modal.open ? (
    <AiDataConsentModal
      isOpen
      isSubmitting={modal.submitting}
      errorMessage={modal.error}
      onAccept={handleAccept}
      onLater={handleLater}
      onShown={handleShown}
    />
  ) : null;

  return { ensureAiConsent, consentModal };
}
