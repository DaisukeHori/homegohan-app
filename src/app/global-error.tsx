"use client";

import { useEffect } from "react";
import { reportBoundaryError, toDisplayErrorCode } from "@/lib/report-boundary-error";

/**
 * ルートの layout 自体が例外を投げたときだけ出る、最後の受け皿。
 * 通常の画面の例外は、より内側の error.tsx (#1207) が受けるので、ここまでは届かない。
 * ルートの layout が壊れているので、スタイルは globals.css に頼らず inline で書く。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // コンソールとサーバーログ (app_logs) に記録する (#1207)
    reportBoundaryError("global", error);
  }, [error]);

  const errorCode = toDisplayErrorCode(error.digest);

  return (
    <html lang="ja">
      <body>
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "#FAF9F7",
            fontFamily: "sans-serif",
            padding: "24px",
            textAlign: "center",
          }}
        >
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: "50%",
              backgroundColor: "#FFEBEE",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 32,
              marginBottom: 24,
            }}
          >
            !
          </div>
          <h1
            style={{
              fontSize: 20,
              fontWeight: "bold",
              color: "#1A1A1A",
              marginBottom: 8,
            }}
          >
            予期しないエラーが発生しました
          </h1>
          <p
            style={{
              fontSize: 14,
              color: "#9A9A9A",
              marginBottom: 32,
              maxWidth: 320,
            }}
          >
            しばらく時間をおいてから再度お試しください。
            {errorCode && (
              <span style={{ display: "block", marginTop: 8, fontSize: 12 }}>
                エラーコード: {errorCode}
              </span>
            )}
          </p>
          <div style={{ display: "flex", gap: 12 }}>
            <button
              onClick={reset}
              style={{
                padding: "12px 24px",
                borderRadius: 9999,
                backgroundColor: "#E07A5F",
                color: "#FFFFFF",
                fontWeight: "bold",
                fontSize: 14,
                border: "none",
                cursor: "pointer",
              }}
            >
              再試行
            </button>
            <a
              href="/home"
              style={{
                padding: "12px 24px",
                borderRadius: 9999,
                backgroundColor: "#EEEEEE",
                color: "#1A1A1A",
                fontWeight: "bold",
                fontSize: 14,
                textDecoration: "none",
                display: "inline-block",
              }}
            >
              ホームへ戻る
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
