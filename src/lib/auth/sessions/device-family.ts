/**
 * UA から端末の種類 (OS × クライアント) を決める純関数。外部ライブラリは使わない。
 * 設計の正典 docs/design/cross/16-auth-history-sessions.md §12.1。
 */
export type DeviceOs = 'ios' | 'android' | 'macos' | 'windows' | 'linux' | 'other';
export type DeviceClient = 'app' | 'safari' | 'chrome' | 'firefox' | 'edge' | 'server' | 'other';
export interface DeviceFamily { readonly os: DeviceOs; readonly client: DeviceClient; readonly key: string }
/**
 * サーバーの UA (node / undici / Next.js / Vercel) の種類。Web のログインの直後 (route が実際の UA に上書きする前 §13.5) と、
 * Node の道具 (supabase-js・素の fetch。既定の UA が node) で GoTrue を直接呼んだログイン (S-4)。端末を表さないので、
 * 判定では prior に同じ値があっても既知にしない (login-alert-policy.ts・§10.1)。一覧・メールの言葉は「不明な端末」
 */
export const SERVER_DEVICE_FAMILY_KEY = 'other/server';
/** 空・読めない UA (OS もクライアントも分からない) の種類。SERVER_DEVICE_FAMILY_KEY と同じく、判定では既知にしない。言葉は「不明な端末」 */
export const UNKNOWN_DEVICE_FAMILY_KEY = 'other/other';
/** UA の読む長さの上限 (細工された長い UA で正規表現に時間を使わせない) */
const UA_MAX_LENGTH = 512;
const SERVER_UA = /^(node|undici|next\.js|vercel edge functions)/i;
const IOS_APP_UA = /CFNetwork\//;    // React Native (iOS) の fetch
const ANDROID_APP_UA = /^okhttp\//i; // React Native (Android) の fetch

function osOf(ua: string): DeviceOs {
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Macintosh|Mac OS X/.test(ua)) return 'macos';
  if (/Windows NT/.test(ua)) return 'windows';
  if (/Linux|X11/.test(ua)) return 'linux';
  return 'other';
}
function clientOf(ua: string): DeviceClient {
  if (/\bEdg(e|A|iOS)?\//.test(ua)) return 'edge';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'firefox';
  if (/Chrome\/|CriOS\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}
export function deviceFamilyOf(userAgent: string | null | undefined): DeviceFamily {
  const ua = (userAgent ?? '').slice(0, UA_MAX_LENGTH);
  let os: DeviceOs = 'other';
  let client: DeviceClient = 'other';
  if (!ua) { /* 不明 */ }
  else if (SERVER_UA.test(ua)) client = 'server';
  else if (IOS_APP_UA.test(ua)) { os = 'ios'; client = 'app'; }
  else if (ANDROID_APP_UA.test(ua)) { os = 'android'; client = 'app'; }
  else { os = osOf(ua); client = clientOf(ua); }
  return { os, client, key: `${os}/${client}` };
}
const OS_LABEL: Record<DeviceOs, string> = { ios: 'iPhone・iPad', android: 'Android', macos: 'Mac', windows: 'Windows', linux: 'Linux', other: '不明な端末' };
const CLIENT_LABEL: Record<DeviceClient, string> = { app: 'ほめゴハンのアプリ', safari: 'Safari', chrome: 'Chrome', firefox: 'Firefox', edge: 'Edge', server: '不明', other: 'ブラウザ' };
/** 一覧・メールに出す文言。例: 「iPhone・iPad の Safari」「ほめゴハンのアプリ (Android)」「不明な端末」 */
export function deviceLabelOf(family: DeviceFamily): string {
  if (family.client === 'app') return `${CLIENT_LABEL.app} (${OS_LABEL[family.os]})`;
  if (family.client === 'server' || (family.os === 'other' && family.client === 'other')) return OS_LABEL.other;
  return `${OS_LABEL[family.os]} の ${CLIENT_LABEL[family.client]}`;
}
