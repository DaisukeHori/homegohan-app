// Vercel Speed Insights に送る計測値の URL から、個人情報と招待用の値を消す (#1179)
// Canonical: docs/design/operator/07-audit-monitoring.md §7.3

import type { BeforeSendMiddleware } from '@vercel/speed-insights';

/**
 * 背景
 *
 * Vercel が配る計測スクリプトは、計測値に `location.href` (`?` 以降と `#` 以降を含む URL 全体) をそのまま載せて送る
 * (パッケージが `data-path` を付けないため)。このアプリには、URL に次のものが入るページがある。
 *   - 招待先のメールアドレス: /login?redirect=/invite/<token>&email=<メールアドレス>、/signup?…&email=…、/auth/verify?email=…
 *   - パスに入る招待トークン: /invite/<token>、/family/promotions/<token>
 * 本番の Speed Insights はすでに有効とみられるので、対策なしでデプロイすると、デプロイした時点から、
 * これらが計測データとして Vercel に残る。
 *
 * `beforeSend` の仕様 (配られるスクリプトの scriptVersion 0.1.3 を読んで確認した)
 *   - 計測値を送る直前に 1 件ずつ呼ばれ、`{ type: 'vital', url, route }` を受け取る。
 *   - null など (falsy) を返すと、その 1 件は送られない。
 *   - 返した `url` が送られる。`route` は返した値が使われず、元の `data-route` のまま送られる。
 *     そのため route に生のトークンが残っているとき (動的セグメントの置き換えに失敗したとき) は、直さずに送らない。
 *
 * 同じ種類の処理が PostHog 向けにもある (src/lib/posthog.ts の redactTokenPath。こちらは /family/promotions だけ)。
 */

/**
 * パスそのものに招待用のトークンが入るページの接頭辞 (`/invite/[token]`、`/family/promotions/[token]`)。
 * `[token]` のページを足したら、ここにも足す (tests/speed-insights-scrub-1179.test.ts が、src/app の `[token]` を検査する)。
 * Next.js のパスは大文字と小文字を区別するので、`/INVITE/<token>` は 404 の画面になるが、
 * その URL にも計測値は付くので、大文字と小文字は区別せずに調べる。
 */
const TOKEN_PATH_PREFIX = /^\/(?:invite|family\/promotions)\//i;

/** 接頭辞の直後が、トークンの置き換え (`[token]` など) になっている */
const TOKEN_PLACEHOLDER = /^\/(?:invite|family\/promotions)\/\[[^\]/]+\](?:\/|$)/i;

/**
 * Speed Insights の `beforeSend` に渡す関数。
 *
 * - `?` 以降、`#` 以降、ユーザー名、パスワードを消す (オリジンとパスだけを残す)。
 * - `route` (動的セグメントを `[token]` のように置き換えた形。例: `/invite/[token]`) があれば、パスはそれにする。
 *   トークンや ID が url に残らない。
 * - 送るパスが、招待トークンの入るページのもので、トークンが `[token]` に置き換わっていないときは、計測値ごと送らない (null)。
 *   route が無いとき、route の置き換えに失敗したとき (生のトークンが残っているとき) が該当する。
 * - URL として読めないときも送らない。
 *
 * モジュール直下に置いて参照を変えない。Speed Insights は、参照が変わるたびに `beforeSend` を登録し直す。
 */
export const scrubSpeedInsightsEvent: BeforeSendMiddleware = (event) => {
  try {
    const original = new URL(event.url);

    const route = typeof event.route === 'string' && event.route.startsWith('/') ? event.route : null;
    const path = route ?? original.pathname;

    if (TOKEN_PATH_PREFIX.test(path) && !TOKEN_PLACEHOLDER.test(path)) {
      return null;
    }

    // origin だけを引き継ぐ。pathname は代入すると、`?` や `#` も文字として (%3F、%23 に) 扱われる
    const scrubbed = new URL(original.origin);
    scrubbed.pathname = path;
    return { ...event, url: scrubbed.toString() };
  } catch {
    // URL として読めないものは、消し損ねるより、1 件落とす方がよい
    return null;
  }
};
