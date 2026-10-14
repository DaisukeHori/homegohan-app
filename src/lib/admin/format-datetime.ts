/**
 * 運営コンソールの一覧に出す日時の書式 (日本時間、分まで)。例: 2026/10/08 14:05
 *
 * ブラウザのタイムゾーンに任せず日本時間に固定する。運営の画面で日時の見え方が環境で変わらないようにするため
 * (super-admin の運用ログ画面と同じ方針)。
 */
const JST_DATE_TIME = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * ISO 8601 の日時文字列を日本時間の「年/月/日 時:分」にする。
 * 値が無いときは '-'、日時として読めない文字列はそのまま返す (一覧の表示を崩さない)。
 */
export function formatJstDateTime(value: string | null | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : JST_DATE_TIME.format(date);
}
