export const DEFAULT_OPENCLAW_DM_SCOPE = 'per-account-channel-peer';
export const DEFAULT_OPENCLAW_AGENT_MAX_CONCURRENT = 30;
export const DEFAULT_OPENCLAW_AGENT_CONTEXT_TOKENS = 200000;

const LEGACY_OPENCLAW_AGENT_CONTEXT_TOKENS = 128000;
const LEGACY_OPENCLAW_COMPACTION_RESERVE_TOKENS_FLOOR = 8192;
const LEGACY_OPENCLAW_COMPACTION_KEEP_RECENT_TOKENS = 40000;
const PREVIOUS_OPENCLAW_COMPACTION_KEEP_RECENT_TOKENS = 50000;
const LEGACY_OPENCLAW_MEMORY_FLUSH_SOFT_THRESHOLD_TOKENS = 8000;
const PREVIOUS_OPENCLAW_MEMORY_FLUSH_SOFT_THRESHOLD_TOKENS = 24000;
const PREVIOUS_OPENCLAW_MEMORY_FLUSH_TRANSCRIPT_BYTES = '8mb';

export const DEFAULT_OPENCLAW_COMPACTION_CONFIG: Record<string, unknown> = {
  mode: 'default',
  reserveTokensFloor: 32000,
  keepRecentTokens: 20000,
  timeoutSeconds: 900,
  notifyUser: true,
  // midTurnPrecheck 默认必须关闭：当其为 true 时，OpenClaw 会在每次工具
  // 返回结果后用粗略 char-based 估算预先判断"可能溢出"并立即抛出
  // `Context overflow: prompt too large for the model (mid-turn precheck).`
  // 这会在自动压缩（memoryFlush + default 模式）有机会介入前就让请求失败，
  // 表现就是"明明没满 128K 就报 overflow"。OpenClaw 官方默认即为 false，
  // 这里显式写出以防被旧配置或上游误开启。
  midTurnPrecheck: {
    enabled: false,
  },
  // 禁止压缩后物理删除 jsonl 文件中的历史消息。
  // true 会导致 OpenClaw 在压缩后把 firstKeptEntryId 之前的消息从 session
  // 文件中永久删除，用户 UI 上再也看不到早期对话记录。压缩只应作用于发送
  // 给模型的上下文，不应破坏持久化的完整历史。
  truncateAfterCompaction: false,
  memoryFlush: {
    enabled: true,
    softThresholdTokens: 12000,
    forceFlushTranscriptBytes: '2mb',
  },
};

export type OpenClawDmScope =
  | 'main'
  | 'per-peer'
  | 'per-channel-peer'
  | 'per-account-channel-peer';

const VALID_OPENCLAW_DM_SCOPES = new Set<OpenClawDmScope>([
  'main',
  'per-peer',
  'per-channel-peer',
  'per-account-channel-peer',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveAgentDefaultModelRef(defaults: Record<string, unknown>): string | undefined {
  const model = defaults.model;
  if (typeof model === 'string') {
    return model;
  }
  if (isRecord(model) && typeof model.primary === 'string') {
    return model.primary;
  }
  return undefined;
}

function isLyAutoDefaultModel(defaults: Record<string, unknown>): boolean {
  return resolveAgentDefaultModelRef(defaults) === 'ly-auto/auto';
}

export function ensureOpenClawSessionDefaults(config: Record<string, unknown>): boolean {
  const previousSession = config.session;
  const session = isRecord(previousSession) ? previousSession : {};
  const previousDmScope = session.dmScope;

  if (typeof previousDmScope === 'string' && VALID_OPENCLAW_DM_SCOPES.has(previousDmScope as OpenClawDmScope)) {
    return false;
  }

  session.dmScope = DEFAULT_OPENCLAW_DM_SCOPE;
  config.session = session;

  return !isRecord(previousSession) || previousDmScope !== DEFAULT_OPENCLAW_DM_SCOPE;
}

export function ensureOpenClawAgentDefaults(config: Record<string, unknown>): boolean {
  const previousAgents = config.agents;
  const agents = isRecord(previousAgents) ? previousAgents : {};
  const previousDefaults = agents.defaults;
  const defaults = isRecord(previousDefaults) ? previousDefaults : {};
  const previousMaxConcurrent = defaults.maxConcurrent;

  let changed = false;

  if (previousMaxConcurrent !== DEFAULT_OPENCLAW_AGENT_MAX_CONCURRENT) {
    defaults.maxConcurrent = DEFAULT_OPENCLAW_AGENT_MAX_CONCURRENT;
    changed = true;
  }

  const hasLyAutoDefaultModel = isLyAutoDefaultModel(defaults);
  if (hasLyAutoDefaultModel && (typeof defaults.contextTokens !== 'number'
    || defaults.contextTokens <= 0
    || defaults.contextTokens === LEGACY_OPENCLAW_AGENT_CONTEXT_TOKENS)) {
    defaults.contextTokens = DEFAULT_OPENCLAW_AGENT_CONTEXT_TOKENS;
    changed = true;
  } else if (!hasLyAutoDefaultModel
    && (defaults.contextTokens === LEGACY_OPENCLAW_AGENT_CONTEXT_TOKENS
      || defaults.contextTokens === DEFAULT_OPENCLAW_AGENT_CONTEXT_TOKENS)) {
    delete defaults.contextTokens;
    changed = true;
  }

  // Ensure compaction defaults are applied, fixing any broken legacy config
  const previousCompaction = defaults.compaction;
  const compaction = isRecord(previousCompaction) ? { ...previousCompaction } : {};

  let compactionChanged = false;

  // Fix: "safeguard" mode requires an external compaction provider. If no
  // provider is configured, force back to "default" so Pi's built-in auto-
  // compaction takes over. Also fill in missing fields with safe defaults.
  if (compaction.mode !== 'default') {
    compaction.mode = 'default';
    compactionChanged = true;
  }

  if (!compaction.notifyUser) {
    compaction.notifyUser = true;
    compactionChanged = true;
  }

  if (typeof compaction.reserveTokensFloor !== 'number'
    || compaction.reserveTokensFloor <= 0
    || compaction.reserveTokensFloor === LEGACY_OPENCLAW_COMPACTION_RESERVE_TOKENS_FLOOR) {
    compaction.reserveTokensFloor = DEFAULT_OPENCLAW_COMPACTION_CONFIG.reserveTokensFloor;
    compactionChanged = true;
  }

  if (typeof compaction.keepRecentTokens !== 'number'
    || compaction.keepRecentTokens <= 0
    || compaction.keepRecentTokens === LEGACY_OPENCLAW_COMPACTION_KEEP_RECENT_TOKENS
    || compaction.keepRecentTokens === PREVIOUS_OPENCLAW_COMPACTION_KEEP_RECENT_TOKENS) {
    compaction.keepRecentTokens = DEFAULT_OPENCLAW_COMPACTION_CONFIG.keepRecentTokens;
    compactionChanged = true;
  }

  if (typeof compaction.timeoutSeconds !== 'number' || compaction.timeoutSeconds <= 0) {
    compaction.timeoutSeconds = DEFAULT_OPENCLAW_COMPACTION_CONFIG.timeoutSeconds;
    compactionChanged = true;
  }

  const previousMemoryFlush = compaction.memoryFlush;
  const memoryFlush = isRecord(previousMemoryFlush) ? { ...previousMemoryFlush } : {};
  const defaultMemoryFlush = DEFAULT_OPENCLAW_COMPACTION_CONFIG.memoryFlush as Record<string, unknown>;
  let memoryFlushChanged = !isRecord(previousMemoryFlush);

  if (memoryFlush.enabled !== true) {
    memoryFlush.enabled = true;
    memoryFlushChanged = true;
  }

  if (typeof memoryFlush.softThresholdTokens !== 'number'
    || memoryFlush.softThresholdTokens < 0
    || memoryFlush.softThresholdTokens === LEGACY_OPENCLAW_MEMORY_FLUSH_SOFT_THRESHOLD_TOKENS
    || memoryFlush.softThresholdTokens === PREVIOUS_OPENCLAW_MEMORY_FLUSH_SOFT_THRESHOLD_TOKENS) {
    memoryFlush.softThresholdTokens = defaultMemoryFlush.softThresholdTokens;
    memoryFlushChanged = true;
  }

  if ((typeof memoryFlush.forceFlushTranscriptBytes !== 'string'
    && typeof memoryFlush.forceFlushTranscriptBytes !== 'number')
    || memoryFlush.forceFlushTranscriptBytes === PREVIOUS_OPENCLAW_MEMORY_FLUSH_TRANSCRIPT_BYTES) {
    memoryFlush.forceFlushTranscriptBytes = defaultMemoryFlush.forceFlushTranscriptBytes;
    memoryFlushChanged = true;
  }

  if (memoryFlushChanged) {
    compaction.memoryFlush = memoryFlush;
    compactionChanged = true;
  }

  // Fix: midTurnPrecheck.enabled=true 会在工具返回后用粗略估算预先判定上下文
  // 溢出并直接抛出错误，阻止 default 模式 + memoryFlush 的自动压缩流程介入。
  // 强制关闭，避免出现"未到 128K 就报 Context overflow"的误判。
  const previousMidTurnPrecheck = compaction.midTurnPrecheck;
  const midTurnPrecheck = isRecord(previousMidTurnPrecheck) ? { ...previousMidTurnPrecheck } : {};
  if (midTurnPrecheck.enabled !== false) {
    midTurnPrecheck.enabled = false;
    compaction.midTurnPrecheck = midTurnPrecheck;
    compactionChanged = true;
  } else if (!isRecord(previousMidTurnPrecheck)) {
    compaction.midTurnPrecheck = midTurnPrecheck;
    compactionChanged = true;
  }

  // Fix: truncateAfterCompaction=true 会导致 OpenClaw 压缩后物理删除
  // session jsonl 文件中 firstKeptEntryId 之前的消息，用户 UI 上永远
  // 看不到早期对话。压缩只应作用于发送给模型的上下文，不应破坏持久化历史。
  if (compaction.truncateAfterCompaction !== false) {
    compaction.truncateAfterCompaction = false;
    compactionChanged = true;
  }

  if (compactionChanged) {
    defaults.compaction = compaction;
    changed = true;
  }

  agents.defaults = defaults;
  config.agents = agents;

  return changed || !isRecord(previousAgents);
}
