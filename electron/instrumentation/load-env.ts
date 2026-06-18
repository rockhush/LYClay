import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

function moduleDirectory(): string {
  if (typeof __dirname !== 'undefined') {
    return __dirname;
  }
  return dirname(fileURLToPath(import.meta.url));
}

const envCandidates = [
  join(process.cwd(), '.env'),
  join(process.cwd(), '..', '.env'),
  // vite bundle: dist-electron/main/index.js -> project root
  join(moduleDirectory(), '..', '..', '.env'),
  join(moduleDirectory(), '..', '..', '..', '.env'),
];

let loadedEnvPath: string | undefined;
for (const envPath of envCandidates) {
  if (!existsSync(envPath)) {
    continue;
  }
  config({ path: envPath, override: false });
  loadedEnvPath = envPath;
  break;
}

if (!process.env.LANGFUSE_HOST && process.env.LANGFUSE_BASE_URL) {
  process.env.LANGFUSE_HOST = process.env.LANGFUSE_BASE_URL;
}

export function getLoadedEnvPath(): string | undefined {
  return loadedEnvPath;
}

export function logEnvBootstrapStatus(): void {
  const hasPublic = Boolean(process.env.LANGFUSE_PUBLIC_KEY);
  const hasSecret = Boolean(process.env.LANGFUSE_SECRET_KEY);
  console.info('[langfuse] env bootstrap', {
    loadedFrom: loadedEnvPath ?? '(no .env file found)',
    cwd: process.cwd(),
    langfuseKeys: hasPublic && hasSecret ? 'present' : 'missing',
    enabledFlag: process.env.LYCLAW_LANGFUSE_ENABLED ?? '(unset)',
    baseUrl: process.env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_HOST ?? '(default)',
  });
}
