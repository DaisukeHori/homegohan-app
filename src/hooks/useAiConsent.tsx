"use client";

// 外国の AI 事業者への提供の同意: AI の入口で、未同意なら同意画面を出すフック (T15 / #1154)
//
// 使い方 (AI にデータを送る操作の先頭で呼ぶ):
//
//   const { ensureAiConsent, consentModal } = useAiConsent();
//   ...
//   const onAnalyze = async () => {
//     if ((await ensureAiConsent()) === "declined") return;   // 「同意しない」なら送らない
//     await aiFetch("/api/ai/...");
//   };
//   return (<>... {consentModal}</>);   // 画面の出る場所 (どこに置いてもよい。body 直下に描画される)
//
// 【未同意なら AI へ送らない】
//   止めるのはサーバー (送る手前で 403 AI_CONSENT_REQUIRED を返す。src/lib/ai/consent-guard.ts)。このフックは、
//   止められる前に利用者へ同意画面を出して、同意すればそのまま操作を続け、同意しなければ操作をやめさせるためのもの。
//   - ensureAiConsent() は reject しない。戻り値:
//       'consented' 同意済み・いま同意した → 操作を続ける
//       'declined'  「同意しない」(Esc も同じ) → 呼び出し側は AI へ送る操作をやめる
//       'skipped'   状況が取れなかった・画面が出せなかった → 操作を続ける (送ってよいかはサーバーが判定し、
//                   未同意なら 403 になる。aiFetch がそれを受けて、全画面共通の同意画面 (AiConsentRequiredHost) を出す)
//   - 同意の状況の取得は、ページを開いたときに先に済ませておく (prefetch。useAiConsent({ prefetch: false }) で止められる)。
//     取得が終わっていなければ最大 ENSURE_WAIT_MS だけ待ち、それでも取れなければ画面を出さずに進める ('skipped')。
//     取得に失敗した直後は、UNAVAILABLE_BACKOFF_MS のあいだ状況の確認自体を省く (障害時に毎回待たせない)。
//   - 「同意しない」はサーバーに記録しない (拒否の行は作らない)。次に AI の操作をしたときに、もう一度画面を出す。
//   - 同意の記録に失敗したときは、画面にメッセージを出して閉じずに待つ (「同意しない」はいつでも押せる)。
//   - 同意済みの状況は、このページを開いている間は覚えておく。サインアウト (clearUserScopedLocalStorage) で捨てる:
//     同じタブで別の利用者がログインしても、前の利用者の状況を引き継がない (取得の途中だったものも、結果を覚えない)。
//     サーバーに 403 AI_CONSENT_REQUIRED で止められたとき (別のタブで撤回したなど) も捨てる (src/lib/ai/consent-required.ts)。
//   - 画面が出ている間に、その画面を使っているページから離れたとき (戻る操作など) は、待っていた操作を再開しない。
//   - 呼び出し側が consentModal を描画し忘れた場合: 画面が MODAL_SHOWN_TIMEOUT_MS 以内に表示されなければ 'skipped' として進める
//     (console.error で知らせる。サーバーが止めるので、未同意のまま送られることはない)。
//   - promptAiConsent() は、状況に関わらず同意画面を出す (サーバーに止められたとき用。AiConsentRequiredHost が使う)。

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AiDataConsentModal } from "@/components/consent/AiDataConsentModal";
import { fetchAiConsentStatus, postAiConsentGrant } from "@/lib/ai/consent-client";
import { AI_CONSENT_REQUIRED_EVENT } from "@/lib/ai/consent-required";
import { USER_SCOPED_STORAGE_CLEARED_EVENT } from "@/lib/user-storage";

export type AiConsentOutcome = "consented" | "declined" | "skipped";

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
/** 覚えている状況を捨てるたびに増やす。捨てる前に始めた取得の結果 (前の利用者の結果など) を覚えないための目印 */
let statusEpoch = 0;

/** テスト用: 共有している状態を初期化する */
export function resetAiConsentClientStateForTests(): void {
  knownStatus = null;
  unavailableUntil = 0;
  inflightStatus = null;
  statusEpoch = 0;
}

/**
 * 覚えている状況を捨てて、次の操作で取り直させる。
 * 設定ページで撤回・同意をしたあと、サインアウトのとき (別の利用者が同じタブでログインしても、前の利用者の状況を引き継がない)。
 * 取得の途中だったものは、結果が戻っても覚えない。
 */
export function forgetAiConsentStatus(): void {
  knownStatus = null;
  unavailableUntil = 0;
  inflightStatus = null;
  statusEpoch += 1;
}

// サインアウトで利用者別の保存が消されたら、メモリの状況も捨てる (src/lib/user-storage.ts)。
// サーバーに 403 AI_CONSENT_REQUIRED で止められたとき (別のタブで撤回した・文面の版が上がったなど) も、覚えていた「同意済み」を捨てる
if (typeof window !== "undefined") {
  window.addEventListener(USER_SCOPED_STORAGE_CLEARED_EVENT, forgetAiConsentStatus);
  window.addEventListener(AI_CONSENT_REQUIRED_EVENT, forgetAiConsentStatus);
}

function loadStatus(): Promise<KnownStatus | null> {
  if (inflightStatus) return inflightStatus;
  const startedEpoch = statusEpoch;
  const run: Promise<KnownStatus | null> = (async () => {
    // fetchAiConsentStatus は失敗しても例外を投げない作りだが、万一投げても AI の操作を止めない
    let status: Awaited<ReturnType<typeof fetchAiConsentStatus>> = null;
    try {
      status = await fetchAiConsentStatus();
    } catch {
      status = null;
    }
    // 取得している間に覚えている状況を捨てられた (サインアウトなど)。結果は待っていた呼び出し元にだけ返し、覚えない
    const stale = startedEpoch !== statusEpoch;
    if (!status) {
      if (!stale) unavailableUntil = Date.now() + UNAVAILABLE_BACKOFF_MS;
      return null;
    }
    const known: KnownStatus = { consented: status.consented, fetchedAt: Date.now() };
    if (!stale) {
      unavailableUntil = 0;
      knownStatus = known;
    }
    return known;
  })().finally(() => {
    if (inflightStatus === run) inflightStatus = null;
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

interface ModalState {
  open: boolean;
  submitting: boolean;
  error: string | null;
  /** サーバーに止められて出した画面 (「この機能を使うには同意が必要です」の一文を足す) */
  required: boolean;
}

const CLOSED: ModalState = { open: false, submitting: false, error: null, required: false };

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
  promptAiConsent: () => Promise<AiConsentOutcome>;
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

  const openModal = useCallback((required: boolean): Promise<AiConsentOutcome> => {
    return new Promise<AiConsentOutcome>((resolve) => {
      const pending = { resolve };
      pendingRef.current = pending;
      shownRef.current = false;
      setModal({ open: true, submitting: false, error: null, required });

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
      // 状況が分からず、直前に取得に失敗している。確認を省いて進める
      if (!knownStatus && Date.now() < unavailableUntil) return Promise.resolve("skipped");

      const run = (async (): Promise<AiConsentOutcome> => {
        const status = knownStatus ?? (await waitForStatus(ENSURE_WAIT_MS));
        if (!status) return "skipped";
        if (status.consented) return "consented";
        if (!mountedRef.current) return "skipped";
        return openModal(false);
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

  /**
   * 状況に関わらず同意画面を出す (サーバーに 403 AI_CONSENT_REQUIRED で止められたとき)。
   * すでに画面を出している (選択を待っている) ときは、その選択を待つ。
   */
  const promptAiConsent = useCallback((): Promise<AiConsentOutcome> => {
    try {
      if (!mountedRef.current) return Promise.resolve("skipped");
      if (sharedRef.current) return sharedRef.current;
      const run = openModal(true)
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

  const handleDecline = useCallback(() => {
    // 記録はしない (拒否の行は作らない)。次に AI の操作をしたときに、もう一度画面を出す
    closeWith("declined");
  }, [closeWith]);

  const handleAccept = useCallback(async () => {
    const pending = pendingRef.current;
    setModal((prev) => ({ ...prev, open: true, submitting: true, error: null }));
    const result = await postAiConsentGrant();

    if (result.ok && result.data.consented) {
      // 記録できた。利用者が待っている間に「同意しない」で閉じていても、状況は更新しておく
      knownStatus = { consented: true, fetchedAt: Date.now() };
      unavailableUntil = 0;
      if (pendingRef.current === pending) closeWith("consented");
      return;
    }

    // 記録できなかった。閉じずにメッセージを出す (「同意しない」はいつでも押せる)
    if (!mountedRef.current || pendingRef.current !== pending) return;
    const message = result.ok
      ? "同意を記録できませんでした。もう一度お試しください。"
      : result.message;
    setModal((prev) => ({ ...prev, open: true, submitting: false, error: message }));
  }, [closeWith]);

  const handleShown = useCallback(() => {
    shownRef.current = true;
  }, []);

  const consentModal: ReactNode = modal.open ? (
    <AiDataConsentModal
      isOpen
      isSubmitting={modal.submitting}
      errorMessage={modal.error}
      required={modal.required}
      onAccept={handleAccept}
      onDecline={handleDecline}
      onShown={handleShown}
    />
  ) : null;

  return { ensureAiConsent, promptAiConsent, consentModal };
}
