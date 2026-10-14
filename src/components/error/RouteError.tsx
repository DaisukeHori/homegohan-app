"use client";

/**
 * 画面の描画中に起きた例外を受ける、共通のエラー画面 (#1207)
 *
 * 各 route group の error.tsx はこの部品を呼ぶだけにする。error.tsx は自分の segment の layout の中に
 * 描画されるので、サイドバーやヘッダーを残したまま、その内側だけを差し替えて「再試行」を出せる。
 * (error.tsx が無い範囲の例外は、ルート全体を置き換える global-error.tsx まで届いてしまう)
 *
 * 守ること:
 *  - 例外の文面・スタックは画面に出さない。出すのは digest (サーバーのログと突き合わせる短い ID) だけ
 *  - 例外は表示時に 1 回だけ記録する (src/lib/report-boundary-error.ts)
 *  - 「再試行」は router.refresh() と reset() を一緒に呼ぶ。サーバーコンポーネントが投げた例外は、
 *    reset() だけだと同じ結果 (同じ例外) を描き直すだけで直らないため、サーバー側のデータも取り直す
 */

import { useEffect, useRef, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { reportBoundaryError, toDisplayErrorCode } from "@/lib/report-boundary-error";

export interface RouteErrorProps {
  /** Next.js が error.tsx に渡す例外 (本番のサーバー側の例外は文面が伏せられ、digest だけが付く) */
  error: Error & { digest?: string };
  /** Next.js が error.tsx に渡す、境界の中身を描き直す関数 */
  reset: () => void;
  /** どの境界か。ログに残す (URL は秘密を含み得るので、パスの代わりにこれを使う) */
  boundary: string;
  /** 「戻る」リンクの行き先と文言 */
  backHref: string;
  backLabel: string;
  /** true: 画面全体を使う。false (既定): サイドバーなどのレイアウトの中に収める */
  fullScreen?: boolean;
}

export function RouteError({
  error,
  reset,
  boundary,
  backHref,
  backLabel,
  fullScreen = false,
}: RouteErrorProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const reportedError = useRef<unknown>(null);

  useEffect(() => {
    // 同じ例外は 1 回だけ記録する。開発時の StrictMode は effect を 2 回走らせる (ref は引き継がれる) ので、
    // その分の二重記録をここで防ぐ。再試行して別の例外が出たときは、新しい例外として記録される
    if (reportedError.current === error) return;
    reportedError.current = error;
    reportBoundaryError(boundary, error);
  }, [boundary, error]);

  const retry = () => {
    startTransition(() => {
      // サーバーコンポーネントの例外は、サーバー側のデータを取り直してから描き直さないと直らない
      router.refresh();
      reset();
    });
  };

  const errorCode = toDisplayErrorCode(error.digest);

  return (
    <div
      className={`flex flex-col items-center justify-center px-6 py-12 text-center ${
        fullScreen ? "min-h-screen" : "min-h-[60vh]"
      }`}
      style={fullScreen ? { backgroundColor: "#FAF9F7" } : undefined}
    >
      <div role="alert" className="flex flex-col items-center">
        <div
          aria-hidden="true"
          className="w-16 h-16 rounded-full flex items-center justify-center text-3xl mb-6"
          style={{ backgroundColor: "#FFEBEE", color: "#E53935" }}
        >
          !
        </div>
        <h1 className="text-xl font-bold mb-2" style={{ color: "#1A1A1A" }}>
          エラーが発生しました
        </h1>
        <p className="text-sm mb-8 max-w-sm" style={{ color: "#6B6B6B" }}>
          <span className="block">ページの読み込み中に問題が起きました。</span>
          <span className="block">もう一度お試しください。</span>
          {errorCode && (
            <span className="block mt-2 text-xs">エラーコード: {errorCode}</span>
          )}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={retry}
          disabled={isPending}
          aria-busy={isPending}
          className="px-6 py-3 rounded-full font-bold text-sm text-white disabled:opacity-60"
          style={{ backgroundColor: "#E07A5F" }}
        >
          {isPending ? "再読み込み中…" : "再試行"}
        </button>
        <Link
          href={backHref}
          className="px-6 py-3 rounded-full font-bold text-sm"
          style={{ backgroundColor: "#EEEEEE", color: "#1A1A1A" }}
        >
          {backLabel}
        </Link>
      </div>
    </div>
  );
}
