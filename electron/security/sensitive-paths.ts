import path from 'node:path';

export interface SensitivePathMatch {
  category: string;
  reason: string;
}

const SENSITIVE_SEGMENTS = new Map<string, string>([
  ['.ssh', 'SSH credentials'],
  ['.aws', 'AWS credentials'],
  ['.azure', 'Azure credentials'],
  ['.gcloud', 'Google Cloud credentials'],
  ['.kube', 'Kubernetes credentials'],
  ['.gnupg', 'GPG credentials'],
  ['.docker', 'Docker credentials'],
  ['keychains', 'macOS keychain data'],
  ['credentials', 'system credentials'],
]);

const SENSITIVE_BASENAMES = new Map<string, string>([
  ['.env', 'environment secrets'],
  ['.git-credentials', 'Git credentials'],
  ['.netrc', 'network credentials'],
  ['.npmrc', 'npm token configuration'],
  ['.pypirc', 'Python package credentials'],
  ['id_rsa', 'SSH private key'],
  ['id_dsa', 'SSH private key'],
  ['id_ecdsa', 'SSH private key'],
  ['id_ed25519', 'SSH private key'],
  ['login data', 'browser login database'],
  ['cookies', 'browser cookies'],
  ['local state', 'browser profile state'],
  ['sam', 'Windows account database'],
  ['system', 'Windows system registry hive'],
]);

const SENSITIVE_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
]);

function splitPathSegments(filePath: string): string[] {
  return filePath
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function isEnvVariant(baseName: string): boolean {
  return baseName === '.env' || baseName.startsWith('.env.');
}

function isServiceAccountFile(baseName: string): boolean {
  return (
    baseName === 'credentials.json'
    || baseName === 'secrets.json'
    || baseName === 'service-account.json'
    || /^firebase-adminsdk.*\.json$/i.test(baseName)
  );
}

function isBrowserCredentialPath(lowerSegments: string[], lowerBaseName: string): SensitivePathMatch | null {
  const hasBrowserRoot = lowerSegments.some((segment) => (
    segment.includes('chrome')
    || segment.includes('chromium')
    || segment.includes('edge')
    || segment.includes('firefox')
    || segment.includes('brave')
    || segment.includes('opera')
  ));
  if (!hasBrowserRoot) return null;
  if (lowerBaseName === 'login data') {
    return { category: 'browser-login-data', reason: 'Browser saved-login database' };
  }
  if (lowerBaseName === 'cookies') {
    return { category: 'browser-cookies', reason: 'Browser cookies database' };
  }
  if (lowerSegments.includes('session storage') || lowerSegments.includes('local storage')) {
    return { category: 'browser-session-data', reason: 'Browser session/local storage' };
  }
  return null;
}

function isWindowsSamPath(lowerSegments: string[]): SensitivePathMatch | null {
  const joined = lowerSegments.join('/');
  if (
    joined.includes('windows/system32/config/sam')
    || joined.includes('windows/system32/config/system')
    || joined.includes('windows/system32/config/security')
  ) {
    return { category: 'windows-registry-hive', reason: 'Windows credential registry hive' };
  }
  return null;
}

export function matchSensitivePath(filePath: string): SensitivePathMatch | null {
  const segments = splitPathSegments(filePath);
  if (segments.length === 0) return null;

  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const baseName = path.basename(segments[segments.length - 1] || '').toLowerCase();

  for (const segment of lowerSegments) {
    const reason = SENSITIVE_SEGMENTS.get(segment);
    if (reason) {
      return { category: `sensitive-segment:${segment}`, reason };
    }
  }

  const basenameReason = SENSITIVE_BASENAMES.get(baseName);
  if (basenameReason) {
    return { category: `sensitive-file:${baseName}`, reason: basenameReason };
  }

  if (isEnvVariant(baseName)) {
    return { category: 'env-file', reason: 'Environment secret file' };
  }

  if (isServiceAccountFile(baseName)) {
    return { category: 'service-account-file', reason: 'Service account or secret JSON file' };
  }

  const ext = path.extname(baseName);
  if (SENSITIVE_EXTENSIONS.has(ext)) {
    return { category: `sensitive-extension:${ext}`, reason: 'Private key or certificate bundle' };
  }

  const browserMatch = isBrowserCredentialPath(lowerSegments, baseName);
  if (browserMatch) return browserMatch;

  const windowsMatch = isWindowsSamPath(lowerSegments);
  if (windowsMatch) return windowsMatch;

  if (lowerSegments.includes('.git') && baseName === 'config') {
    return { category: 'git-config', reason: 'Git config may contain credentials or credential helpers' };
  }

  return null;
}

export function isSensitivePath(filePath: string): boolean {
  return matchSensitivePath(filePath) !== null;
}
