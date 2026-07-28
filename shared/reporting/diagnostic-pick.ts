/** Pick the chronologically latest usage-report row for DevTools diagnostics. */
export function parseReportDateTimeMs(value: string | undefined): number | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;
  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

type TimestampedRecord = {
  update_date?: string;
  updateDate?: string;
  invoke_time?: string;
  invokeTime?: string;
  invoke_end_time?: string;
  invokeEndTime?: string;
};

function recordTimestampMs(record: TimestampedRecord): number {
  const candidates = [
    record.update_date,
    record.updateDate,
    record.invoke_end_time,
    record.invokeEndTime,
    record.invoke_time,
    record.invokeTime,
  ];
  for (const value of candidates) {
    const ms = parseReportDateTimeMs(value);
    if (ms != null) return ms;
  }
  return 0;
}

export function pickLatestRecordForDiagnostic<T extends TimestampedRecord>(records: T[]): T | null {
  if (records.length === 0) return null;
  if (records.length === 1) return records[0];
  let latest = records[0];
  let latestMs = recordTimestampMs(latest);
  for (let i = 1; i < records.length; i += 1) {
    const candidate = records[i];
    const candidateMs = recordTimestampMs(candidate);
    if (candidateMs >= latestMs) {
      latest = candidate;
      latestMs = candidateMs;
    }
  }
  return latest;
}
