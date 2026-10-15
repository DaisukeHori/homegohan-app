import { PUSH_TOKEN_CLAIM_API_PATH } from '@homegohan/shared';

/**
 * 端末の通知 (Expo Push) のトークンの扱い (#1599 / #1636)。POST /api/push-tokens/claim・release と middleware が使う。
 * middleware (Edge) からも読むので、Node の部品 (node:crypto など) をここに置かない (ハッシュは push-token-install-secret.ts)。
 *
 * user_push_tokens は UNIQUE(user_id, expo_push_token) なので、同じ端末のトークンが複数の利用者の行に併存できる。
 * 共有の端末で、前の利用者のログアウトの削除が失敗する (オフラインなど) と、前の利用者の行が残り、
 * 次の利用者がログインしたあとも前の利用者宛ての通知がこの端末に届き得る。
 * そこで、登録の直後にアプリが claim を呼び、同じトークンの「ほかの利用者の行」をサーバーで外す
 * (同じトークンは、最後に登録した 1 人にだけ紐づく)。RLS で本人の行しか触れないので、外すのは service_role で行う。
 */

export { PUSH_TOKEN_CLAIM_API_PATH };

/**
 * メンテナンス中・凍結中でも middleware が止めない API か (#1636)。claim の 1 本だけで、完全一致で判定する
 * (前方一致にすると、/api/push-tokens/claim-xxx のような、後から足した別の API まで通ってしまうため)。
 *
 * claim は利用者の操作ではなく、端末の後片付け (同じ端末の前の利用者の行を外す) なので、止めると前の利用者宛ての通知が
 * 次の起動までこの端末に届き続ける。止めないのは middleware の判定だけで、route は今までどおり本人の認証を求める。
 * release (セッション無しの後片付け) は含めない (メンテナンス中は 503 で止まり、アプリが次の起動でやり直す)。
 * 一覧が広がらないことは lib/supabase/__tests__/middleware-push-token-claim-exemption.test.ts が src/app/api の全 route で確かめる
 */
export function isPushTokenClaimApiPath(pathname: string): boolean {
  return pathname === PUSH_TOKEN_CLAIM_API_PATH;
}

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

/** claim・release の 400 / 404 の本文の code */
export const PUSH_TOKEN_CLAIM_ERROR_CODES = {
  /**
   * 本文が JSON でない・expo_push_token が Expo の push token の形でない・install_secret が端末の秘密の値の形でない・
   * install_secret と issue_install_secret を同時に送った・(release) user_id が UUID でない
   */
  INVALID_REQUEST: 'INVALID_PUSH_TOKEN_REQUEST',
  /** 呼び出した利用者の行に、このトークンが無い (先に登録 (upsert) してから呼ぶ) */
  NOT_REGISTERED: 'PUSH_TOKEN_NOT_REGISTERED',
} as const;
