import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  SHELL_SNAPSHOT_PATCH_MARKER,
  applyOpenClawElectronShellSnapshotPatch,
  hasOpenClawElectronShellSnapshotPatch,
  isOpenClawShellSnapshotBundle,
} from '../../scripts/openclaw-shell-snapshot-patches.mjs';

const VULNERABLE_COMMAND = '`${shQuote(process.execPath)} -e ${shQuote(ENV_CAPTURE_NODE_SCRIPT)}`';
const SAFE_COMMAND = '`${process.versions.electron ? "ELECTRON_RUN_AS_NODE=1 " : ""}${shQuote(process.execPath)} -e ${shQuote(ENV_CAPTURE_NODE_SCRIPT)}`';

const VULNERABLE_SOURCE = [
  'async function captureShellSnapshot(opts) {',
  '\tconst captureCommand = [',
  `\t\t${VULNERABLE_COMMAND},`,
  '\t].join("\\n");',
  '\treturn captureCommand;',
  '}',
  'const ENV_CAPTURE_NODE_SCRIPT = `process.stdout.write("ok");`;',
].join('\n');

describe('OpenClaw Electron shell snapshot patch', () => {
  it('adds Electron Node mode only to the environment capture command', () => {
    const result = applyOpenClawElectronShellSnapshotPatch(VULNERABLE_SOURCE);

    expect(result).toMatchObject({ patched: true, verified: true });
    expect(result.source).toContain(SAFE_COMMAND);
    expect(result.source).toContain(SHELL_SNAPSHOT_PATCH_MARKER);
    expect(result.source).not.toContain(`\t\t${VULNERABLE_COMMAND},`);
    expect(result.source).not.toContain('process.env.ELECTRON_RUN_AS_NODE =');
  });

  it('keeps the patch idempotent', () => {
    const once = applyOpenClawElectronShellSnapshotPatch(VULNERABLE_SOURCE);
    const twice = applyOpenClawElectronShellSnapshotPatch(once.source);

    expect(twice).toEqual({ source: once.source, patched: false, verified: true });
    expect(twice.source.match(new RegExp(SHELL_SNAPSHOT_PATCH_MARKER, 'g'))).toHaveLength(1);
  });

  it('recognizes an equivalent upstream runtime-scoped fix', () => {
    const upstreamFixed = VULNERABLE_SOURCE.replace(VULNERABLE_COMMAND, SAFE_COMMAND);

    expect(hasOpenClawElectronShellSnapshotPatch(upstreamFixed)).toBe(true);
    expect(applyOpenClawElectronShellSnapshotPatch(upstreamFixed)).toEqual({
      source: upstreamFixed,
      patched: false,
      verified: true,
    });
  });

  it('rejects a snapshot bundle whose vulnerable command anchor drifted', () => {
    const drifted = VULNERABLE_SOURCE.replace(
      VULNERABLE_COMMAND,
      '`runNodeEval(ENV_CAPTURE_NODE_SCRIPT)`',
    );

    expect(isOpenClawShellSnapshotBundle(drifted)).toBe(true);
    expect(hasOpenClawElectronShellSnapshotPatch(drifted)).toBe(false);
    expect(applyOpenClawElectronShellSnapshotPatch(drifted)).toEqual({
      source: drifted,
      patched: false,
      verified: false,
    });
  });

  it('rejects a drifted capture command when a patched command exists elsewhere', () => {
    const drifted = VULNERABLE_SOURCE.replace(
      VULNERABLE_COMMAND,
      '`runNodeEval(ENV_CAPTURE_NODE_SCRIPT)`',
    );
    const misleadingSource = [
      drifted,
      'function unrelatedExample() {',
      `\treturn ${SAFE_COMMAND} /* ${SHELL_SNAPSHOT_PATCH_MARKER} */;`,
      '}',
    ].join('\n');

    expect(hasOpenClawElectronShellSnapshotPatch(misleadingSource)).toBe(false);
    expect(applyOpenClawElectronShellSnapshotPatch(misleadingSource)).toEqual({
      source: misleadingSource,
      patched: false,
      verified: false,
    });
  });

  it('does not accept a nested safe function for a vulnerable top-level command', () => {
    const nestedSafeFunction = VULNERABLE_SOURCE
      .replace(VULNERABLE_COMMAND, SAFE_COMMAND)
      .split('\n')
      .map((line) => `\t${line}`)
      .join('\n');
    const misleadingSource = [
      'function unrelatedWrapper() {',
      nestedSafeFunction,
      '}',
      VULNERABLE_SOURCE,
    ].join('\n');

    expect(hasOpenClawElectronShellSnapshotPatch(misleadingSource)).toBe(false);
    const result = applyOpenClawElectronShellSnapshotPatch(misleadingSource);
    expect(result).toMatchObject({ patched: true, verified: true });
    expect(result.source.match(new RegExp(SHELL_SNAPSHOT_PATCH_MARKER, 'g'))).toHaveLength(1);
  });

  it('rejects a syntactically invalid snapshot bundle', () => {
    const invalidSource = [
      VULNERABLE_SOURCE.replace(VULNERABLE_COMMAND, SAFE_COMMAND),
      'const broken = ;',
    ].join('\n');

    expect(hasOpenClawElectronShellSnapshotPatch(invalidSource)).toBe(false);
    expect(applyOpenClawElectronShellSnapshotPatch(invalidSource)).toEqual({
      source: invalidSource,
      patched: false,
      verified: false,
    });
  });

  it('does not modify unrelated bundles', () => {
    const unrelated = 'function executeCommand(command) { return command; }';

    expect(isOpenClawShellSnapshotBundle(unrelated)).toBe(false);
    expect(applyOpenClawElectronShellSnapshotPatch(unrelated)).toEqual({
      source: unrelated,
      patched: false,
      verified: false,
    });
  });

  it('patches or verifies the installed OpenClaw shell snapshot bundle', () => {
    const openClawDir = realpathSync(join(process.cwd(), 'node_modules', 'openclaw'));
    const distDir = join(openClawDir, 'dist');
    const snapshotFiles = readdirSync(distDir).filter((name) => {
      if (!name.endsWith('.js')) return false;
      return isOpenClawShellSnapshotBundle(readFileSync(join(distDir, name), 'utf8'));
    });

    expect(snapshotFiles.length).toBeGreaterThan(0);
    for (const name of snapshotFiles) {
      const source = readFileSync(join(distDir, name), 'utf8');
      const wasVerified = hasOpenClawElectronShellSnapshotPatch(source);
      const result = applyOpenClawElectronShellSnapshotPatch(source);
      expect(result.verified).toBe(true);
      expect(result.patched).toBe(!wasVerified);
    }
  });

  it('wires the shared patch into development and packaging scripts', () => {
    const devPatchSource = readFileSync(join(process.cwd(), 'scripts', 'patch-openclaw-dev.mjs'), 'utf8');
    const bundleSource = readFileSync(join(process.cwd(), 'scripts', 'bundle-openclaw.mjs'), 'utf8');

    for (const source of [devPatchSource, bundleSource]) {
      expect(source).toContain("from './openclaw-shell-snapshot-patches.mjs'");
      expect(source).toContain('applyOpenClawElectronShellSnapshotPatch');
      expect(source).toContain('isOpenClawShellSnapshotBundle');
      expect(source).toContain('Failed to patch Electron shell snapshot runtime');
    }
  });
});
