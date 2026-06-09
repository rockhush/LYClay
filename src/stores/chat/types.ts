/** Metadata for locally-attached files (not from Gateway) */
export interface AttachedFileMeta {
  fileName: string;
  mimeType: string;
  fileSize: number;
  preview: string | null;
  filePath?: string;
  source?: 'user-upload' | 'tool-result' | 'message-ref';
}

/** Raw message from OpenClaw chat.history */
export interface RawMessage {
  role: 'user' | 'assistant' | 'system' | 'toolresult';
  content: unknown; // string | ContentBlock[]
  timestamp?: number;
  id?: string;
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
  /** Local-only: file metadata for user-uploaded attachments (not sent to/from Gateway) */
  _attachedFiles?: AttachedFileMeta[];
}

/** Content block inside a message */
export interface ContentBlock {
  type: 'text' | 'image' | 'thinking' | 'tool_use' | 'tool_result' | 'toolCall' | 'toolResult';
  text?: string;
  thinking?: string;
  source?: { type: string; media_type?: string; data?: string; url?: string };
  /** Flat image format from Gateway tool results (no source wrapper) */
  data?: string;
  mimeType?: string;
  id?: string;
  name?: string;
  input?: unknown;
  arguments?: unknown;
  content?: unknown;
}

/** Session from sessions.list */
export interface ChatSession {
  key: string;
  label?: string;
  firstUserMessagePreview?: string;
  displayName?: string;
  thinkingLevel?: string;
  model?: string;
  updatedAt?: number;
}

export type ReasoningMode = 'fast' | 'thinking' | 'expert';

export interface ToolStatus {
  id?: string;
  toolCallId?: string;
  name: string;
  status: 'running' | 'completed' | 'error';
  durationMs?: number;
  summary?: string;
  updatedAt: number;
}

/** Streaming state per session - preserved when switching between sessions */
export interface SessionStreamingState {
  activeRunId: string | null;
  streamingText: string;
  streamingMessage: unknown | null;
  streamingTools: ToolStatus[];
  pendingFinal: boolean;
  lastUserMessageAt: number | null;
  pendingToolImages: AttachedFileMeta[];
  runAborted: boolean;
  sending: boolean;
  runError: string | null;
  /** Messages snapshot for recovery when switching back during active streaming */
  messagesSnapshot: RawMessage[];
}

/** Compression state persisted per session */
export interface CompressionStateEntry {
  /** The generated summary text */
  summaryText: string;
  /** Number of messages that were compressed (the older ones sent for summarization) */
  compressedCount: number;
  /** Total message count at the time of compression */
  totalMessagesAtCompression: number;
  /** Estimated tokens of the compressed messages */
  compressedTokens: number;
  /** Timestamp when compression ran */
  compressedAt: number;
  /** Whether this was a truncation fallback (not LLM summarization) */
  isTruncation: boolean;
}

export interface ChatState {
  // Messages
  messages: RawMessage[];
  loading: boolean;
  error: string | null;
  runError: string | null;

  // Pre-filled input text (for skill creation, etc.)
  prefilledInput: string | null;

  // Streaming
  sending: boolean;
  aborting: boolean;
  activeRunId: string | null;
  streamingText: string;
  streamingMessage: unknown | null;
  streamingTools: ToolStatus[];
  pendingFinal: boolean;
  lastUserMessageAt: number | null;
  /** Images collected from tool results, attached to the next assistant message */
  pendingToolImages: AttachedFileMeta[];
  /** True if this is the first message sent since app/gateway startup */
  isFirstMessageEver?: boolean;
  /** True if the current run was manually aborted by the user */
  runAborted: boolean;

  // Sessions
  sessions: ChatSession[];
  currentSessionKey: string;
  currentAgentId: string;
  /** First user message text per session key, used as display label */
  sessionLabels: Record<string, string>;
  /**
   * User-edited custom titles per session key. Persisted to localStorage so the
   * rename survives session switches and app restarts. When present, this value
   * takes precedence over `sessionLabels` / discovered previews in the UI.
   */
  customSessionLabels: Record<string, string>;
  /** Last message timestamp (ms) per session key, used for sorting */
  sessionLastActivity: Record<string, number>;
  /** Workspace entry id per session key (sidebar: nest history under that folder) */
  sessionWorkspaceIds: Record<string, string>;
  /** Pin timestamp per session key; newer timestamps sort first in sidebar */
  sessionPinnedAt: Record<string, number>;
  /** Streaming state per session, preserved when switching sessions */
  sessionStreamingStates: Record<string, SessionStreamingState>;
  /** Compression state per session, persisted to disk and restored on reload/switch */
  sessionCompressionState: Record<string, CompressionStateEntry | null>;

  // Thinking
  thinkingLevel: string | null;
  reasoningMode: ReasoningMode;

  // Actions
  loadSessions: (force?: boolean) => Promise<void>;
  switchSession: (key: string) => void;
  newSession: () => void;
  /** Set pre-filled input text for the chat input box */
  setPrefilledInput: (text: string | null) => void;
  /** Associate the active chat session with a workspace id (or clear). */
  bindCurrentSessionWorkspace: (workspaceId: string | null) => void;
  /** Unlink a session from its workspace (session remains in history buckets). */
  unbindSessionWorkspace: (sessionKey: string) => void;
  /** Toggle a session between pinned and normal sidebar ordering. */
  toggleSessionPinned: (sessionKey: string) => void;
  /** Remove all session bindings pointing at the given workspace id. */
  clearSessionWorkspaceBindings: (workspaceId: string) => void;
  deleteSession: (key: string) => Promise<void>;
  /**
   * Rename a chat session. Stores the new title under `customSessionLabels`
   * and persists it to localStorage so it survives reloads/restarts.
   * An empty/whitespace-only label clears the custom title (reverts to default).
   */
  renameSession: (key: string, newLabel: string) => Promise<void>;
  cleanupEmptySession: () => void;
  loadHistory: (
    quiet?: boolean,
    opts?: { afterAwaitRetry?: boolean; force?: boolean },
  ) => Promise<void>;
  sendMessage: (
    text: string,
    attachments?: Array<{
      fileName: string;
      mimeType: string;
      fileSize: number;
      stagedPath: string;
      preview: string | null;
    }>,
    targetAgentId?: string | null,
  ) => Promise<void>;
  abortRun: () => Promise<void>;
  setReasoningMode: (mode: ReasoningMode) => Promise<void>;
  setCurrentSessionModel: (model: string | null) => Promise<void>;
  handleChatEvent: (event: Record<string, unknown>) => void;
  refresh: () => Promise<void>;
  clearError: () => void;
}

export const DEFAULT_CANONICAL_PREFIX = 'agent:main';
export const DEFAULT_SESSION_KEY = `${DEFAULT_CANONICAL_PREFIX}:main`;
