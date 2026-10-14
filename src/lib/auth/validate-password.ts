/**
 * パスワード強度バリデーションの共有ヘルパー (Issue #1057 (UX1-05))
 *
 * #1187: モバイルの設定画面のパスワード変更でも同じ規則を使うため、本体を packages/shared (password-policy.ts) へ移した。
 * このファイルは、Web の既存の import 先を変えずに済むよう、そこを読み直すだけの入口。
 */

export { PASSWORD_HINT_TEXT, PASSWORD_MIN_LENGTH, validatePassword } from '@homegohan/shared';
