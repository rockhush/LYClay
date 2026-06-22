import { app } from 'electron';
import { execFileSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join, win32 } from 'path';
import { getUvMirrorEnv } from './uv-env';
import { logger } from './logger';
import { prepareWinSpawn } from './paths';
import { prependPathEntry } from './env-path';
import { assertCommandAllowedWithConfirmation } from '../security/confirmation-service';

/**
 * Get the path to the bundled uv binary
 */
function getBundledUvPath(): string {
  return getBundledUvPathCandidates()[0];
}

function getBundledUvPathCandidates(): string[] {
  const platform = process.platform;
  const arch = process.arch;
  const target = `${platform}-${arch}`;
  const binName = platform === 'win32' ? 'uv.exe' : 'uv';

  if (app.isPackaged) {
    return [
      join(process.resourcesPath, 'bin', binName),
      join(process.resourcesPath, 'resources', 'bin', target, binName),
      join(process.resourcesPath, 'resources', 'bin', 'uv', target, binName),
    ];
  }

  return [
    join(process.cwd(), 'resources', 'bin', target, binName),
    join(process.cwd(), 'resources', 'bin', 'uv', target, binName),
  ];
}

function getBundledPythonDir(): string | null {
  if (!app.isPackaged) return null;
  return join(process.resourcesPath, 'resources', 'python');
}

/**
 * Resolve the best uv binary to use.
 *
 * In packaged mode we always prefer the bundled binary so we never accidentally
 * pick up a system-wide uv that may be a different (possibly broken) version.
 * In dev we fall through to the system PATH for convenience.
 */
function resolveUvBin(): { bin: string; source: 'bundled' | 'path' | 'bundled-fallback' } {
  const bundledCandidates = getBundledUvPathCandidates();
  const bundled = bundledCandidates[0];
  const existingBundled = bundledCandidates.find((candidate) => existsSync(candidate));

  if (app.isPackaged) {
    if (existingBundled) {
      return { bin: existingBundled, source: 'bundled' };
    }
    logger.warn(`Bundled uv binary not found at ${bundledCandidates.join(', ')}, falling back to system PATH`);
  }

  // Dev mode or missing bundled binary — check system PATH
  const found = findUvInPathSync();
  if (found) return { bin: 'uv', source: 'path' };

  if (existingBundled) {
    return { bin: existingBundled, source: 'bundled-fallback' };
  }

  return { bin: 'uv', source: 'path' };
}

function findUvInPathSync(): boolean {
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    execFileSync(command, ['uv'], { stdio: 'ignore', timeout: 5000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if uv is available (either bundled or in system PATH)
 */
export async function checkUvInstalled(): Promise<boolean> {
  const { bin, source } = resolveUvBin();
  if (source === 'bundled' || source === 'bundled-fallback') {
    return existsSync(bin);
  }
  return findUvInPathSync();
}

/**
 * "Install" uv - now just verifies that uv is available somewhere.
 * Kept for API compatibility with frontend.
 */
export async function installUv(): Promise<void> {
  const isAvailable = await checkUvInstalled();
  if (!isAvailable) {
    const bin = getBundledUvPath();
    throw new Error(`uv not found in system PATH and bundled binary missing at ${bin}`);
  }
  logger.info('uv is available and ready to use');
}

/**
 * Check if a managed Python 3.12 is ready and accessible
 */
export async function isPythonReady(): Promise<boolean> {
  return Boolean(await findManagedPythonPath());
}

async function runPythonFind(
  uvBin: string,
  env?: Record<string, string | undefined>,
): Promise<string | null> {
  const prepared = prepareWinSpawn(uvBin, ['python', 'find', '3.12', '--managed-python', '--no-python-downloads']);

  return new Promise<string | null>((resolve) => {
    try {
      const child = spawn(
        prepared.command,
        prepared.args,
        {
          shell: prepared.shell,
          env,
          windowsHide: true,
        },
      );
      let output = '';
      child.stdout?.on('data', (data) => { output += data; });
      child.on('close', (code) => {
        const pythonPath = output.trim().split(/\r?\n/).find(Boolean)?.trim() || '';
        resolve(code === 0 && pythonPath ? pythonPath : null);
      });
      child.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

export async function findManagedPythonPath(): Promise<string | null> {
  const { bin: uvBin } = resolveUvBin();
  const bundledPythonDir = getBundledPythonDir();

  if (bundledPythonDir && existsSync(bundledPythonDir)) {
    const bundledPythonPath = await runPythonFind(uvBin, {
      ...process.env,
      UV_PYTHON_INSTALL_DIR: bundledPythonDir,
    });
    if (bundledPythonPath) {
      return bundledPythonPath;
    }
    logger.warn(`Bundled Python was not usable at ${bundledPythonDir}; checking the user-managed uv directory`);
  }

  return runPythonFind(uvBin);
}

/**
 * Run `uv python install 3.12` once with the given environment.
 * Returns on success, throws with captured stderr on failure.
 */
async function runPythonInstall(
  uvBin: string,
  env: Record<string, string | undefined>,
  label: string,
): Promise<void> {
  await assertCommandAllowedWithConfirmation({
    executable: uvBin,
    args: ['python', 'install', '3.12'],
    source: 'system:uv-python-install',
    allowCwdOutsideWorkspace: true,
  });

  const prepared = prepareWinSpawn(uvBin, ['python', 'install', '3.12']);
  return new Promise<void>((resolve, reject) => {
    const stderrChunks: string[] = [];
    const stdoutChunks: string[] = [];

    const child = spawn(prepared.command, prepared.args, {
      shell: prepared.shell,
      env,
      windowsHide: true,
    });

    child.stdout?.on('data', (data) => {
      const line = data.toString().trim();
      if (line) {
        stdoutChunks.push(line);
        logger.debug(`[python-setup:${label}] stdout: ${line}`);
      }
    });

    child.stderr?.on('data', (data) => {
      const line = data.toString().trim();
      if (line) {
        stderrChunks.push(line);
        logger.info(`[python-setup:${label}] stderr: ${line}`);
      }
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const stderr = stderrChunks.join('\n');
        const stdout = stdoutChunks.join('\n');
        const detail = stderr || stdout || '(no output captured)';
        reject(new Error(
          `Python installation failed with code ${code} [${label}]\n` +
          `  uv binary: ${uvBin}\n` +
          `  platform: ${process.platform}/${process.arch}\n` +
          `  output: ${detail}`
        ));
      }
    });

    child.on('error', (err) => {
      reject(new Error(
        `Python installation spawn error [${label}]: ${err.message}\n` +
        `  uv binary: ${uvBin}\n` +
        `  platform: ${process.platform}/${process.arch}`
      ));
    });
  });
}

export async function getManagedPythonEnv(
  baseEnv: Record<string, string | undefined> = {},
): Promise<Record<string, string | undefined>> {
  const pythonPath = await findManagedPythonPath();
  if (!pythonPath) return baseEnv;

  const pythonDir = dirname(pythonPath);
  const scriptsDir = process.platform === 'win32'
    ? join(pythonDir, 'Scripts')
    : pythonDir;
  const pythonBinDir = process.platform === 'win32'
    ? win32.normalize(pythonDir)
    : pythonDir;

  const env: Record<string, string | undefined> = {
    ...baseEnv,
    OPENCLAW_PINNED_PYTHON: pythonPath,
    OPENCLAW_PINNED_WRITE_PYTHON: pythonPath,
  };

  const withScripts = scriptsDir === pythonBinDir ? env : prependPathEntry(env, scriptsDir).env;
  return prependPathEntry(withScripts, pythonBinDir).env;
}

/**
 * Use bundled uv to install a managed Python version (default 3.12).
 *
 * Tries with mirror env first (for CN region), then retries without mirror
 * if the first attempt fails, to rule out mirror-specific issues.
 */
export async function setupManagedPython(): Promise<void> {
  const existingPython = await findManagedPythonPath();
  if (existingPython) {
    logger.info(`Managed Python 3.12 is already available at: ${existingPython}`);
    return;
  }

  const { bin: uvBin, source } = resolveUvBin();
  const uvEnv = await getUvMirrorEnv();
  const hasMirror = Object.keys(uvEnv).length > 0;

  logger.info(
    `Setting up managed Python 3.12 ` +
    `(uv=${uvBin}, source=${source}, arch=${process.arch}, mirror=${hasMirror})`
  );

  const baseEnv: Record<string, string | undefined> = { ...process.env };

  // Attempt 1: with mirror (if applicable)
  try {
    await runPythonInstall(uvBin, { ...baseEnv, ...uvEnv }, hasMirror ? 'mirror' : 'default');
  } catch (firstError) {
    logger.warn('Python install attempt 1 failed:', firstError);

    if (hasMirror) {
      // Attempt 2: retry without mirror to rule out mirror issues
      logger.info('Retrying Python install without mirror...');
      try {
        await runPythonInstall(uvBin, baseEnv, 'no-mirror');
      } catch (secondError) {
        logger.error('Python install attempt 2 (no mirror) also failed:', secondError);
        throw secondError;
      }
    } else {
      throw firstError;
    }
  }

  // After installation, verify and log the Python path.
  try {
    const findPath = await findManagedPythonPath();
    if (findPath) {
      logger.info(`Managed Python 3.12 installed at: ${findPath}`);
    }
  } catch (err) {
    logger.warn('Could not determine Python path after install:', err);
  }
}
