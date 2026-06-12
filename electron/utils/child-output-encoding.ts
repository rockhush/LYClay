/**
 * Decode stdout/stderr from child processes spawned on Windows.
 * OpenClaw doctor often emits CP936 bytes while Node defaults to UTF-8.
 */
export function decodeChildProcessOutput(chunk: Buffer | string): string {
  if (typeof chunk === 'string') {
    return chunk;
  }

  if (process.platform !== 'win32') {
    return chunk.toString('utf8');
  }

  const utf8 = chunk.toString('utf8');
  if (!utf8.includes('\uFFFD')) {
    return utf8;
  }

  try {
    return new TextDecoder('gb18030').decode(chunk);
  } catch {
    return utf8;
  }
}

export function buildUtf8ChildProcessEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  if (process.platform !== 'win32') {
    return env;
  }

  return {
    ...env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  };
}
