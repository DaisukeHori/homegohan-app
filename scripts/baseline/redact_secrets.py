#!/usr/bin/env python3
"""本番スキーマ snapshot から秘密情報らしき文字列をマスクする。

使い方:
    python3 scripts/baseline/redact_secrets.py <dir-or-file> [...]

- 対象ファイルをその場で書き換え、検出箇所を `<REDACTED:種別>` に置き換える。
- ログには「ファイル名:行番号:種別」だけを出し、値そのものは一切出力しない
  (public リポジトリの Actions ログ / artifact に秘密が残らないようにするため)。
- 検出件数を最後に表示する。終了コードは常に 0 (検出しても処理は続ける)。
  --fail-on-detect を付けた場合のみ、検出があれば終了コード 2 を返す。

背景: supabase/baseline/ の素材は本番 DB の schema dump。関数本体に API キー等が
直書きされていた場合でも、リポジトリへ commit する前にここで必ずマスクする。
"""

from __future__ import annotations

import pathlib
import re
import sys

# (種別, 正規表現)。誤検知よりも見逃しを避ける方向で広めに取る。
PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("jwt", re.compile(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")),
    ("supabase_secret_key", re.compile(r"sb_secret_[A-Za-z0-9_-]{10,}")),
    ("stripe_key", re.compile(r"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}")),
    ("stripe_webhook_secret", re.compile(r"\bwhsec_[A-Za-z0-9]{10,}")),
    ("openai_key", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}")),
    ("xai_key", re.compile(r"\bxai-[A-Za-z0-9]{20,}")),
    ("google_api_key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}")),
    ("github_token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}")),
    ("resend_key", re.compile(r"\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{8,}")),
    ("slack_token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}")),
    ("aws_access_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("private_key_block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    # 接続文字列に埋め込まれたパスワード (user:password@host)
    ("db_url_password", re.compile(r"(?<=postgres://)[^:\s/'\"]+:[^@\s'\"]+(?=@)|(?<=postgresql://)[^:\s/'\"]+:[^@\s'\"]+(?=@)")),
    # Authorization ヘッダの直書き
    ("bearer_token", re.compile(r"(?i)(?<=bearer )[A-Za-z0-9._~+/-]{20,}=*")),
]


def redact_text(text: str) -> tuple[str, list[tuple[int, str]]]:
    """text をマスクし、(行番号, 種別) の一覧と共に返す。"""
    hits: list[tuple[int, str]] = []
    lines = text.split("\n")
    for idx, line in enumerate(lines):
        new_line = line
        for kind, pattern in PATTERNS:
            if pattern.search(new_line):
                count = len(pattern.findall(new_line))
                hits.extend([(idx + 1, kind)] * count)
                new_line = pattern.sub(f"<REDACTED:{kind}>", new_line)
        lines[idx] = new_line
    return "\n".join(lines), hits


def iter_files(paths: list[str]) -> list[pathlib.Path]:
    files: list[pathlib.Path] = []
    for raw in paths:
        p = pathlib.Path(raw)
        if p.is_dir():
            files.extend(sorted(x for x in p.rglob("*") if x.is_file()))
        elif p.is_file():
            files.append(p)
    return files


def main(argv: list[str]) -> int:
    fail_on_detect = "--fail-on-detect" in argv
    targets = [a for a in argv if a != "--fail-on-detect"]
    if not targets:
        print(__doc__)
        return 1

    total = 0
    for path in iter_files(targets):
        try:
            original = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        redacted, hits = redact_text(original)
        if hits:
            path.write_text(redacted, encoding="utf-8")
            for line_no, kind in hits:
                print(f"[redact] {path}:{line_no}: {kind}")
            total += len(hits)

    print(f"[redact] total redactions: {total}")
    if fail_on_detect and total > 0:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
