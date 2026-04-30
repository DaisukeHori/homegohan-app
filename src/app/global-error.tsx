"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // エラーをコンソールに記録（本番では app_logs 等に送信）
    console.error("[GlobalError]", error);
  }, [error]);

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
            {error.digest && (
              <span style={{ display: "block", marginTop: 8, fontSize: 12 }}>
                エラーコード: {error.digest}
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
