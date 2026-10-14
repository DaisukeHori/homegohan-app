/**
 * 端末の通知 (Expo Push) のトークンの扱い (#1599)。POST /api/push-tokens/claim が使う。
 *
 * user_push_tokens は UNIQUE(user_id, expo_push_token) なので、同じ端末のトークンが複数の利用者の行に併存できる。
 * 共有の端末で、前の利用者のログアウトの削除が失敗する (オフラインなど) と、前の利用者の行が残り、
 * 次の利用者がログインしたあとも前の利用者宛ての通知がこの端末に届き得る。
 * そこで、登録の直後にアプリが claim を呼び、同じトークンの「ほかの利用者の行」をサーバーで外す
 * (同じトークンは、最後に登録した 1 人にだけ紐づく)。RLS で本人の行しか触れないので、外すのは service_role で行う。
 */

/**
 * Expo の push token の形。`ExponentPushToken[...]` (従来) と `ExpoPushToken[...]` (新しい SDK) の 2 通り。
 * 形の違う値 (空・別の文字列) で、ほかの利用者の行を消しに行かない。
 */
const EXPO_PUSH_TOKEN_PATTERN = /^Expo(?:nent)?PushToken\[[^\]\s]+\]$/;

/**
 * 受け付ける長さの上限 (文字)。実物は 40 文字前後 (`ExponentPushToken[` + 22 文字前後 + `]`)。
 * 形が同じでも、極端に長い値で DB を引かせないための上限で、余裕を持たせている。
 */
export const MAX_EXPO_PUSH_TOKEN_LENGTH = 256;

/** 値が Expo の push token の形 (かつ上限の長さ以内) なら true */
export function isExpoPushToken(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_EXPO_PUSH_TOKEN_LENGTH && EXPO_PUSH_TOKEN_PATTERN.test(value);
}

/** claim の 400 / 404 の本文の code */
export const PUSH_TOKEN_CLAIM_ERROR_CODES = {
  /** 本文が JSON でない・expo_push_token が Expo の push token の形でない */
  INVALID_REQUEST: 'INVALID_PUSH_TOKEN_REQUEST',
  /** 呼び出した利用者の行に、このトークンが無い (先に登録 (upsert) してから呼ぶ) */
  NOT_REGISTERED: 'PUSH_TOKEN_NOT_REGISTERED',
} as const;
