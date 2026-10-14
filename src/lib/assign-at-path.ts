/**
 * ドットで区切ったパス ("sport.name" など) の先に値を入れる (target をその場で書き換える)。
 * 途中の要素が無い (または falsy) ときは、空のオブジェクトを作って進む。
 *
 * #1444 (CodeQL js/prototype-pollution-utility): パスの要素に __proto__ / constructor / prototype、または空の要素が
 * あるときは、Object.prototype などを書き換えないよう、何も書かずに InvalidObjectPathError を投げる。
 */

/** パスの要素として受け付けない名前 (プロトタイプを辿って共有のオブジェクトを書き換えられるもの) */
const FORBIDDEN_PATH_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export class InvalidObjectPathError extends Error {
  constructor(readonly path: string) {
    super(`Invalid object path: ${path}`);
    this.name = 'InvalidObjectPathError';
  }
}

type PathTarget = Record<string, unknown>;

export function assignAtPath(target: PathTarget, path: string, value: unknown): void {
  const keys = path.split('.');
  if (keys.some((key) => key === '' || FORBIDDEN_PATH_KEYS.has(key))) {
    throw new InvalidObjectPathError(path);
  }

  let node: PathTarget = target;
  for (const key of keys.slice(0, -1)) {
    if (!node[key]) node[key] = {};
    node = node[key] as PathTarget;
  }
  node[keys[keys.length - 1]] = value;
}
