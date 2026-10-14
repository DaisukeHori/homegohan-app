// reset-onboarding.js
// Maestro runScript で呼び出される。
// テストユーザーのアクセストークンを取得し、
// /api/e2e/reset-onboarding エンドポイントを呼び出してオンボーディング状態をリセットする。
//
// Maestro の GraalJsHttp では:
//   http.post(url, { body: string, headers: {} })
//   レスポンス: { body: string, headers: {} } (statusCode は存在しない可能性あり)
//
// アクセストークンの取得 (#1547):
//   Supabase の CAPTCHA を有効にすると、トークンの無いパスワードのログイン (/auth/v1/token?grant_type=password) は断られる。
//   そこで、パスワードのログインは使わず、tests/e2e/helpers/test-session.mjs (e2e と --with-auth の共通の補助関数) と同じ手順でセッションを作る:
//     1. service_role で POST /auth/v1/admin/generate_link ({ type: "recovery", email }) → hashed_token (メールは送られない)
//     2. anon key で POST /auth/v1/verify ({ type: "recovery", token_hash }) → access_token
//   どちらも CAPTCHA の対象外 (根拠は tests/e2e/helpers/test-session.mjs の先頭のコメント)。
//   同じテストユーザーで同時にセッションを作られると (web の e2e など)、後の発行が先のトークンを消し、確認が otp_expired になる。
//   そのときは発行からやり直す (上限は maxAttempts。既定は MAX_ATTEMPTS_DEFAULT)。
//   このファイルは Maestro の JavaScript (GraalJS) で動き、モジュールを import できないので、同じ手順をここにも書いている
//   (この手順の写しはここだけ。ほかの道具は補助関数を import する)。補助関数と食い違わないよう、tests/e2e-test-session.test.ts が
//   type・上書きの環境変数の名前・やり直す回数の解釈 (readMaxAttempts と補助関数の testSessionMaxAttempts に同じ入力を渡す) を突き合わせる。
//
// 要る値 (runScript の env で渡す。_shared/login-for-onboarding.yaml が、シェルの MAESTRO_ 付きの環境変数から渡す):
//   E2E_USER_EMAIL             テストユーザーのメールアドレス
//   SUPABASE_URL               アプリがつながっている Supabase の URL
//   SUPABASE_ANON_KEY          その Supabase の anon key
//   SUPABASE_SERVICE_ROLE_KEY  その Supabase の service_role (管理用の鍵)
// 任意の値 (同じく runScript の env で渡す。渡されなければ既定を使う):
//   E2E_TEST_SESSION_MAX_ATTEMPTS  発行からやり直す回数の上限 (1 以上の整数。シェルの MAESTRO_E2E_TEST_SESSION_MAX_ATTEMPTS から渡す)
// 本番の Supabase には使わない (本番の管理用の鍵を、Maestro を動かす端末に出さないため)。本番の URL や鍵を既定値として持たない。
// 管理用の鍵は、maestro test の -e (コマンドラインに残る) ではなく、シェルの環境変数 MAESTRO_SUPABASE_SERVICE_ROLE_KEY で渡す。

/** runScript の env で渡された値を読む。渡されていない・空・置き換えられていない (${...} のまま / "undefined") なら null */
function readParam(value) {
  if (typeof value !== 'string') return null;
  if (value === '' || value === 'undefined' || value === 'null' || value.indexOf('${') === 0) return null;
  return value;
}

var email = readParam(typeof E2E_USER_EMAIL !== 'undefined' ? E2E_USER_EMAIL : undefined);
var supabaseUrl = readParam(typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : undefined);
var supabaseAnonKey = readParam(typeof SUPABASE_ANON_KEY !== 'undefined' ? SUPABASE_ANON_KEY : undefined);
var serviceRoleKey = readParam(typeof SUPABASE_SERVICE_ROLE_KEY !== 'undefined' ? SUPABASE_SERVICE_ROLE_KEY : undefined);

var missing = [];
if (!email) missing.push('E2E_USER_EMAIL');
if (!supabaseUrl) missing.push('SUPABASE_URL (MAESTRO_SUPABASE_URL)');
if (!supabaseAnonKey) missing.push('SUPABASE_ANON_KEY (MAESTRO_SUPABASE_ANON_KEY)');
if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY (MAESTRO_SUPABASE_SERVICE_ROLE_KEY)');
if (missing.length > 0) {
  // 値は出さない。足りないものの名前だけ出す
  throw new Error(
    'reset-onboarding: 次の値が渡されていません: ' + missing.join(', ') +
      '。本番の Supabase には使いません (apps/mobile/maestro/README.md)'
  );
}
supabaseUrl = supabaseUrl.replace(/\/+$/, '');

// API (Next) の URL。呼び出し側の runScript の env で API_BASE_URL を渡せば、その URL を使う
// (Next を 3000 以外のポートで動かしているとき。渡さなければ今までどおり http://localhost:3000)
var apiBaseUrl = (typeof API_BASE_URL !== 'undefined' && API_BASE_URL) || 'http://localhost:3000';

// generate_link と verify に渡す type。recovery は、ユーザーがいなければ 404 で止まり、ユーザーを作らない
var LINK_TYPE = 'recovery';

/** 応答の本文を JSON として読む。読めなければ null */
function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch (e) {
    return null;
  }
}

/** 失敗の応答から、出してよい部分 (エラーの code・説明) だけを取り出す。トークンや鍵は出さない */
function describeAuthError(data) {
  if (!data) return 'JSON ではない応答';
  return String(data.error_code || data.msg || data.error || 'unknown');
}

// 確認 (/verify) が otp_expired (トークンが見つからない) のとき、発行からやり直す回数の上限の既定 (最初の 1 回を含む)。
// scripts/maestro-parallel-runner.sh は、並列のシミュレーター (PARALLEL_COUNT。既定 10 台) すべてに同じテストユーザー (E2E_USER_01_EMAIL) を渡すので、
// 同時にぶつかりうる。ぶつかった中で最後に発行した側は確認を済ませて抜けるので、やり直すたびに競う数は減っていく。
// tests/e2e/helpers/test-session.mjs の既定 (TEST_SESSION_DEFAULT_MAX_ATTEMPTS) と同じ回数にしてある (tests/e2e-test-session.test.ts が突き合わせる)。
// Maestro の http には status が無いことがあるので、応答の error_code で見分ける。Maestro の JavaScript には待つ手段が無いので、
// 間を空けずにやり直す (1 回の発行 → 確認の往復の時間が、シミュレーターごとにばらつく)。
// 待たずにやり直すので、最悪の場合は 1 周に 1 台しか抜けられない。シミュレーターを増やして足りなくなったときは、
// runScript の env の E2E_TEST_SESSION_MAX_ATTEMPTS (シェルの MAESTRO_E2E_TEST_SESSION_MAX_ATTEMPTS) で上書きする
// (e2e の補助関数・--with-auth と同じ名前・同じ規則。1 以上の整数のときだけ使い、それ以外の値は無視して既定を使う)
var MAX_ATTEMPTS_DEFAULT = 6;

/** やり直す回数の上限。渡された値が 1 以上の整数ならその値、そうでなければ MAX_ATTEMPTS_DEFAULT */
function readMaxAttempts(value) {
  var raw = readParam(value);
  if (raw === null) return MAX_ATTEMPTS_DEFAULT;
  var trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return MAX_ATTEMPTS_DEFAULT;
  var parsed = Number(trimmed);
  if (Number.isSafeInteger(parsed) && parsed >= 1) return parsed;
  return MAX_ATTEMPTS_DEFAULT;
}

var maxAttempts = readMaxAttempts(
  typeof E2E_TEST_SESSION_MAX_ATTEMPTS !== 'undefined' ? E2E_TEST_SESSION_MAX_ATTEMPTS : undefined
);
var VERIFY_RETRY_ERROR_CODE = 'otp_expired';

var authData = null;
for (var attempt = 1; ; attempt++) {
  // Step 1: 管理用の鍵で、ワンタイムのトークン (のハッシュ) を発行する (メールは送られない)
  var linkResponse = http.post(
    supabaseUrl + '/auth/v1/admin/generate_link',
    {
      body: JSON.stringify({ type: LINK_TYPE, email: email }),
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceRoleKey,
        'Authorization': 'Bearer ' + serviceRoleKey
      }
    }
  );
  var linkData = parseJson(linkResponse.body);
  if (!linkData || typeof linkData.hashed_token !== 'string' || !linkData.hashed_token) {
    throw new Error('Auth failed - generate_link: ' + describeAuthError(linkData));
  }

  // Step 2: そのトークンをセッションに換える (/verify には CAPTCHA が掛からない)
  var authResponse = http.post(
    supabaseUrl + '/auth/v1/verify',
    {
      body: JSON.stringify({ type: LINK_TYPE, token_hash: linkData.hashed_token }),
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseAnonKey
      }
    }
  );
  authData = parseJson(authResponse.body);
  if (authData && authData.access_token) break;
  if (!authData || authData.error_code !== VERIFY_RETRY_ERROR_CODE || attempt >= maxAttempts) {
    throw new Error(
      'Auth failed - no access_token: ' + describeAuthError(authData) +
        (authData && authData.error_code === VERIFY_RETRY_ERROR_CODE ? ' (発行から ' + attempt + ' 回試しました)' : '')
    );
  }
}

var accessToken = authData.access_token;

// Step 3: Reset onboarding
var resetResponse = http.post(
  apiBaseUrl + '/api/e2e/reset-onboarding',
  {
    body: '{}',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + accessToken
    }
  }
);

var resetBody = resetResponse.body;
var resetData = JSON.parse(resetBody);

if (!resetData.ok) {
  throw new Error('Reset failed: ' + resetBody);
}

output.ok = true;
