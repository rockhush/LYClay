/**
 * Context Compactor
 * Compresses long conversation history by summarizing older messages.
 * Designed for 200K token context windows.
 */
import type { RawMessage } from './types';
import { estimateHistoryTokens, estimateMessageTokens, needsCompression } from '@/lib/token-estimator';

export interface CompressionResult {
  originalCount: number;
  compressedMessages: RawMessage[];
  summaryMessage: RawMessage;
}

/** Token threshold to trigger compression (150K for 200K context window) */
export const DEFAULT_COMPRESSION_THRESHOLD = 150000;

/** Target tokens to keep after compression (~30K) */
const KEEP_RECENT_TOKENS = 30000;

/** Minimum rounds between compressions (to avoid frequent compressions) */
const MIN_ROUNDS_BETWEEN_COMPRESSION = 5;

/** Track when last compression happened per session */
const lastCompressionRound = new Map<string, number>();

const SUMMARY_PROMPT_TEMPLATE = `请将以下对话历史压缩为结构化摘要，保留后续继续对话和执行任务所需的关键信息。

【压缩要求】
- 不要编造未出现的信息
- 保留用户目标、已确认需求、当前任务状态、关键文件/函数/配置名、重要错误和命令结果
- 删除闲聊、重复确认、无效中间过程
- 如果旧信息与新消息冲突，以新消息为准
- 摘要尽量控制在约 {summaryTokens} tokens 内
- 使用简洁中文 Markdown，直接输出摘要内容

【建议结构】
## 用户目标
- ...

## 已确认需求
- ...

## 当前任务状态
- 已完成：...
- 未完成：...
- 阻塞：...

## 关键项目事实
- ...

## 关键文件和位置
- ...

## 重要错误和命令结果
- ...

## 用户偏好
- ...

【对话历史】
{history}

【摘要】`;

export interface CompactorOptions {
  /** Token threshold to trigger compression */
  threshold: number;
  /** Minimum message count to consider compression */
  minMessageCount?: number;
  /** Target tokens to keep after compression */
  keepRecentTokens?: number;
  /** Target tokens for generated summary */
  summaryTokens?: number;
  /** Hard input limit after compression */
  hardLimitTokens?: number;
  /** Minimum rounds between compressions */
  minRoundsBetweenCompression?: number;
}

export interface InvokeRpcFn {
  (method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
}

/**
 * Check if history needs compression.
 */
export function checkNeedsCompression(
  messages: RawMessage[],
  sessionKey: string,
  options: CompactorOptions,
): boolean {
  const { threshold, minMessageCount = 10, minRoundsBetweenCompression = MIN_ROUNDS_BETWEEN_COMPRESSION } = options;

  // Check if enough rounds have passed since last compression
  const lastRound = lastCompressionRound.get(sessionKey) ?? 0;
  const roundsSinceLastCompression = messages.length - lastRound;
  if (roundsSinceLastCompression < minRoundsBetweenCompression) {
    return false;
  }

  return needsCompression(messages, threshold, minMessageCount);
}

/**
 * Format message content as text for summarization.
 */
function formatMessageForSummary(msg: RawMessage): string {
  const roleLabel = msg.role === 'user' ? '用户' : msg.role === 'assistant' ? '助手' : msg.role;
  let content: string;

  if (typeof msg.content === 'string') {
    content = msg.content;
  } else if (Array.isArray(msg.content)) {
    content = msg.content
      .map((block) => {
        if (typeof block === 'object' && block !== null) {
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && b.text) return String(b.text);
          if (b.type === 'thinking' && b.thinking) return `[思考] ${b.thinking}`;
          if (b.type === 'tool_use' || b.type === 'toolUse') {
            return `[工具调用] ${b.name ?? 'unknown'}: ${JSON.stringify(b.input ?? b.arguments ?? {})}`;
          }
          if (b.type === 'tool_result' || b.type === 'toolResult') {
            const result = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
            return `[工具结果] ${result.slice(0, 200)}${result.length > 200 ? '...' : ''}`;
          }
        }
        return JSON.stringify(block).slice(0, 100);
      })
      .filter(Boolean)
      .join('\n');
  } else {
    content = String(msg.content);
  }

  // Truncate very long messages
  if (content.length > 1000) {
    content = content.slice(0, 1000) + '...';
  }

  return `${roleLabel}: ${content}`;
}

/**
 * Find the split point for messages to keep based on token budget.
 * Walks backward from the most recent message until we reach the token limit.
 */
function findKeepMessagesByTokens(messages: RawMessage[], targetTokens: number): { keep: RawMessage[]; compress: RawMessage[] } {
  let tokenCount = 0;
  let splitIndex = messages.length;

  // Walk backward and include messages until we hit the token budget
  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateMessageTokens(messages[i].content);
    if (tokenCount + msgTokens > targetTokens) {
      splitIndex = i + 1;
      break;
    }
    tokenCount += msgTokens;
    splitIndex = i;
  }

  return {
    keep: messages.slice(splitIndex),
    compress: messages.slice(0, splitIndex),
  };
}

/**
 * Compress conversation history by summarizing older messages.
 */
export async function compressHistory(
  messages: RawMessage[],
  sessionKey: string,
  invokeRpc: InvokeRpcFn,
  options: CompactorOptions,
): Promise<CompressionResult | null> {
  const {
    keepRecentTokens = KEEP_RECENT_TOKENS,
    summaryTokens = 4000,
    hardLimitTokens,
  } = options;

  if (!checkNeedsCompression(messages, sessionKey, options)) {
    return null;
  }

  // Separate messages based on token budget
  const { keep: keepRecent, compress: toCompress } = findKeepMessagesByTokens(messages, keepRecentTokens);

  if (toCompress.length === 0) {
    return null;
  }

  const toCompressTokens = estimateHistoryTokens(toCompress);

  // Build history text for summarization
  const historyText = toCompress.map(formatMessageForSummary).join('\n\n');
  const summaryPrompt = SUMMARY_PROMPT_TEMPLATE
    .replace('{summaryTokens}', String(summaryTokens))
    .replace('{history}', historyText);

  // Estimate tokens for the summary prompt
  const promptTokens = Math.ceil(summaryPrompt.length * 0.4);
  const currentTokens = estimateHistoryTokens(messages);

  // Check if we have enough headroom for the summary request
  // Reserve some tokens for the response
  if (hardLimitTokens && currentTokens + promptTokens > hardLimitTokens) {
    console.warn('[context-compactor] not enough headroom for summarization, falling back to truncation');
    return createSimpleTruncationByTokens(messages, keepRecentTokens);
  }

  try {
    console.log('[context-compactor] starting summarization for', toCompress.length, 'messages', `(${toCompressTokens} tokens)`);

    const response = await invokeRpc(
      'chat.send',
      {
        sessionKey: '__compactor__',
        message: summaryPrompt,
        deliver: false,
      },
      60000, // 60s timeout for summarization
    ) as { success?: boolean; result?: { message?: { content?: string } }; error?: string };

    if (!response?.success && !response?.result?.message?.content) {
      console.warn('[context-compactor] summarization failed, falling back to truncation');
      return createSimpleTruncationByTokens(messages, keepRecentTokens);
    }

    const summaryText = response?.result?.message?.content ?? '（历史对话已压缩）';

    // Update compression tracking
    lastCompressionRound.set(sessionKey, messages.length);

    return {
      originalCount: messages.length,
      compressedMessages: keepRecent,
      summaryMessage: {
        role: 'system',
        content: `[上文已压缩（${toCompress.length} 条消息，约 ${toCompressTokens} tokens），摘要：\n\n${summaryText}]`,
        timestamp: Date.now() / 1000,
        id: crypto.randomUUID(),
      },
    };
  } catch (error) {
    console.error('[context-compactor] compression error:', error);
    return createSimpleTruncationByTokens(messages, keepRecentTokens);
  }
}

/**
 * Simple truncation fallback when summarization fails (by token budget).
 */
function createSimpleTruncationByTokens(messages: RawMessage[], keepTokens: number): CompressionResult {
  const { keep: keepRecent, compress: toCompress } = findKeepMessagesByTokens(messages, keepTokens);

  return {
    originalCount: messages.length,
    compressedMessages: keepRecent,
    summaryMessage: {
      role: 'system',
      content: `[上下文压缩失败。系统仅保留最近对话，较早的 ${toCompress.length} 条消息未进入本次请求。]`,
      timestamp: Date.now() / 1000,
      id: crypto.randomUUID(),
    },
  };
}

/**
 * Reset compression tracking for a session (call when session changes).
 */
export function resetCompactorSession(sessionKey: string): void {
  lastCompressionRound.delete(sessionKey);
}