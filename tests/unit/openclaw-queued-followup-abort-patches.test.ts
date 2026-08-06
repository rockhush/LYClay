import { readFileSync, realpathSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  applyOpenClawQueuedFollowupAbortPatches,
  hasOpenClawQueuedFollowupAbortPatches,
} from '../../scripts/openclaw-queued-followup-abort-patches.mjs';

const ORIGINAL_SOURCE = 'const queuedFollowupAbortSignal = inboundEventKind === "room_event" ? internalOpts?.queuedFollowupAbortSignal ?? opts?.abortSignal : void 0;';

function readInstalledGetReplyBundle(): string {
  const openClawDir = realpathSync(join(process.cwd(), 'node_modules', 'openclaw'));
  const distDir = join(openClawDir, 'dist');
  const fileName = readdirSync(distDir).find((name) => /^get-reply-.*\.js$/.test(name));
  if (!fileName) throw new Error('OpenClaw get-reply bundle not found');
  return readFileSync(join(distDir, fileName), 'utf8');
}

function evaluateQueuedFollowupAbortSignal(
  source: string,
  inboundEventKind: string | undefined,
  isInternalPromptChannel: boolean,
  signal: AbortSignal,
): AbortSignal | undefined {
  const match = source.match(/const queuedFollowupAbortSignal = ([^;]+);/);
  if (!match?.[1]) throw new Error('queuedFollowupAbortSignal expression not found');
  const evaluate = new Function(
    'inboundEventKind',
    'isInternalPromptChannel',
    'internalOpts',
    'opts',
    `return (${match[1]});`,
  ) as (
    eventKind: string | undefined,
    internalChannel: boolean,
    internalOpts: { queuedFollowupAbortSignal?: AbortSignal },
    opts: { abortSignal?: AbortSignal },
  ) => AbortSignal | undefined;

  return evaluate(inboundEventKind, isInternalPromptChannel, {}, { abortSignal: signal });
}

describe('OpenClaw queued follow-up abort propagation', () => {
  it('patches only the queued follow-up abort condition for internal webchat', () => {
    const result = applyOpenClawQueuedFollowupAbortPatches(ORIGINAL_SOURCE);

    expect(result.patched).toBe(true);
    expect(hasOpenClawQueuedFollowupAbortPatches(result.source)).toBe(true);
    expect(result.source).toContain(
      '(inboundEventKind === "room_event" || isInternalPromptChannel)',
    );
  });

  it('is idempotent and leaves unrelated source unchanged', () => {
    const once = applyOpenClawQueuedFollowupAbortPatches(ORIGINAL_SOURCE).source;
    const twice = applyOpenClawQueuedFollowupAbortPatches(once);
    const unrelated = applyOpenClawQueuedFollowupAbortPatches('const value = 1;');

    expect(twice).toEqual({ source: once, patched: false });
    expect(unrelated).toEqual({ source: 'const value = 1;', patched: false });
  });

  it('retains the request abort signal for internal webchat follow-ups', () => {
    const source = readInstalledGetReplyBundle();
    const controller = new AbortController();

    expect(evaluateQueuedFollowupAbortSignal(source, undefined, true, controller.signal))
      .toBe(controller.signal);
  });

  it('preserves room-event behavior without leaking the signal to external message follow-ups', () => {
    const source = readInstalledGetReplyBundle();
    const controller = new AbortController();

    expect(evaluateQueuedFollowupAbortSignal(source, 'room_event', false, controller.signal))
      .toBe(controller.signal);
    expect(evaluateQueuedFollowupAbortSignal(source, undefined, false, controller.signal))
      .toBeUndefined();
  });

  it('keeps the webchat abort propagation in the checked-in pnpm patch', () => {
    const patch = readFileSync(
      join(process.cwd(), 'patches', 'openclaw@2026.6.5.patch'),
      'utf8',
    );

    expect(patch).toContain(
      '(inboundEventKind === "room_event" || isInternalPromptChannel)',
    );
  });

  it('is wired into development and bundle patch scripts', () => {
    const devPatchSource = readFileSync(join(process.cwd(), 'scripts', 'patch-openclaw-dev.mjs'), 'utf8');
    const bundlePatchSource = readFileSync(join(process.cwd(), 'scripts', 'bundle-openclaw.mjs'), 'utf8');

    expect(devPatchSource).toContain("from './openclaw-queued-followup-abort-patches.mjs'");
    expect(bundlePatchSource).toContain("from './openclaw-queued-followup-abort-patches.mjs'");
  });
});
