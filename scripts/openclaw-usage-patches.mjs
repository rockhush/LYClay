/**
 * Force OpenClaw openai-completions streaming requests to ask for usage chunks.
 * vLLM / local OpenAI-compatible servers need stream_options.include_usage=true.
 *
 * OpenClaw 2026.5.19 gates this on compat.supportsUsageInStreaming, but runtime
 * model compat from models.json may not always reach getCompat() — unconditional
 * include_usage is safe (unsupported backends ignore the field).
 */

const USAGE_PATCH_MARKER = '/* lyclaw:force-stream-include-usage */';

export function hasOpenClawUsageStreamingPatches(source) {
  return source.includes(USAGE_PATCH_MARKER);
}

export function applyOpenClawUsageStreamingPatches(source) {
  if (hasOpenClawUsageStreamingPatches(source)) {
    return { source, patched: false };
  }

  const patterns = [
    [
      /if\s*\(\s*compat\.supportsUsageInStreaming\s*\)\s*\{\s*params\.stream_options\s*=\s*\{\s*include_usage\s*:\s*true\s*\}\s*;\s*\}/,
      `params.stream_options = { include_usage: true }; ${USAGE_PATCH_MARKER}`,
    ],
    [
      /if\s*\(\s*compat\.supportsUsageInStreaming\s*\)\s*\{\s*\n\s*params\.stream_options\s*=\s*\{\s*include_usage\s*:\s*true\s*\}\s*;\s*\n\s*\}/,
      `params.stream_options = { include_usage: true }; ${USAGE_PATCH_MARKER}`,
    ],
    [
      /if\s*\(\s*compat\.supportsUsageInStreaming\s*\)\s*\{\s*\n\tparams\.stream_options\s*=\s*\{\s*include_usage\s*:\s*true\s*\}\s*;\s*\n\t\}/,
      `params.stream_options = { include_usage: true }; ${USAGE_PATCH_MARKER}`,
    ],
    [
      /if\(compat\.supportsUsageInStreaming\)\{params\.stream_options=\{include_usage:!0\}\}/,
      `params.stream_options={include_usage:!0};${USAGE_PATCH_MARKER.replace(/\s/g, '')}`,
    ],
    [
      /compat\.supportsUsageInStreaming\s*&&\s*\(\s*params\.stream_options\s*=\s*\{\s*include_usage\s*:\s*!0\s*\}\s*\)/,
      `params.stream_options = { include_usage: !0 }; ${USAGE_PATCH_MARKER}`,
    ],
    [
      /if\s*\(\s*compat\.supportsUsageInStreaming\s*\)\s*params\.stream_options\s*=\s*\{\s*include_usage\s*:\s*true\s*\}\s*;/,
      `params.stream_options = { include_usage: true }; ${USAGE_PATCH_MARKER}`,
    ],
    [
      /compat\.supportsUsageInStreaming\s*&&\s*\(\s*params\.stream_options\s*=\s*\{\s*include_usage\s*:\s*true\s*\}\s*\)/,
      `params.stream_options = { include_usage: true }; ${USAGE_PATCH_MARKER}`,
    ],
  ];

  for (const [pattern, replacement] of patterns) {
    if (pattern.test(source)) {
      return {
        source: source.replace(pattern, replacement),
        patched: true,
      };
    }
  }

  // Fallback: inject right after `stream: true` in buildOpenAICompletionsParams params object.
  const streamTrueNeedle = 'stream:!0';
  const streamTrueNeedleSpaced = 'stream: true';
  if (source.includes('buildOpenAICompletionsParams') || source.includes('stream_options')) {
    if (source.includes(streamTrueNeedle) && !source.includes('include_usage')) {
      const injected = source.replace(
        /stream:!0,/,
        `stream:!0,stream_options:{include_usage:!0},${USAGE_PATCH_MARKER.replace(/\s/g, '')}`,
      );
      if (injected !== source) {
        return { source: injected, patched: true };
      }
    }
    if (source.includes(streamTrueNeedleSpaced) && !source.includes('include_usage')) {
      const injected = source.replace(
        /stream: true,\n/,
        `stream: true,\n params.stream_options = { include_usage: true }; ${USAGE_PATCH_MARKER}\n`,
      );
      if (injected !== source) {
        return { source: injected, patched: true };
      }
    }
  }

  return { source, patched: false };
}

const PI_AI_USAGE_PATCH_MARKER = '/* lyclaw:force-pi-ai-include-usage */';

export function hasPiAiUsageStreamingPatches(source) {
  return source.includes(PI_AI_USAGE_PATCH_MARKER);
}

export function applyPiAiUsageStreamingPatches(source) {
  if (hasPiAiUsageStreamingPatches(source)) {
    return { source, patched: false };
  }

  const guarded = /if\s*\(\s*compat\.supportsUsageInStreaming\s*!==\s*false\s*\)\s*\{\s*params\.stream_options\s*=\s*\{\s*include_usage\s*:\s*true\s*\}\s*;\s*\}/;
  if (guarded.test(source)) {
    return {
      source: source.replace(
        guarded,
        `params.stream_options = { include_usage: true }; ${PI_AI_USAGE_PATCH_MARKER}`,
      ),
      patched: true,
    };
  }

  return { source, patched: false };
}
