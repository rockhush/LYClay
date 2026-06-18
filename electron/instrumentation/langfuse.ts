/**
 * Langfuse OpenTelemetry bootstrap for the Electron main process.
 * Disabled by default — uncomment imports in electron/main/index.ts and
 * langfuse hooks in electron/gateway/manager.ts to enable for local debugging.
 */
import { randomBytes } from 'node:crypto';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { logger } from '../utils/logger';
import { logEnvBootstrapStatus } from './load-env';

let sdk: NodeSDK | null = null;
let spanProcessor: LangfuseSpanProcessor | null = null;
let initialized = false;

function readEnvFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function isLangfuseTracingConfigured(): boolean {
  if (readEnvFlag('LYCLAW_LANGFUSE_ENABLED')) {
    return Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);
  }
  return Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);
}

export function isLangfuseTracingEnabled(): boolean {
  if (readEnvFlag('LYCLAW_LANGFUSE_DISABLED')) {
    return false;
  }
  return isLangfuseTracingConfigured();
}

export function getLangfuseSpanProcessor(): LangfuseSpanProcessor | null {
  return spanProcessor;
}

export function initLangfuseTracing(): void {
  if (initialized) {
    return;
  }
  initialized = true;
  logEnvBootstrapStatus();

  if (!isLangfuseTracingEnabled()) {
    const message = '[langfuse] tracing disabled — set LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY in project .env';
    console.info(message);
    logger.info(message);
    return;
  }

  try {
    spanProcessor = new LangfuseSpanProcessor();
    sdk = new NodeSDK({
      spanProcessors: [spanProcessor],
    });
    sdk.start();
    const details = {
      baseUrl: process.env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_HOST ?? 'default',
    };
    console.info('[langfuse] tracing initialized', details);
    logger.info('[langfuse] tracing initialized', details);
  } catch (error) {
    spanProcessor = null;
    sdk = null;
    console.warn('[langfuse] failed to initialize tracing:', error);
    logger.warn('[langfuse] failed to initialize tracing:', error);
  }
}

export async function flushLangfuseTracing(): Promise<void> {
  if (!spanProcessor) {
    return;
  }
  try {
    await spanProcessor.forceFlush();
  } catch (error) {
    logger.warn('[langfuse] forceFlush failed:', error);
  }
}

export async function shutdownLangfuseTracing(): Promise<void> {
  try {
    if (spanProcessor) {
      await spanProcessor.forceFlush();
    }
    if (sdk) {
      await sdk.shutdown();
    }
  } catch (error) {
    logger.warn('[langfuse] shutdown failed:', error);
  } finally {
    sdk = null;
    spanProcessor = null;
  }
}

export function randomLangfuseSpanId(): string {
  return randomBytes(8).toString('hex');
}

// initLangfuseTracing();
