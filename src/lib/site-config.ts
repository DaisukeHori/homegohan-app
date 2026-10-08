/**
 * サイトの URL・メールの送信元・問い合わせ先を決める、唯一の場所 (#1194)
 *
 * 以前は、送信元 (noreply@…)・問い合わせ先 (support@…)・サイトの URL が、メールの文面 14 本・お問い合わせ API・
 * 招待画面・ページのメタ情報・robots.txt・モバイルの設定画面などに直接書かれていて、しかも
 * .app / .jp / .com の 3 つのドメインに食い違っていた (どれか 1 つ直しても、ほかは古いまま残る)。
 * いまは値をここで 1 回だけ決め、各所はこのファイルの関数を呼ぶ。
 *
 * 環境変数 (どれも未設定・空・不正な値なら、下の既定値を使う):
 *
 * | 関数               | 環境変数                    | 例                                      |
 * |--------------------|-----------------------------|-----------------------------------------|
 * | getSiteUrl()       | NEXT_PUBLIC_APP_URL         | https://homegohan.com                   |
 * | getEmailFrom()     | EMAIL_FROM                  | ほめゴハン <noreply@mail.homegohan.com> |
 * | getSupportEmail()  | NEXT_PUBLIC_SUPPORT_EMAIL   | support@homegohan.com                   |
 *
 * 既定値は、環境変数を設定していない今の本番がそのまま使っている値にしてある (値は変えていない)。
 * homegohan.com への切り替え (Resend の送信ドメインの検証・DNS の登録・support@ の受信箱の用意のあと) は、
 * 上の 3 つの環境変数を設定するだけでよく、コードの変更は要らない。手順は docs/operations/email-domain.md。
 *
 * 使うときの注意:
 * - NEXT_PUBLIC_ で始まる 2 つは、ビルド時にブラウザ用のコードへ埋め込まれる (クライアントコンポーネントからも呼べる)。
 *   値を変えたら再デプロイが要る。埋め込みは `process.env.NEXT_PUBLIC_XXX` と直接書いたときだけ効くので、
 *   `process.env[name]` のような動的な読み方に変えないこと。
 * - EMAIL_FROM は公開しない設定なので、サーバー側 (API ルート・サーバーコンポーネント) でだけ使う。
 * - 関数は呼ぶたびに環境変数を読む (テストで差し替えられるように)。
 * - 不正な値 (URL やメールアドレスの形になっていないもの) は黙って使わず、既定値に戻して警告を 1 回だけ出す。
 *   壊れた送信元のまま送って全部のメールが失敗するより、既定値で動き続けるほうが安全なため。
 *   同じ理由で、Vercel の本番環境では localhost を指すサイトの URL も使わない。
 * - このファイルの 3 つの既定値以外に、ドメインを直接書かない。tests/site-config-guard.test.ts が検査する。
 */

/**
 * サイトの URL の既定値。いま実際にアプリが動いている URL。
 * (メールのリンク・招待の URL・メタ情報はこれが基点。モバイルの DEFAULT_WEB_URL も同じ URL)
 */
export const DEFAULT_SITE_URL = 'https://homegohan-app.vercel.app';

/** メールの送信元の既定値。Resend で送信ドメインを検証するまでは、実際には届かない */
export const DEFAULT_EMAIL_FROM = 'ほめゴハン <noreply@homegohan.app>';

/** 問い合わせ先 (サポート窓口) のメールアドレスの既定値 */
export const DEFAULT_SUPPORT_EMAIL = 'support@homegohan.app';

/** 空白・< > @ を含まない、ごく簡易なメールアドレスの形 (厳密な検証は送信側の zod が行う) */
const EMAIL_ADDRESS = String.raw`[^\s<>@"]+@[^\s<>@"]+\.[^\s<>@"]+`;
const EMAIL_ADDRESS_PATTERN = new RegExp(`^${EMAIL_ADDRESS}$`);
/** `ほめゴハン <noreply@example.com>` の形、またはアドレスだけ。改行は許さない (ヘッダーの書き換えを防ぐ) */
const EMAIL_FROM_PATTERN = new RegExp(`^(?:[^<>\\r\\n]+<${EMAIL_ADDRESS}>|${EMAIL_ADDRESS})$`);

/** 警告を出し済みの環境変数名 (呼ぶたびに同じ警告で溢れないようにする) */
const warned = new Set<string>();

function warnInvalid(name: string, expected: string): void {
  if (warned.has(name)) return;
  warned.add(name);
  // 値そのものは出さない (名前と期待する形だけ)
  console.warn(`[site-config] ${name} の形が正しくないため無視して既定値を使います (${expected})`);
}

/** 環境変数の値の前後の空白を除く。空なら undefined (未設定と同じ扱い) */
function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * サイトの URL を、末尾の / を除いた形に整える。http(s) の URL でないとき (例: https:// の無いホスト名だけ) は null。
 * パスやクエリは付けない前提のため、クエリ・ハッシュ付きも不正とする。
 */
function normalizeSiteUrl(raw: string): string | null {
  if (/\s/.test(raw)) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.search !== '' || parsed.hash !== '') return null;
  return raw.replace(/\/+$/, '');
}

/** Vercel の本番環境か (Vercel が自動で入れる。ローカルや CI の `next start` では false) */
function isVercelProduction(): boolean {
  return process.env.VERCEL_ENV === 'production' || process.env.NEXT_PUBLIC_VERCEL_ENV === 'production';
}

/** localhost など、そのマシンの中だけで開ける URL か (メールを受け取る人の端末では開けない) */
function isLoopbackUrl(url: string): boolean {
  const { hostname } = new URL(url);
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '[::1]';
}

/**
 * サイトの URL (末尾の / なし)。環境変数 NEXT_PUBLIC_APP_URL、無ければ DEFAULT_SITE_URL。
 * メール内のリンク・招待の URL・ページのメタ情報 (OGP) の基点。
 *
 * Vercel の本番環境で localhost の URL が設定されていても使わない (開発用の .env.example の値をそのまま
 * 本番に登録してしまった場合に、メールや招待のリンクが受け取った人の端末で開けなくなるのを防ぐ)。
 */
export function getSiteUrl(): string {
  const raw = clean(process.env.NEXT_PUBLIC_APP_URL);
  if (raw === undefined) return DEFAULT_SITE_URL;
  const normalized = normalizeSiteUrl(raw);
  if (normalized === null) {
    warnInvalid('NEXT_PUBLIC_APP_URL', 'https://example.com のように https:// から書く');
    return DEFAULT_SITE_URL;
  }
  if (isVercelProduction() && isLoopbackUrl(normalized)) {
    warnInvalid('NEXT_PUBLIC_APP_URL', '本番では localhost を指す URL は使えない。公開されているサイトの URL にする');
    return DEFAULT_SITE_URL;
  }
  return normalized;
}

/**
 * メールの送信元 (From)。環境変数 EMAIL_FROM、無ければ DEFAULT_EMAIL_FROM。
 * `ほめゴハン <noreply@mail.example.com>` の形か、アドレスだけ。サーバー側でだけ使う。
 * ドメインは Resend で検証済みのものにすること (未検証だと Resend が送信を断る)。
 */
export function getEmailFrom(): string {
  const raw = clean(process.env.EMAIL_FROM);
  if (raw === undefined) return DEFAULT_EMAIL_FROM;
  if (!EMAIL_FROM_PATTERN.test(raw)) {
    warnInvalid('EMAIL_FROM', 'ほめゴハン <noreply@mail.example.com> の形');
    return DEFAULT_EMAIL_FROM;
  }
  return raw;
}

/**
 * 問い合わせ先 (サポート窓口) のメールアドレス。環境変数 NEXT_PUBLIC_SUPPORT_EMAIL、無ければ DEFAULT_SUPPORT_EMAIL。
 * メールの文面・お問い合わせ画面・プライバシーポリシー・招待画面の表示に使う。
 */
export function getSupportEmail(): string {
  const raw = clean(process.env.NEXT_PUBLIC_SUPPORT_EMAIL);
  if (raw === undefined) return DEFAULT_SUPPORT_EMAIL;
  if (!EMAIL_ADDRESS_PATTERN.test(raw)) {
    warnInvalid('NEXT_PUBLIC_SUPPORT_EMAIL', 'support@example.com のようなメールアドレス');
    return DEFAULT_SUPPORT_EMAIL;
  }
  return raw;
}
