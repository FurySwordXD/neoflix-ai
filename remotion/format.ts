const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "Dec 31, 2019" from an ISO timestamp. UTC, so midnight dates don't slip a day. */
export function formatLongDate(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

export function formatRange(start: string, end?: string): string {
  if (!end) return `${formatLongDate(start)} — ongoing`;
  return `${formatLongDate(start)} — ${formatLongDate(end)}`;
}
