/**
 * History Time Decay
 *
 * 沉默默认机制：根据会话最后活跃时间自动调整加载量。
 * - 旧会话少加载（消息数限制）
 * - 过滤大型工具结果（已完成任务的输出无需重入上下文）
 * - Token 预算截断（从最新消息倒序截断）
 */
import type { RawMessage } from './types';
import { estimateMessageTokens } from '@/lib/token-estimator';

// ── 时间衰减阈值 ────────────────────────────────────────

interface TimeDecayThreshold {
  /** 距离最后活跃时间的小时数 */
  hoursAgo: number;
  /** 消息数量限制 */
  messageLimit: number;
  /** Token 预算限制 */
  tokenBudget: number;
}

const THRESHOLDS: TimeDecayThreshold[] = [
  { hoursAgo: 0,   messageLimit: 200, tokenBudget: 100000 },
  { hoursAgo: 1,   messageLimit: 120, tokenBudget: 80000 },
  { hoursAgo: 3,   messageLimit: 80,  tokenBudget: 60000 },
  { hoursAgo: 12,  messageLimit: 50,  tokenBudget: 40000 },
  { hoursAgo: 24,  messageLimit: 30,  tokenBudget: 25000 },
  { hoursAgo: 72,  messageLimit: 20,  tokenBudget: 20000 },
  { hoursAgo: 168, messageLimit: 15,  tokenBudget: 15000 },
];

/** 工具结果过滤大小阈值（字节） */
const TOOL_RESULT_SIZE_THRESHOLD = 5000;

// ── 核心函数 ─────────────────────────────────────────────

/**
 * 根据会话最后活跃时间计算加载限制。
 * 如果没有时间信息（新会话），使用最宽松的限制。
 */
export function calculateHistoryLimits(
  lastActivityMs: number | undefined,
  hasCachedCompression?: boolean,
): { messageLimit: number; tokenBudget: number } {
  if (hasCachedCompression) {
    return { messageLimit: THRESHOLDS[0].messageLimit, tokenBudget: THRESHOLDS[0].tokenBudget };
  }

  if (!lastActivityMs) {
    return { messageLimit: THRESHOLDS[0].messageLimit, tokenBudget: THRESHOLDS[0].tokenBudget };
  }

  const hoursAgo = (Date.now() - lastActivityMs) / (3600 * 1000);

  for (let i = THRESHOLDS.length - 1; i >= 0; i--) {
    if (hoursAgo >= THRESHOLDS[i].hoursAgo) {
      return { messageLimit: THRESHOLDS[i].messageLimit, tokenBudget: THRESHOLDS[i].tokenBudget };
    }
  }

  return { messageLimit: THRESHOLDS[0].messageLimit, tokenBudget: THRESHOLDS[0].tokenBudget };
}

/**
 * 过滤大型工具结果（已完成的任务输出无需重新加载到上下文）。
 */
export function filterLargeToolResults(messages: RawMessage[]): RawMessage[] {
  return messages.filter((msg) => {
    if (msg.role !== 'toolresult') return true;
    const size = JSON.stringify(msg.content).length;
    return size <= TOOL_RESULT_SIZE_THRESHOLD;
  });
}

/**
 * 从最新消息倒序累加 token 数，直到预算上限。
 */
function truncateByTokenBudget(messages: RawMessage[], tokenBudget: number): RawMessage[] {
  if (messages.length === 0) return [];

  let accumulated = 0;
  const result: RawMessage[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateMessageTokens(messages[i].content);
    if (accumulated + msgTokens > tokenBudget && result.length > 0) break;
    accumulated += msgTokens;
    result.unshift(messages[i]);
  }

  return result;
}

/** 用于调试的统计信息 */
export interface TimeDecayStats {
  originalCount: number;
  filteredCount: number;
  finalCount: number;
  estimatedTokens: number;
  appliedMessageLimit: number;
  appliedTokenBudget: number;
  hoursAgo: number;
}

/**
 * 应用完整时间衰减策略：消息限制 → 工具结果过滤 → Token 截断。
 */
export function applyTimeDecayStrategy(
  messages: RawMessage[],
  lastActivityMs: number | undefined,
  hasCachedCompression?: boolean,
): { messages: RawMessage[]; stats: TimeDecayStats } {
  const originalCount = messages.length;
  const hoursAgo = lastActivityMs ? (Date.now() - lastActivityMs) / (3600 * 1000) : 0;
  const limits = calculateHistoryLimits(lastActivityMs, hasCachedCompression);

  let processed: RawMessage[];

  if (hasCachedCompression) {
    // Skip L1 (message count limit) and L3 (token budget truncation) —
    // the cached compression state already handled the heavy lifting.
    // Only run L2 (filter large tool results).
    processed = messages;
  } else {
    // Layer 1: message count limit
    processed = messages.slice(-limits.messageLimit);
  }

  // 第二层：过滤大型工具结果
  processed = filterLargeToolResults(processed);
  const filteredCount = processed.length;

  // 第三层：Token 预算截断（有缓存压缩时跳过）
  if (!hasCachedCompression) {
    processed = truncateByTokenBudget(processed, limits.tokenBudget);
  }
  const finalCount = processed.length;

  const estimatedTokens = processed.reduce(
    (sum, msg) => sum + estimateMessageTokens(msg.content),
    0,
  );

  return {
    messages: processed,
    stats: {
      originalCount,
      filteredCount,
      finalCount,
      estimatedTokens,
      appliedMessageLimit: limits.messageLimit,
      appliedTokenBudget: limits.tokenBudget,
      hoursAgo,
    },
  };
}
