'use client';

/**
 * バックアップコードの 1 回だけの表示 (#1176。docs/design/cross/12-operator-mfa.md §15.3)
 *
 * コードは props で受け取り、state にだけ持つ (localStorage などに書かない)。
 * 「コードを安全な場所に保存した」のチェックを入れるまで [続ける] を押せない。
 */
import { useState } from 'react';

/** [テキストで保存] のファイル名 */
export const BACKUP_CODES_DOWNLOAD_FILENAME = 'homegohan-mfa-backup-codes.txt';

export function BackupCodesPanel({ codes, onDone }: { codes: ReadonlyArray<string>; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const handleDownload = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = BACKUP_CODES_DOWNLOAD_FILENAME;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-700">
        認証アプリが使えなくなったときのバックアップコードです。このコードはこの画面で 1 回だけ表示されます。1 つのコードは 1 回だけ使えます。
      </p>
      <ul data-testid="backup-codes-list" className="grid grid-cols-2 gap-2 rounded-xl bg-gray-50 p-4 font-mono text-sm">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleCopy}
          className="flex-1 py-2 rounded-xl border border-gray-200 text-sm font-bold text-gray-700 hover:bg-gray-50"
        >
          {copied ? 'コピーしました' : 'コピー'}
        </button>
        <button
          type="button"
          onClick={handleDownload}
          className="flex-1 py-2 rounded-xl border border-gray-200 text-sm font-bold text-gray-700 hover:bg-gray-50"
        >
          テキストで保存
        </button>
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input
          type="checkbox"
          data-testid="backup-codes-saved"
          checked={saved}
          onChange={(event) => setSaved(event.target.checked)}
        />
        コードを安全な場所に保存した
      </label>
      <button
        type="button"
        data-testid="backup-codes-done"
        disabled={!saved}
        onClick={onDone}
        className="w-full py-3 rounded-xl font-bold text-white bg-[#E07A5F] hover:bg-[#D16A4F] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        続ける
      </button>
    </div>
  );
}
