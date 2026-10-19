import Link from 'next/link';
import { BUSINESS_EMAIL, PHONE_DISCLOSED_ON_REQUEST } from '@/lib/business-info';

/**
 * 電話番号の欄の中身 (#1911)。番号は載せず「請求があれば遅滞なく開示します」と書き、請求の窓口
 * (事業者のメールアドレスと、お問い合わせのフォーム) を添える。
 * 運営会社 (/company) と特定商取引法に基づく表記 (/legal) の両方で使い、文面を食い違わせない。
 */
export function PhoneOnRequest({ linkColor }: { linkColor: string }) {
  return (
    <>
      {PHONE_DISCLOSED_ON_REQUEST}。ご請求は、{BUSINESS_EMAIL} または
      <Link href="/contact" className="font-bold underline" style={{ color: linkColor }}>
        お問い合わせフォーム
      </Link>
      からお願いします。
    </>
  );
}
