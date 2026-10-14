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
//   そこで、パスワードのログインは使わず、tests/e2e/helpers/test-session.ts と同じ手順でセッションを作る:
//     1. service_role で POST /auth/v1/admin/generate_link ({ type: "recovery", email }) → hashed_token (メールは送られない)
//     2. anon key で POST /auth/v1/verify ({ type: "recovery", token_hash }) → access_token
//   どちらも CAPTCHA の対象外 (根拠は tests/e2e/helpers/test-session.ts の先頭のコメント)。
//   このファイルは Maestro の JavaScript (GraalJS) で動き、npm のモジュールを読み込めないので、同じ手順をここにも書いている。
//
// 要る値 (runScript の env で渡す。_shared/login-for-onboarding.yaml が、シェルの MAESTRO_ 付きの環境変数から渡す):
//   E2E_USER_EMAIL             テストユーザーのメールアドレス
//   SUPABASE_URL               アプリがつながっている Supabase の URL
//   SUPABASE_ANON_KEY          その Supabase の anon key
//   SUPABASE_SERVICE_ROLE_KEY  その Supabase の service_role (管理用の鍵)
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
var authData = parseJson(authResponse.body);
if (!authData || !authData.access_token) {
  throw new Error('Auth failed - no access_token: ' + describeAuthError(authData));
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
