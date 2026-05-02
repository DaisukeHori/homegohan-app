// reset-onboarding.js
// Maestro runScript で呼び出される。
// Supabase password grant でアクセストークンを取得し、
// /api/e2e/reset-onboarding エンドポイントを呼び出してオンボーディング状態をリセットする。
//
// Maestro の GraalJsHttp では:
//   http.post(url, { body: string, headers: {} })
//   レスポンス: { body: string, headers: {} } (statusCode は存在しない可能性あり)

var supabaseUrl = 'https://flmeolcfutuwwbjmzyoz.supabase.co';
var supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZsbWVvbGNmdXR1d3diam16eW96Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM5NzAxODYsImV4cCI6MjA3OTU0NjE4Nn0.VVxUxKexNeN6dUiAMDkCNlnIoXa-F5rfBqHPBDcwdnU';
var apiBaseUrl = 'http://localhost:3000';

// Maestro runScript の env ブロックで渡された変数はグローバル変数として参照可能
var email = E2E_USER_EMAIL;
var password = E2E_USER_PASSWORD;

// Step 1: Supabase password grant
var authResponse = http.post(
  supabaseUrl + '/auth/v1/token?grant_type=password',
  {
    body: JSON.stringify({ email: email, password: password }),
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseAnonKey,
      'Authorization': 'Bearer ' + supabaseAnonKey
    }
  }
);

var authBody = authResponse.body;
var authData = JSON.parse(authBody);

if (!authData.access_token) {
  throw new Error('Auth failed - no access_token: ' + authBody);
}

var accessToken = authData.access_token;

// Step 2: Reset onboarding
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
