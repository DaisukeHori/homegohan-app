"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function MainError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[MainError]", error);
  }, [error]);

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center px-6 text-center"
      style={{ backgroundColor: "#FAF9F7" }}
    >
      <div
        className="w-16 h-16 rounded-full flex items-center justify-center text-3xl mb-6"
        style={{ backgroundColor: "#FFEBEE" }}
      >
        !
      </div>
      <h1 className="text-xl font-bold mb-2" style={{ color: "#1A1A1A" }}>
        エラーが発生しました
      </h1>
      <p className="text-sm mb-8 max-w-xs" style={{ color: "#9A9A9A" }}>
        ページの読み込み中に問題が起きました。再試行するか、ホームに戻ってください。
        {error.digest && (
          <span className="block mt-2 text-xs">
            エラーコード: {error.digest}
          </span>
        )}
      </p>
      <div className="flex gap-3">
        <button
          onClick={reset}
          className="px-6 py-3 rounded-full font-bold text-sm text-white"
          style={{ backgroundColor: "#E07A5F" }}
        >
          再試行
        </button>
        <Link
          href="/home"
          className="px-6 py-3 rounded-full font-bold text-sm"
          style={{ backgroundColor: "#EEEEEE", color: "#1A1A1A" }}
        >
          ホームへ戻る
        </Link>
      </div>
    </div>
  );
}
