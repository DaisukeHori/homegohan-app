/**
 * spacing.test.ts
 * src/theme/spacing.ts のスペーシング・ラジウストークンを検証する
 */

import { spacing, radius } from '../../src/theme/spacing';

describe('spacing トークン', () => {
  it('xs は 4', () => {
    expect(spacing.xs).toBe(4);
  });

  it('sm は 8', () => {
    expect(spacing.sm).toBe(8);
  });

  it('md は 12', () => {
    expect(spacing.md).toBe(12);
  });

  it('lg は 16', () => {
    expect(spacing.lg).toBe(16);
  });

  it('xl は 20', () => {
    expect(spacing.xl).toBe(20);
  });

  it('2xl は 24', () => {
    expect(spacing['2xl']).toBe(24);
  });
});

describe('radius トークン', () => {
  it('sm は 8', () => {
    expect(radius.sm).toBe(8);
  });

  it('full は 999', () => {
    expect(radius.full).toBe(999);
  });
});
