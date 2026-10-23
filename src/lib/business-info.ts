/**
 * 事業者 (サービスの運営会社) の情報を決める、唯一の場所 (#1155・#1911)
 *
 * 以前は、法務ページごとに事業者名を直接書いていて、プライバシーポリシーは「Homegohan Inc.」、
 * 利用規約・特定商取引法に基づく表記・運営会社ページは「株式会社ほめゴハン」と食い違っていた。
 * いまは値をここで 1 回だけ決め、各ページ (運営会社 /company・特定商取引法に基づく表記 /legal ほか) はこのファイルの定数を使う。
 * tests/business-info-legal-pages.test.ts が、旧名が残っていないこと・各ページが同じ名前と値を出していることを検査する。
 *
 * 所在地・設立・資本金・代表者・メールアドレス・営業時間の値は、株式会社MHD医健が公開している会社情報
 * (mhd-iken.com の /api/company-info) をそのまま使う (#1911)。電話番号は載せず、請求があれば遅滞なく開示する。
 *
 * サービス名 (「ほめゴハン」) は事業者名とは別のもの。著作権表示 (© … ほめゴハン) やヘッダーのサービス名は、ここでは扱わない。
 * アプリの問い合わせ先 (src/lib/site-config.ts の getSupportEmail) は、ここの事業者のメールアドレスとは別のもの。
 */

/** 事業者の正式名称 */
export const BUSINESS_NAME = '株式会社MHD医健';

/** 代表者 (特定商取引法に基づく表記・運営会社ページ) */
export const BUSINESS_REPRESENTATIVE = '堀 大輔';

/** 所在地 (郵便番号つき。出典: mhd-iken.com の /api/company-info) */
export const BUSINESS_ADDRESS = '〒105-0013 東京都港区浜松町２丁目2番15号 浜松町ダイヤビル2F';

/** 設立 (出典: mhd-iken.com の /api/company-info) */
export const BUSINESS_ESTABLISHED = '2025年1月31日';

/** 資本金 (出典: mhd-iken.com の /api/company-info) */
export const BUSINESS_CAPITAL = '2,000,000円';

/** 事業者の連絡先のメールアドレス (出典: mhd-iken.com の /api/company-info) */
export const BUSINESS_EMAIL = 'info@mhd-iken.com';

/** 営業時間 (出典: mhd-iken.com の /api/company-info) */
export const BUSINESS_HOURS = '平日 9:00-17:00 (年末年始を除く)';

/**
 * 電話番号の欄に出す文言。番号は載せず、請求があれば遅滞なく開示する。
 * 請求の窓口 (BUSINESS_EMAIL とお問い合わせのフォーム) は src/components/legal/PhoneOnRequest.tsx が添える。
 */
export const PHONE_DISCLOSED_ON_REQUEST = '請求があれば遅滞なく開示します';
