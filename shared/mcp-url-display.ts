export function redactMcpUrlForDisplay(value: string): string {
  try {
    const parsed = new URL(value);
    if (!parsed.search && !parsed.hash) return value;

    if (parsed.search) {
      const redactedQuery = parsed.search
        .slice(1)
        .split('&')
        .filter(Boolean)
        .map((part) => `${part.split('=', 1)[0]}=***`)
        .join('&');
      parsed.search = redactedQuery ? `?${redactedQuery}` : '';
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return value;
  }
}
