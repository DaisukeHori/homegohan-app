/**
 * Cloudflare Turnstile を、外のネットワーク (challenges.cloudflare.com) に繋がずに動かす (#1672)。
 *
 * Cloudflare 公式のテスト用サイトキー (1x00000000000000000000AA) を使っても、ウィジェットの本体 (api.js) と
 * 確認の iframe は challenges.cloudflare.com から読む。常設の e2e では、この外の通信の遅れ・失敗で
 * 「新規登録」「メール確認の再送 #1474」が落ちることがあった。
 *
 * ここでは、ブラウザの challenges.cloudflare.com への通信を page.route で手元の応答に差し替える。
 *   - api.js: window.turnstile (render / reset / remove) を作る小さなスクリプト。render すると、
 *     本物と同じく challenges.cloudflare.com の iframe を container に置き、テスト用サイトキーが出すのと同じ
 *     ダミーのトークン (CLOUDFLARE_TEST_DUMMY_TOKEN) を callback に渡す。
 *   - それ以外 (iframe の中身): 空の HTML。
 * URL は本物と同じなので、この文書の CSP (next.config.mjs の script-src / frame-src) の判定はそのまま受ける
 * (差し替えはブラウザが通信を出したあとに効く。CSP に止められた通信は差し替えまで届かない)。
 *
 * 本物のウィジェットが本物の CSP の下でトークンを出すこと自体は、auth-turnstile.spec.ts のログイン・パスワード再設定のテストが、
 * 引き続き本物の api.js で確かめる。
 * アプリが呼ぶ window.turnstile の形は src/lib/auth/turnstile.ts の TurnstileApi / TurnstileRenderOptions。
 */
import type { Page } from "@playwright/test";

/**
 * Cloudflare 公式のテスト用サイトキーが出すダミーのトークン。
 * https://developers.cloudflare.com/turnstile/troubleshooting/testing/ (「Test sitekeys generate "XXXX.DUMMY.TOKEN.XXXX"」)
 */
export const CLOUDFLARE_TEST_DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

/** challenges.cloudflare.com への通信 (api.js・iframe) */
const CLOUDFLARE_CHALLENGES_URL = /^https:\/\/challenges\.cloudflare\.com\//;
/** api.js のパス (src/lib/auth/turnstile.ts の TURNSTILE_SCRIPT_SRC) */
const API_JS_PATH = "/turnstile/v0/api.js";
/** 差し替えた iframe が読む URL (本物の確認の iframe と同じホスト。frame-src の判定を受ける) */
const WIDGET_FRAME_URL = "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/e2e-offline-widget";

/**
 * window.turnstile の差し替え。トークンは render / reset のあと、次のタスクで callback に渡す
 * (本物も非同期に渡す。同じ呼び出しの中で渡すと、アプリが render の戻り値の widgetId を受け取る前に callback が走る)
 */
function offlineApiJs(token: string, frameUrl: string): string {
  return `(() => {
  const TOKEN = ${JSON.stringify(token)};
  const FRAME_URL = ${JSON.stringify(frameUrl)};
  const widgets = new Map();
  let sequence = 0;
  let lastId;
  const issue = (id) => {
    setTimeout(() => {
      const widget = widgets.get(id);
      if (widget && typeof widget.options.callback === "function") widget.options.callback(TOKEN);
    }, 0);
  };
  window.turnstile = {
    render(container, options) {
      const element = typeof container === "string" ? document.querySelector(container) : container;
      if (!element) return undefined;
      sequence += 1;
      const id = "e2e-offline-" + sequence;
      const frame = document.createElement("iframe");
      frame.src = FRAME_URL;
      frame.title = "Turnstile (e2e offline)";
      element.appendChild(frame);
      widgets.set(id, { options: options || {}, frame });
      lastId = id;
      issue(id);
      return id;
    },
    reset(id) {
      issue(id === undefined ? lastId : id);
    },
    remove(id) {
      const key = id === undefined ? lastId : id;
      const widget = widgets.get(key);
      if (widget) widget.frame.remove();
      widgets.delete(key);
    },
  };
})();
`;
}

/**
 * このページの challenges.cloudflare.com への通信を手元の応答に差し替える。page.goto の前に呼ぶ。
 * 返す関数は、api.js が何回読まれたか (差し替えが実際に使われたか) を返す
 */
export async function serveTurnstileOffline(page: Page): Promise<{ apiJsLoads: () => number }> {
  let apiJsLoads = 0;
  await page.route(CLOUDFLARE_CHALLENGES_URL, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === API_JS_PATH) {
      apiJsLoads++;
      await route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: offlineApiJs(CLOUDFLARE_TEST_DUMMY_TOKEN, WIDGET_FRAME_URL),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>e2e offline</title>" });
  });
  return { apiJsLoads: () => apiJsLoads };
}
