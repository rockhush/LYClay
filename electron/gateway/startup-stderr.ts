export type GatewayStderrClassification = {
  level: 'drop' | 'debug' | 'warn';
  normalized: string;
};

export type SessionWriteLockLog = {
  phase: 'releasing' | 'waiting' | 'acquired' | 'unknown';
  path?: string;
  heldMs?: number;
  maxMs?: number;
  waitedMs?: number;
  raw: string;
};

const MAX_STDERR_LINES = 120;

export function classifyGatewayStderrMessage(message: string): GatewayStderrClassification {
  const msg = message.trim();
  if (!msg) {
    return { level: 'drop', normalized: msg };
  }

  // Known noisy lines that are not actionable for Gateway lifecycle debugging.
  if (msg.includes('openclaw-control-ui') && msg.includes('token_mismatch')) {
    return { level: 'drop', normalized: msg };
  }
  if (msg.includes('closed before connect') && msg.includes('token mismatch')) {
    return { level: 'drop', normalized: msg };
  }
  if (msg.includes('[ws] closed before connect') && msg.includes('code=1005')) {
    return { level: 'debug', normalized: msg };
  }
  if (msg.includes('security warning: dangerous config flags enabled')) {
    return { level: 'debug', normalized: msg };
  }

  // Downgrade frequent non-fatal noise.
  if (msg.includes('ExperimentalWarning')) return { level: 'debug', normalized: msg };
  if (msg.includes('DeprecationWarning')) return { level: 'debug', normalized: msg };
  if (msg.includes('Debugger attached')) return { level: 'debug', normalized: msg };

  // Gateway config warnings (e.g. stale plugin entries) are informational, not actionable.
  if (msg.includes('Config warnings:')) return { level: 'debug', normalized: msg };

  // Electron restricts NODE_OPTIONS in packaged apps; this is expected and harmless.
  if (msg.includes('node: --require is not allowed in NODE_OPTIONS')) {
    return { level: 'debug', normalized: msg };
  }

  return { level: 'warn', normalized: msg };
}

export function parseSessionWriteLockLog(message: string): SessionWriteLockLog | null {
  const msg = message.trim();
  if (!msg.includes('[session-write-lock]')) {
    return null;
  }

  const releaseMatch = msg.match(/\[session-write-lock\]\s+releasing lock held for\s+(\d+)ms\s+\(max=(\d+)ms\):\s+(.+)$/i);
  if (releaseMatch) {
    return {
      phase: 'releasing',
      heldMs: Number(releaseMatch[1]),
      maxMs: Number(releaseMatch[2]),
      path: releaseMatch[3],
      raw: msg,
    };
  }

  const waitMatch = msg.match(/\[session-write-lock\].*wait(?:ing|ed).*?(\d+)ms.*?:\s+(.+)$/i);
  if (waitMatch) {
    return {
      phase: 'waiting',
      waitedMs: Number(waitMatch[1]),
      path: waitMatch[2],
      raw: msg,
    };
  }

  const acquiredMatch = msg.match(/\[session-write-lock\].*acquir(?:ed|ing).*?:\s+(.+)$/i);
  if (acquiredMatch) {
    return {
      phase: msg.includes('acquired') ? 'acquired' : 'waiting',
      path: acquiredMatch[1],
      raw: msg,
    };
  }

  return { phase: 'unknown', raw: msg };
}

export function recordGatewayStartupStderrLine(lines: string[], line: string): void {
  const normalized = line.trim();
  if (!normalized) return;
  lines.push(normalized);
  if (lines.length > MAX_STDERR_LINES) {
    lines.splice(0, lines.length - MAX_STDERR_LINES);
  }
}
