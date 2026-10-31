/**
 * IP アドレスから「同じ場所」とみなす範囲 (user_sessions_metadata.ip_network) を作る純関数。
 * 設計の正典 docs/design/cross/16-auth-history-sessions.md §13.5。
 * 幅は SQL のトリガー on_auth_session_created (関数 auth_session_created の network(set_masklen(ip, 24 / 48))) と同じ値 (constants.ts。契約テスト §20.3)。
 * 書いた値は inet の列に入り、読むときは Postgres の表記に揃う (比べるのはどちらも DB から読んだ値)。
 */
import { isIP } from 'node:net';
import { IP_NETWORK_PREFIX_V4, IP_NETWORK_PREFIX_V6 } from './constants';

/** node:net の isIP の戻り (4 = IPv4・6 = IPv6・0 = どちらでもない) */
const IP_FAMILY_V4 = 4;
const IP_FAMILY_V6 = 6;
/** IPv4 のオクテット数・1 オクテットのビット数 */
const IPV4_OCTETS = 4;
const BITS_PER_OCTET = 8;
/** 1 オクテットの全ビットが 1 の値 (0xff) */
const OCTET_ALL_ONES = (1 << BITS_PER_OCTET) - 1;
/** IPv6 のグループ (16 ビット) の数・1 グループのビット数 */
const IPV6_GROUPS = 8;
const BITS_PER_IPV6_GROUP = 16;
/** 1 グループの全ビットが 1 の値 (0xffff) */
const IPV6_GROUP_ALL_ONES = (1 << BITS_PER_IPV6_GROUP) - 1;
/** IPv6 のグループの 16 進の基数 */
const HEX_RADIX = 16;
/** IPv6 の末尾に IPv4 を埋めた書き方 (::ffff:1.2.3.4) の IPv4 が占めるグループ数 */
const EMBEDDED_IPV4_GROUPS = 2;

/** IPv4 の前 prefix ビットだけを残し、残りを 0 にする (prefix は 8 の倍数の想定。そうでなくてもビット単位で切る) */
function ipv4Network(ip: string, prefix: number): string {
  const octets = ip.split('.').map((part) => Number(part));
  const masked = octets.map((octet, index) => {
    const keepBits = Math.min(Math.max(prefix - index * BITS_PER_OCTET, 0), BITS_PER_OCTET);
    const mask = keepBits === 0 ? 0 : (OCTET_ALL_ONES << (BITS_PER_OCTET - keepBits)) & OCTET_ALL_ONES;
    return octet & mask;
  });
  return `${masked.slice(0, IPV4_OCTETS).join('.')}/${prefix}`;
}

/** IPv6 を 8 つの 16 ビットのグループの数に展開する (:: の省略・末尾の IPv4 を含む)。読めなければ null */
function expandIpv6(ip: string): number[] | null {
  let text = ip;
  const zoneIndex = text.indexOf('%');
  if (zoneIndex >= 0) text = text.slice(0, zoneIndex);
  const embeddedV4: number[] = [];
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (isIP(tail) !== IP_FAMILY_V4) return null;
    const octets = tail.split('.').map((part) => Number(part));
    for (let i = 0; i < EMBEDDED_IPV4_GROUPS; i += 1) {
      embeddedV4.push((octets[i * 2] << BITS_PER_OCTET) | octets[i * 2 + 1]);
    }
    // IPv4 の 2 グループぶんを 0 の仮のグループにして展開し、あとで差し替える
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const parseGroups = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((group) => Number.parseInt(group, HEX_RADIX));
  const halves = text.split('::');
  let groups: number[];
  if (halves.length === 1) {
    groups = parseGroups(halves[0]);
  } else {
    const head = parseGroups(halves[0]);
    const rest = parseGroups(halves[1]);
    const zeros = IPV6_GROUPS - head.length - rest.length;
    if (zeros < 0) return null;
    groups = [...head, ...new Array<number>(zeros).fill(0), ...rest];
  }
  if (embeddedV4.length > 0) groups = [...groups.slice(0, groups.length - EMBEDDED_IPV4_GROUPS), ...embeddedV4];
  if (groups.length !== IPV6_GROUPS || groups.some((g) => !Number.isInteger(g))) return null;
  return groups;
}

/** IPv6 の前 prefix ビットだけを残した範囲を `xxxx:xxxx:xxxx::/48` の形 (先頭の 0 を省いた 16 進) にする */
function ipv6Network(ip: string, prefix: number): string | null {
  const groups = expandIpv6(ip);
  if (!groups) return null;
  const keptGroups = Math.ceil(prefix / BITS_PER_IPV6_GROUP);
  const masked = groups.slice(0, keptGroups).map((group, index) => {
    const keepBits = Math.min(Math.max(prefix - index * BITS_PER_IPV6_GROUP, 0), BITS_PER_IPV6_GROUP);
    const mask = keepBits === 0 ? 0 : (IPV6_GROUP_ALL_ONES << (BITS_PER_IPV6_GROUP - keepBits)) & IPV6_GROUP_ALL_ONES;
    return (group & mask).toString(HEX_RADIX);
  });
  const suffix = keptGroups < IPV6_GROUPS ? '::' : '';
  return `${masked.join(':')}${suffix}/${prefix}`;
}

/**
 * IP の文字列を範囲にする。IPv4 は `a.b.c.0/24`、IPv6 は先頭 48 ビットを `xxxx:xxxx:xxxx::/48` の形。
 * null・空・IP として正しくない文字列は null
 */
export function ipNetworkOf(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const family = isIP(ip);
  if (family === IP_FAMILY_V4) return ipv4Network(ip, IP_NETWORK_PREFIX_V4);
  if (family === IP_FAMILY_V6) return ipv6Network(ip, IP_NETWORK_PREFIX_V6);
  return null;
}
