-- migration: 20261015120000_user_push_tokens_install_secret.sql
-- 通知のトークンの claim に、端末の秘密の値による所有の証明を足す (#1636)
--
-- 背景:
--   POST /api/push-tokens/claim (#1599) は、呼び出した利用者が同じトークンを登録していれば、同じトークンのほかの利用者の行を
--   service_role で消していた。トークンの値を知っているだけの他人が、自分の行としてその値を登録 (RLS で自分の行は書ける) して
--   claim すると、持ち主の行を消せた (持ち主は次の起動まで通知が届かない)。
--   また、ログアウト (アプリの signOut.ts) を通らずにセッションが終わったとき (自動更新で refresh_token が失効と答えたなど) は、
--   セッションが無いので RLS では行を消せず、前の利用者宛ての通知がこの端末に届き得た。
--
-- 変更:
--   user_push_tokens に install_secret_hash (端末の秘密の値の SHA-256。16 進の小文字 64 文字。NULL 可) を足す。
--     - 端末の秘密の値は端末ごとに 1 つ。claim の応答でサーバーが 1 度だけ返し、端末の保管庫に置く。サーバーはハッシュだけを持つ
--       (取り決めは packages/shared/src/push-token-claim.ts)
--     - claim: 本人の行にハッシュを書き (service_role)、同じトークンのほかの利用者の行のうち、ハッシュが同じ行
--       (= 同じ端末の前の利用者) とハッシュの無い行 (移行のあいだの古い行) だけを消す
--     - release (POST /api/push-tokens/release。セッション無し): 利用者 ID・トークン・ハッシュの 3 つが合う行だけを消す
--   既存の行は NULL のまま (移行): 新しい版のアプリは起動のたびに claim して自分の行にハッシュを書く。
--   古い版のアプリの行は NULL のままで、今までどおり同じトークンを claim した利用者が外せる (古い版の利用者の行は守られない)。
--   形の CHECK を付ける (ハッシュ以外の値を入れさせない)。claim がトークンで行を引くので、トークンの索引を足す。
--
-- RLS・権限:
--   変えない。本人は RLS で自分の行の install_secret_hash を読み書きできるが、守っているのは秘密の値そのもの (端末の保管庫にだけ
--   ある) で、ハッシュではない。claim / release はサーバーが本文の秘密の値からハッシュを計算し直して比べるので、
--   自分の行に好きなハッシュを書いても、ほかの利用者の行は消せない。
--
-- 何度流しても同じ結果になる (IF NOT EXISTS・DROP CONSTRAINT IF EXISTS)。既存の行のデータは変えない。
-- 戻し方: supabase/rollbacks/20261015120000_user_push_tokens_install_secret.down.sql
--   (先にアプリの API (claim / release) を戻すこと。列が無いと claim の update と release の絞り込みが失敗する)
-- 確かめるテスト:
--   tests/integration/security/push-token-claim-ownership.test.ts (実 DB と next dev: 他人の値で claim できない・
--     同じ端末の前の利用者の行は引き取れる・release・凍結中・CHECK)
--   src/__tests__/api/push-tokens-claim.test.ts・src/__tests__/api/push-tokens-release.test.ts (route の分岐)

ALTER TABLE public.user_push_tokens
  ADD COLUMN IF NOT EXISTS install_secret_hash text;

ALTER TABLE public.user_push_tokens
  DROP CONSTRAINT IF EXISTS user_push_tokens_install_secret_hash_format;
ALTER TABLE public.user_push_tokens
  ADD CONSTRAINT user_push_tokens_install_secret_hash_format
  CHECK (install_secret_hash IS NULL OR install_secret_hash ~ '^[0-9a-f]{64}$');

COMMENT ON COLUMN public.user_push_tokens.install_secret_hash IS
  '端末の秘密の値 (端末ごとに 1 つ。claim でサーバーが発行し端末の保管庫に置く) の SHA-256 (16 進の小文字)。NULL は #1636 より前の版のアプリの行。claim / release の所有の証明に使う (#1636)';

CREATE INDEX IF NOT EXISTS idx_user_push_tokens_expo_push_token
  ON public.user_push_tokens USING btree (expo_push_token);
