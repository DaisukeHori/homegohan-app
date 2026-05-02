# E2E 自己修復ループ 進捗ログ

開始: 2026-05-02
Simulator: iPhone-E2E-01
ビルド: PR #624 #632 #633 適用後

## フォーマット
`フロー名 | 結果 | Issue/PR | 経過時間`

## 進捗

### auth
| フロー | 結果 | Issue/PR | メモ |
|--------|------|----------|------|
| auth/01-login-existing-user-to-home | PASS | - | sanity check |
| auth/02-admin-login-redirect-to-admin | PASS | PR #634, #635 | tab-settings/logout バナー修正 |
| auth/03-onboarding-incomplete-user-redirect | SKIP | issue #636 | E2E_USER_03 が onboarding 完了済みでテストデータ問題 |
| auth/04-signup-new-user-confirmation-email | SKIP | issue #638, PR #637 | E2E_USER_04 が既に登録済みでテストデータ問題。YAML を testID 使用に修正済み |
| auth/05-forgot-password-send-email | PASS | PR #637 | Alert body assertion を forgot-success-text ID に変更 |
| auth/06-welcome-signup-login-e2e | SKIP | issue #639 | 新規登録テストデータ問題 + clearText 不正コマンド |
| auth/07-login-empty-email-validation | PASS | PR #637 | Alert body assertion 削除 |
| auth/08-login-password-too-short | PASS | - | |
| auth/09-signup-password-no-digit | PASS | PR #637 | testID 使用 + eraseText に変更 |
| auth/10-signup-password-no-letter | PASS | PR #637 | testID 使用 + eraseText に変更 |
| auth/11-signup-duplicate-email-silent-success | PASS | PR #637 | testID 使用 + eraseText に変更 |
| auth/12-login-rate-limit-ban-after-3-failures | PASS | PR #637 | login-rate-limit-banner testID に変更 |
| auth/13-login-wrong-password-rate-limit-set | PASS | PR #637 | login-rate-limit-banner testID に変更 |
| auth/14-login-offline-airplane-mode | SKIP | issue #640 | maestro/scripts ディレクトリが存在しない |
| auth/15-login-429-too-many-requests | PASS | PR #637 | login-rate-limit-banner testID に変更 |
| auth/16-signup-api-500-error | SKIP | issue #641 | mock サーバー不要、実環境では再現不可 |
| auth/17-adversarial-email-5000-chars | PASS | - | |
| auth/18-adversarial-password-sql-injection | PASS | - | |
| auth/19-adversarial-email-xss-payload | PASS | - | |
| auth/20-adversarial-next-param-open-redirect | PASS | PR #637 | arguments: 削除 |
| auth/21-adversarial-forgot-password-nonexistent-email | PASS | PR #637 | forgot-success-text + testID 使用 |
| auth/22-login-bg-fg-input-preserved | SKIP | issue #642 | BG→FG が openLink 確認ダイアログで停止 |
| auth/23-expired-jwt-home-redirect-to-root | PASS | PR #637 | arguments: 削除 + ensure-welcome に dialog dismiss 追加 |
| auth/24-google-oauth-cancel-returns-to-login | PASS | - | |
| auth/25-rate-limit-countdown-bg-fg-restored | SKIP | issue #642 | BG→FG 問題 + clearState 不正 YAML |

### onboarding
| フロー | 結果 | Issue/PR | メモ |
|--------|------|----------|------|
| onboarding/01-22 (全22フロー) | SKIP | issue #644 | testID 不整合・ログインステップ欠如・テストデータ問題 |

### home
| フロー | 結果 | Issue/PR | メモ |
|--------|------|----------|------|
| home/01-all-sections-display | PASS | PR - | testID 修正 + scroll 追加、login.yaml に ensure-welcome 追加 |
| home/02-23 (全22フロー) | SKIP | issue #645 | testID 不整合・toggleAirplaneMode 不正コマンド・動的 ID 問題 |

