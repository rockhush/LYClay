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

/**
 * 判断是否为「问答」消息（用户提问 / 助手回答）。
 *
 * 这类消息构成用户可见的完整对话，必须在历史还原时一五一十地保留，
 * 不能因为消息数限制或 token 预算而被截断。真正的上下文预算控制由
 * 发送前的 prepareContextBeforeSend（压缩 + 硬上限）独立负责。
 */
function isConversationalMessage(msg: RawMessage): boolean {
  const role = typeof msg.role === 'string' ? msg.role.toLowerCase() : '';
  return role === 'user' || role === 'assistant';
}

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
 * 应用消息数量限制：只裁剪非问答消息（如工具结果），
 * 用户/助手的问答消息始终完整保留。
 */
function limitMessageCount(messages: RawMessage[], messageLimit: number): RawMessage[] {
  if (messages.length <= messageLimit) return messages;

  const conversationalCount = messages.filter(isConversationalMessage).length;
  // 非问答消息可保留的额度（问答消息不占用、且永不裁剪）。
  let nonConversationalBudget = Math.max(0, messageLimit - conversationalCount);

  // 从最新往回保留非问答消息，问答消息始终保留。
  const keep = new Array<boolean>(messages.length).fill(false);
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isConversationalMessage(messages[i])) {
      keep[i] = true;
    } else if (nonConversationalBudget > 0) {
      keep[i] = true;
      nonConversationalBudget -= 1;
    }
  }

  return messages.filter((_, i) => keep[i]);
}

/**
 * 从最新消息倒序累加 token 数，直到预算上限。
 *
 * 问答消息（用户/助手）始终保留，不受 token 预算约束，确保历史能完整还原；
 * 只有非问答消息（工具结果等）在超出预算时才会被裁剪。
 */
function truncateByTokenBudget(messages: RawMessage[], tokenBudget: number): RawMessage[] {
  if (messages.length === 0) return [];

  let accumulated = 0;
  const keep = new Array<boolean>(messages.length).fill(false);

  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateMessageTokens(messages[i].content);
    if (isConversationalMessage(messages[i])) {
      // 问答消息无条件保留，仍计入累计以便后续非问答消息正确判断预算。
      keep[i] = true;
      accumulated += msgTokens;
      continue;
    }
    if (accumulated + msgTokens > tokenBudget) continue;
    accumulated += msgTokens;
    keep[i] = true;
  }

  return messages.filter((_, i) => keep[i]);
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
    // Layer 1: message count limit —— 只裁剪非问答消息，问答消息完整保留
    processed = limitMessageCount(messages, limits.messageLimit);
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
