#!/usr/bin/env python3
"""本番の関数本文と、migration が最後に定義した本文を比べる (#1243 のドリフト調査の補助)。

drift_compare.py はカタログ (SECURITY DEFINER / search_path / EXECUTE 権限など) を比べるが、
関数の本文 (処理内容) は比べない。このスクリプトはその穴を埋める。ローカル専用で、本番には接続しない。

入力:
  - 本番の本文: supabase/baseline/prod_schema.sql (prod-schema-snapshot.yml が読み取り専用で取得した pg_dump)
  - migration の本文: supabase/migrations/*.sql を version 順に読み、関数ごとに最後の定義を採る
    (最後の CREATE より後に DROP FUNCTION があれば「削除済み」とみなす)

比較は public スキーマの関数だけ。関数はオーバーロードを区別するため「名前 + 引数の型」で照合する。

分類:
  identical        本文が一致 (前後の空行と行末の空白は無視)
  formatting_only  コメント・空白・大文字小文字だけが違う (動作は同じ)
  logic_differs    処理が違う (本番が migration の定義と違う = ドリフト)
  not_in_prod      migration が定義しているのに本番に無い
  dropped_but_in_prod  migration で削除したのに本番に残っている
  prod_only        本番にあるが、どの migration も定義していない (名前 + 引数の型で照合)

使い方:
  python3 scripts/baseline/compare_function_bodies.py [リポジトリのルート]   # 既定はカレントディレクトリ
  終了コード: logic_differs / not_in_prod / dropped_but_in_prod / prod_only が 1 件でもあれば 1
"""

from __future__ import annotations

import json
import os
import re
import sys

PROD_FUNC_RE = re.compile(
    r'CREATE OR REPLACE FUNCTION "public"\."(?P<name>[^"]+)"\((?P<args>.*?)\)\s+RETURNS'
    r'.*?\bAS (?P<tag>\$[A-Za-z0-9_]*\$)(?P<body>.*?)(?P=tag)',
    re.S,
)
MIG_FUNC_RE = re.compile(
    r'CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\s*\.\s*)?"?(?P<name>[A-Za-z0-9_]+)"?\s*'
    r'\((?P<args>.*?)\)\s*RETURNS(?P<ret>.*?)\bAS\s+(?P<tag>\$[A-Za-z0-9_]*\$)(?P<body>.*?)(?P=tag)',
    re.S | re.I,
)
MIG_DROP_RE = re.compile(
    r'DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:"?public"?\s*\.\s*)?"?(?P<name>[A-Za-z0-9_]+)"?\s*'
    r'(?:\((?P<args>[^;]*?)\))?\s*(?:CASCADE|RESTRICT)?\s*;',
    re.S | re.I,
)
# 関数定義の外 (別スキーマ) を誤って拾わないよう、スキーマ付きの非 public 定義は除外する
NON_PUBLIC_RE = re.compile(r'FUNCTION\s+"?(?!public\b)[A-Za-z0-9_]+"?\s*\.', re.I)

TYPE_ALIASES = {
    'int': 'integer',
    'int4': 'integer',
    'int8': 'bigint',
    'int2': 'smallint',
    'bool': 'boolean',
    'varchar': 'character varying',
    'char': 'character',
    'float8': 'double precision',
    'float4': 'real',
    'timestamptz': 'timestamp with time zone',
    'timestamp': 'timestamp without time zone',
    'timetz': 'time with time zone',
    'decimal': 'numeric',
}
ARG_MODES = {'in', 'out', 'inout', 'variadic'}


def split_top_level(s: str) -> list[str]:
    """カンマで分割する (括弧・引用符の中のカンマは無視する)"""
    parts, depth, buf, quote = [], 0, [], None
    for ch in s:
        if quote:
            buf.append(ch)
            if ch == quote:
                quote = None
            continue
        if ch in ('"', "'"):
            quote = ch
            buf.append(ch)
        elif ch == '(':
            depth += 1
            buf.append(ch)
        elif ch == ')':
            depth -= 1
            buf.append(ch)
        elif ch == ',' and depth == 0:
            parts.append(''.join(buf))
            buf = []
        else:
            buf.append(ch)
    if ''.join(buf).strip():
        parts.append(''.join(buf))
    return parts


def normalize_type(t: str) -> str:
    t = t.replace('"', '').strip().lower()
    # pg_dump はスキーマ付き (public.x / extensions.vector) で、migration は付けないことが多い
    t = re.sub(r'^(public|extensions)\.', '', t)
    t = re.sub(r'\s+', ' ', t)
    t = re.sub(r'\(.*?\)', '', t).strip()  # varchar(255) → varchar
    is_array = t.endswith('[]')
    base = t[:-2].strip() if is_array else t
    base = TYPE_ALIASES.get(base, base)
    return base + ('[]' if is_array else '')


def signature(args: str) -> tuple[str, ...]:
    """引数リストから「入力引数の型」の並びを取り出す (OUT 引数と DEFAULT は除く)"""
    types = []
    for raw in split_top_level(args):
        a = re.split(r'\s+DEFAULT\s+|\s*=\s*', raw.strip(), maxsplit=1, flags=re.I)[0].strip()
        if not a:
            continue
        tokens = a.split()
        mode = 'in'
        if tokens and tokens[0].lower() in ARG_MODES:
            mode = tokens[0].lower()
            tokens = tokens[1:]
        if mode == 'out':
            continue
        if len(tokens) == 1:
            types.append(normalize_type(tokens[0]))
            continue
        # 先頭が引数名かどうか: 型名として解釈できる 2 語以上の型 (double precision 等) もあるため、
        # 「引数名 + 型」とみなせるとき (先頭が型の別名でない) は先頭を落とす
        head = tokens[0].replace('"', '').lower()
        multiword_types = ('double', 'character', 'timestamp', 'time', 'bit')
        if head in multiword_types:
            types.append(normalize_type(' '.join(tokens)))
        else:
            types.append(normalize_type(' '.join(tokens[1:])))
    return tuple(types)


def norm_lines(body: str) -> str:
    lines = [line.rstrip() for line in body.replace('\r\n', '\n').split('\n')]
    while lines and lines[0] == '':
        lines.pop(0)
    while lines and lines[-1] == '':
        lines.pop()
    return '\n'.join(lines)


def flat(body: str) -> str:
    """コメント・空白・大文字小文字を除いた比較用の文字列"""
    body = re.sub(r'/\*.*?\*/', '', body, flags=re.S)
    body = re.sub(r'--[^\n]*', '', body)
    return re.sub(r'\s+', '', body).lower()


def main() -> int:
    root = sys.argv[1] if len(sys.argv) > 1 else '.'
    prod_sql = open(os.path.join(root, 'supabase/baseline/prod_schema.sql'), encoding='utf-8').read()

    prod: dict[tuple[str, tuple[str, ...]], str] = {}
    for m in PROD_FUNC_RE.finditer(prod_sql):
        prod[(m.group('name'), signature(m.group('args')))] = m.group('body')

    mig_dir = os.path.join(root, 'supabase/migrations')
    # (name, sig) → (file, body) / None (削除済み)
    last: dict[tuple[str, tuple[str, ...]], tuple[str, str] | None] = {}
    for fname in sorted(f for f in os.listdir(mig_dir) if f.endswith('.sql')):
        sql = open(os.path.join(mig_dir, fname), encoding='utf-8').read()
        events = []
        for m in MIG_FUNC_RE.finditer(sql):
            head = sql[max(0, m.start() - 0):m.start() + 120]
            if NON_PUBLIC_RE.match(head[head.upper().find('FUNCTION'):] if 'FUNCTION' in head.upper() else ''):
                continue
            events.append((m.start(), 'create', m.group('name'), signature(m.group('args')), m.group('body')))
        for m in MIG_DROP_RE.finditer(sql):
            sig = signature(m.group('args')) if m.group('args') is not None else None
            events.append((m.start(), 'drop', m.group('name'), sig, None))
        for _, kind, name, sig, body in sorted(events, key=lambda e: e[0]):
            if kind == 'create':
                last[(name, sig)] = (fname, body)
            elif sig is None:
                # 引数リスト無しの DROP FUNCTION name; はその名前の関数 1 つ (オーバーロードが無い前提) を削除
                for key in [k for k in last if k[0] == name]:
                    last[key] = None
            else:
                last[(name, sig)] = None

    result: dict[str, list] = {
        'identical': [],
        'formatting_only': [],
        'logic_differs': [],
        'not_in_prod': [],
        'dropped_but_in_prod': [],
        'prod_only': [],
    }
    for key, value in sorted(last.items()):
        name, sig = key
        label = f"{name}({', '.join(sig)})"
        if value is None:
            if key in prod:
                result['dropped_but_in_prod'].append(label)
            continue
        fname, body = value
        if key not in prod:
            result['not_in_prod'].append([label, fname])
        elif norm_lines(prod[key]) == norm_lines(body):
            result['identical'].append(label)
        elif flat(prod[key]) == flat(body):
            result['formatting_only'].append([label, fname])
        else:
            result['logic_differs'].append([label, fname])
    for key in sorted(prod):
        if key not in last:
            result['prod_only'].append(f"{key[0]}({', '.join(key[1])})")

    summary = {k: len(v) for k, v in result.items()}
    print(json.dumps({'summary': summary, **{k: v for k, v in result.items() if k != 'identical'}},
                     ensure_ascii=False, indent=1))
    problems = sum(summary[k] for k in ('logic_differs', 'not_in_prod', 'dropped_but_in_prod', 'prod_only'))
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
