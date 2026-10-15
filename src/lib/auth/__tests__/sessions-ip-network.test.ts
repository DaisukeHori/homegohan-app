/**
 * src/lib/auth/sessions/ip-network.ts の単体テスト (#1190。設計 docs/design/cross/16-auth-history-sessions.md §13.5・§20.1)
 */
import { describe, expect, it } from 'vitest';
import { IP_NETWORK_PREFIX_V4, IP_NETWORK_PREFIX_V6 } from '../sessions/constants';
import { ipNetworkOf } from '../sessions/ip-network';

describe('ipNetworkOf', () => {
  it('IPv4 を /24 の範囲にする', () => {
    expect(IP_NETWORK_PREFIX_V4).toBe(24);
    expect(ipNetworkOf('203.0.113.10')).toBe('203.0.113.0/24');
    expect(ipNetworkOf('198.51.100.255')).toBe('198.51.100.0/24');
    expect(ipNetworkOf('10.0.0.0')).toBe('10.0.0.0/24');
  });

  it('IPv6 を /48 の範囲にする', () => {
    expect(IP_NETWORK_PREFIX_V6).toBe(48);
    expect(ipNetworkOf('2001:db8:1234:5678::1')).toBe('2001:db8:1234::/48');
    expect(ipNetworkOf('2001:0DB8:00ab:ffff:0:0:0:1')).toBe('2001:db8:ab::/48');
    // 省略 (::) が先頭の 48 ビットに掛かる形
    expect(ipNetworkOf('2001:db8::1')).toBe('2001:db8:0::/48');
    expect(ipNetworkOf('::1')).toBe('0:0:0::/48');
    // 末尾に IPv4 を埋めた形 (IPv4 射影アドレス)
    expect(ipNetworkOf('::ffff:203.0.113.10')).toBe('0:0:0::/48');
    expect(ipNetworkOf('2001:db8:1:2:3:4:203.0.113.10')).toBe('2001:db8:1::/48');
  });

  it('不正な文字列は null', () => {
    for (const value of ['', 'unknown', '203.0.113', '203.0.113.256', '2001:db8:::1', 'gggg::1', null, undefined]) {
      expect(ipNetworkOf(value)).toBeNull();
    }
  });
});
