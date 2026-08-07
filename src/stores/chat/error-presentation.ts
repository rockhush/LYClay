import type { TFunction } from 'i18next';
import { isSubagentStalledErrorMessage } from '@/lib/subagent-delegation-watch';
import {
  isBackendRunFailureError,
  isOutboundMediaPathFailedRunError,
  truncateRunErrorMessage,
} from './helpers';

export type ChatRunErrorPresentation = {
  title: string;
  detail: string;
};

export function resolveEmbeddedAgentFailureMessage(
  text: string,
  t: TFunction<'chat'>,
): string | null {
  const normalized = text.toLowerCase();
  if (
    normalized.includes("agent couldn't generate a response")
    || normalized.includes('agent could not generate a response')
  ) {
    return t('errors.agentCouldNotGenerateResponse');
  }
  return null;
}

function redactLocalUserPaths(message: string, replacement: string): string {
  return message
    .replace(/[A-Za-z]:\\Users\\[^\\\s"'<>]+(?:\\[^\\\s"'<>]+)*/gi, replacement)
    .replace(/(^|[\s("'=:])(\/(?:home|Users)\/[^/\s"'<>]+(?:\/[^/\s"'<>]+)*)/g, `$1${replacement}`)
    .replace(/~\/[^\s"'<>]+/g, replacement);
}

export function resolveChatRunErrorPresentation(
  error: string | null | undefined,
  t: TFunction<'chat'>,
): ChatRunErrorPresentation | null {
  if (!error) return null;

  const normalized = error.toLowerCase();
  const backendStoppedMessage = t('errors.backendRunStopped');
  const runAbortedBySystemMessage = t('errors.runAbortedBySystem');

  if (error === backendStoppedMessage || isBackendRunFailureError(error)) {
    return { title: t('errors.backendRunStoppedTitle'), detail: backendStoppedMessage };
  }
  if (error === runAbortedBySystemMessage) {
    return { title: t('errors.runAbortedTitle'), detail: runAbortedBySystemMessage };
  }
  if (isSubagentStalledErrorMessage(error)) {
    return { title: t('errors.subagentStalledTitle'), detail: error };
  }
  if (
    normalized.includes('isolated agent setup timed out before runner start')
    || normalized.includes('isolated agent run stalled before execution start')
  ) {
    return {
      title: t('errors.isolatedAgentSetupTimeoutTitle'),
      detail: t('errors.isolatedAgentSetupTimeout'),
    };
  }
  if (
    normalized.includes('agent failed before reply')
    && normalized.includes('llm request timed out')
  ) {
    return { title: t('errors.llmIdleTimeoutTitle'), detail: t('errors.llmRequestTimeout') };
  }
  if (normalized.includes('provider rejected the request schema or tool payload')) {
    return {
      title: t('errors.providerPayloadRejectedTitle'),
      detail: t('errors.providerPayloadRejected'),
    };
  }
  if (
    normalized.includes("agent couldn't generate a response")
    || normalized.includes('agent could not generate a response')
  ) {
    return {
      title: t('errors.responseGenerationFailedTitle'),
      detail: t('errors.agentCouldNotGenerateResponse'),
    };
  }
  if (normalized.includes('run interrupted because the gateway restarted')) {
    return {
      title: t('errors.runAbortedTitle'),
      detail: t('errors.gatewayRestartInterrupted'),
    };
  }
  if (
    normalized.includes('outbounddeliveryerror')
    && normalized.includes('status code 400')
  ) {
    return {
      title: t('errors.messageDeliveryFailedTitle'),
      detail: t('errors.outboundDeliveryBadRequest'),
    };
  }
  if (
    /^(?:cmd(?:\.exe)?\s+\/c|powershell(?:\.exe)?\b|python(?:3|\.exe)?\b)/i.test(error.trim())
    && /\bfailed\.?$/i.test(error.trim())
  ) {
    return {
      title: t('errors.commandExecutionFailedTitle'),
      detail: t('errors.commandExecutionFailed'),
    };
  }
  if (/^run ended\.?$/i.test(error.trim())) {
    return {
      title: t('errors.runEndedTitle'),
      detail: t('errors.runEndedWithoutResult'),
    };
  }
  if (normalized.includes('llm idle timeout')) {
    return { title: t('errors.llmIdleTimeoutTitle'), detail: t('errors.llmIdleTimeout') };
  }
  if (normalized.includes('modelresponsetimeoutlong') || normalized.includes('model response timeout')) {
    return { title: t('errors.runTimedOutTitle'), detail: t('errors.modelResponseTimeoutLong') };
  }
  if (normalized.includes('rpc timeout')) {
    return { title: t('errors.runEndedTitle'), detail: t('errors.rpcTimeout') };
  }
  if (normalized.includes('list index out of range') || normalized.includes('tool call stream error')) {
    return { title: t('errors.executionFailedTitle'), detail: t('errors.toolCallStreamInvalid') };
  }
  if (normalized.includes('context overflow')) {
    return { title: t('errors.contextTooLargeTitle'), detail: t('errors.contextTooLarge') };
  }
  if (normalized.includes('toolexecutiontimeout') || normalized.includes('tool execution')) {
    return { title: t('errors.toolExecutionTimeoutTitle'), detail: t('errors.toolExecutionTimeout') };
  }
  if (isOutboundMediaPathFailedRunError(error)) {
    return { title: t('errors.outboundMediaFailedTitle'), detail: t('errors.outboundMediaFailed') };
  }
  const safeError = redactLocalUserPaths(error, t('errors.localPathHidden'));
  return { title: t('errors.runEndedTitle'), detail: truncateRunErrorMessage(safeError) };
}

export function resolveEmptyFinalRecoveryMessage(
  status: string,
  t: TFunction<'chat'>,
): string {
  switch (status) {
    case 'stale':
      return t('errors.emptyFinalStale');
    case 'waiting':
      return t('errors.emptyFinalWaiting');
    case 'recovered':
      return t('errors.emptyFinalRecovered');
    case 'failed':
      return t('errors.emptyFinalFailed');
    default:
      return t('errors.emptyFinalRecovering');
  }
}
