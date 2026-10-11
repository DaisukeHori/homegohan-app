/**
 * apps/mobile の Jest の時間切れの既定 (jest.config.js の testTimeout と jest.setup.js の RNTL の asyncUtilTimeout)。
 *
 * 根拠 (2026-10-11、#1149 の是正のローカル CI):
 *   M2 の負荷が高いとき (load average 50〜77。ほかのセッションの local-ci が並走) に mobile:jest を回すと、
 *   単独で軽い機械なら緑のテストが、Jest の既定の 5 秒の時間切れで毎回落ちた (3 回連続で同じ 2 件)。
 *   同じテストの所要は、M1 (軽いとき) と M2 (重いとき) で次のとおり (どちらも同じテストの中身):
 *     - advisor-sheet-consent「送信が『同意が必要です』で止められたとき」 0.86 秒 → 8.5 秒 (5 秒で時間切れ)
 *     - chat-stream「既存のメッセージが表示される」 (ファイルの最初のテスト)  0.66 秒 → 6.6 秒 (5 秒で時間切れ)
 *     - chat-stream「テキスト送信後、楽観的メッセージが表示される」 0.23 秒 → 1.6 秒 (RNTL の waitFor の既定 1 秒で落ちた回がある)
 *   つまり負荷で所要は 10 倍ほどに伸びる。それまでは時間切れで落ちたファイルごとに jest.setTimeout(30000) や
 *   { timeout: 5000 } を書き足していた (15 ファイル) が、書いていないファイルが次に落ちるので、既定そのものをここで延ばす。
 *
 *   - 1 件のテスト (it) の時間切れ: 30 秒。それまでファイルごとに書いていた値と同じで、上の最大 8.5 秒の 3 倍以上の余裕がある。
 *   - RNTL の waitFor / findBy* の待ちの既定: 5 秒。それまでテストが { timeout: 5000 } で個別に書いていた値と同じ
 *     (「非同期の段数が多く、遅い環境で既定の 1 秒では足りないことがある」)。1 件のテストに waitFor が何段か入っても
 *     テストの時間切れに先に当たらないよう、テストの時間切れより小さくなければならない (逆だと待ちの余裕が意味を失う)。
 *
 * 時間切れが効くのは遅いときだけで、速く終わるテストの所要は変わらない (止まったテストを見切るまでが長くなるだけ)。
 * 待つ条件そのもの (expect) は変わらないので、検査は緩まない。
 * 機械に合わせて変えるときは環境変数 (MOBILE_JEST_TEST_TIMEOUT_MS / MOBILE_JEST_ASYNC_UTIL_TIMEOUT_MS) で上書きする
 * (scripts/local-ci.sh は、この 2 つを mobile の段に持ち込む)。
 */

/** 1 件のテストの時間切れの既定 (ミリ秒)。根拠は上のコメント */
const DEFAULT_MOBILE_JEST_TEST_TIMEOUT_MS = 30_000;
/** RNTL の waitFor / findBy* の待ちの既定 (ミリ秒)。根拠は上のコメント */
const DEFAULT_MOBILE_JEST_ASYNC_UTIL_TIMEOUT_MS = 5_000;
const TEST_TIMEOUT_ENV = 'MOBILE_JEST_TEST_TIMEOUT_MS';
const ASYNC_UTIL_TIMEOUT_ENV = 'MOBILE_JEST_ASYNC_UTIL_TIMEOUT_MS';

/**
 * 環境変数の時間切れ (正の整数のミリ秒)。無い・空なら既定。整数でなければ設定の誤りとして止める (黙って既定に戻さない)。
 * vitest.integration.config.ts の timeoutFromEnv と同じ規則。
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function timeoutFromEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} は正の整数 (ミリ秒) にしてください: ${raw}`);
  }
  return value;
}

/**
 * Jest の時間切れを環境変数と既定から決める。待ちの既定がテストの時間切れ以上なら止める (待ちの余裕が意味を失うため)。
 * @param {Record<string, string | undefined>} env
 * @returns {{ testTimeout: number; asyncUtilTimeout: number }}
 */
function resolveMobileJestTimeouts(env) {
  const testTimeout = timeoutFromEnv(env, TEST_TIMEOUT_ENV, DEFAULT_MOBILE_JEST_TEST_TIMEOUT_MS);
  const asyncUtilTimeout = timeoutFromEnv(env, ASYNC_UTIL_TIMEOUT_ENV, DEFAULT_MOBILE_JEST_ASYNC_UTIL_TIMEOUT_MS);
  if (asyncUtilTimeout >= testTimeout) {
    throw new Error(
      `${ASYNC_UTIL_TIMEOUT_ENV} (${asyncUtilTimeout}) は ${TEST_TIMEOUT_ENV} (${testTimeout}) より小さくしてください`,
    );
  }
  return { testTimeout, asyncUtilTimeout };
}

module.exports = {
  DEFAULT_MOBILE_JEST_TEST_TIMEOUT_MS,
  DEFAULT_MOBILE_JEST_ASYNC_UTIL_TIMEOUT_MS,
  TEST_TIMEOUT_ENV,
  ASYNC_UTIL_TIMEOUT_ENV,
  timeoutFromEnv,
  resolveMobileJestTimeouts,
};
