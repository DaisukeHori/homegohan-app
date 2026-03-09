export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function buildProgressSnapshot({
  label,
  processed,
  total,
  startedAt,
  cursor,
  extra,
}) {
  const elapsedMs = Date.now() - startedAt;
  const elapsedMinutes = elapsedMs / 60000;
  const ratePerMinute = elapsedMinutes > 0 ? processed / elapsedMinutes : 0;
  const hasTotal = Number.isFinite(total) && total > 0;
  const percent = hasTotal ? ((processed / total) * 100).toFixed(1) : "?";

  let eta = "-";
  if (hasTotal && ratePerMinute > 0) {
    const remaining = Math.max(total - processed, 0);
    eta = formatDuration((remaining / ratePerMinute) * 60000);
  }

  const parts = [
    `${label}: ${processed}/${hasTotal ? total : "?"} (${hasTotal ? `${percent}%` : "?"})`,
    `elapsed=${formatDuration(elapsedMs)}`,
    `rate=${ratePerMinute.toFixed(1)}/min`,
    `eta=${eta}`,
  ];

  if (cursor != null) parts.push(`cursor=${cursor}`);
  if (extra) parts.push(extra);

  return parts.join(" | ");
}
