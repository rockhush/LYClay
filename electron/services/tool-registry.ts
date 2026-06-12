/**
 * Tool Registry Service
 *
 * Manages tool schemas with layered injection strategy:
 * - Always-available tools: Core editing/navigation tools
 * - Conditional tools: Context-dependent (URLs, external info, etc.)
 * - High-cost tools: Explicit trigger required (agents, external services)
 *
 * Benefits:
 * - Reduces prompt token count
 * - Improves model tool selection accuracy
 * - Reduces first-token latency
 */

import { logger } from '../utils/logger';

export type ToolTier = 'always' | 'conditional' | 'high-cost';

export interface ToolDefinition {
  name: string;
  description: string;
  tier: ToolTier;
  schema: Record<string, unknown>;
  triggers?: string[]; // Keywords or patterns that suggest this tool
  category?: string;
}

export interface ToolRegistryState {
  tools: Map<string, ToolDefinition>;
  enabledTools: Set<string>;
  lastRebuiltAt: number;
}

const registry: ToolRegistryState = {
  tools: new Map(),
  enabledTools: new Set(),
  lastRebuiltAt: 0,
};

// Default tool definitions organized by tier
const DEFAULT_TOOLS: ToolDefinition[] = [
  // ========== ALWAYS-AVAILABLE TOOLS ==========
  // Core editing and navigation tools that are always useful
  {
    name: 'Read',
    description: 'Read file contents',
    tier: 'always',
    category: 'file',
    schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file' },
        offset: { type: 'number', description: 'Line number to start reading from' },
        limit: { type: 'number', description: 'Maximum number of lines to read' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Edit',
    description: 'Make edits to a file',
    tier: 'always',
    category: 'file',
    schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file' },
        old_string: { type: 'string', description: 'Text to replace' },
        new_string: { type: 'string', description: 'Replacement text' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Write',
    description: 'Write content to a file',
    tier: 'always',
    category: 'file',
    schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'Glob',
    description: 'Find files by pattern',
    tier: 'always',
    category: 'search',
    schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern' },
        path: { type: 'string', description: 'Directory to search in' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Grep',
    description: 'Search for patterns in files',
    tier: 'always',
    category: 'search',
    schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression pattern' },
        path: { type: 'string', description: 'File or directory to search in' },
        glob: { type: 'string', description: 'Glob pattern to filter files' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Bash',
    description: 'Execute shell commands',
    tier: 'always',
    category: 'shell',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to execute' },
        description: { type: 'string', description: 'What this command does' },
      },
      required: ['command', 'description'],
    },
  },
  {
    name: 'TodoWrite',
    description: 'Track tasks and progress',
    tier: 'always',
    category: 'planning',
    schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
          },
        },
      },
      required: ['todos'],
    },
  },

  // ========== CONDITIONAL TOOLS ==========
  // Enabled based on context (URLs, external info needs, etc.)
  {
    name: 'WebFetch',
    description: 'Fetch content from a URL',
    tier: 'conditional',
    category: 'web',
    triggers: ['url', 'http', 'website', 'link', 'fetch'],
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
        prompt: { type: 'string', description: 'What to extract from the page' },
      },
      required: ['url', 'prompt'],
    },
  },
  {
    name: 'WebSearch',
    description: 'Search the web for information',
    tier: 'conditional',
    category: 'web',
    triggers: ['search', 'find', 'latest', 'current', 'news', 'docs'],
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'NotebookEdit',
    description: 'Edit Jupyter notebook cells',
    tier: 'conditional',
    category: 'notebook',
    triggers: ['notebook', 'jupyter', '.ipynb'],
    schema: {
      type: 'object',
      properties: {
        notebook_path: { type: 'string', description: 'Path to notebook' },
        cell_id: { type: 'string', description: 'Cell ID to edit' },
        new_source: { type: 'string', description: 'New cell content' },
      },
      required: ['notebook_path', 'cell_id', 'new_source'],
    },
  },

  // ========== HIGH-COST TOOLS ==========
  // Only enabled on explicit trigger
  {
    name: 'Agent',
    description: 'Spawn a subagent for complex tasks',
    tier: 'high-cost',
    category: 'agent',
    triggers: ['delegate', 'subagent', 'specialist'],
    schema: {
      type: 'object',
      properties: {
        subagent_type: { type: 'string', description: 'Type of agent to spawn' },
        prompt: { type: 'string', description: 'Task for the subagent' },
      },
      required: ['subagent_type', 'prompt'],
    },
  },
  {
    name: 'Task',
    description: 'Launch background tasks',
    tier: 'high-cost',
    category: 'agent',
    triggers: ['background', 'async', 'parallel'],
    schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task identifier' },
        command: { type: 'string', description: 'Command to run' },
      },
      required: ['task_id', 'command'],
    },
  },
];

/**
 * Initialize the tool registry with default tools
 */
export function initializeToolRegistry(): void {
  registry.tools.clear();
  registry.enabledTools.clear();

  for (const tool of DEFAULT_TOOLS) {
    registry.tools.set(tool.name, tool);
    // Enable always-available tools by default
    if (tool.tier === 'always') {
      registry.enabledTools.add(tool.name);
    }
  }

  registry.lastRebuiltAt = Date.now();
  logger.info(`[tool-registry] Initialized with ${registry.tools.size} tools`);
}

/**
 * Enable a specific tool
 */
export function enableTool(toolName: string): boolean {
  const tool = registry.tools.get(toolName);
  if (!tool) {
    logger.warn(`[tool-registry] Unknown tool: ${toolName}`);
    return false;
  }

  registry.enabledTools.add(toolName);
  logger.info(`[tool-registry] Enabled tool: ${toolName}`);
  return true;
}

/**
 * Disable a specific tool
 */
export function disableTool(toolName: string): boolean {
  const tool = registry.tools.get(toolName);
  if (!tool) {
    logger.warn(`[tool-registry] Unknown tool: ${toolName}`);
    return false;
  }

  // Cannot disable always-available tools
  if (tool.tier === 'always') {
    logger.warn(`[tool-registry] Cannot disable core tool: ${toolName}`);
    return false;
  }

  registry.enabledTools.delete(toolName);
  logger.info(`[tool-registry] Disabled tool: ${toolName}`);
  return true;
}

/**
 * Get all enabled tools as JSON schema for prompt injection
 */
export function getEnabledToolsSchema(): Array<{ name: string; description: string; schema: Record<string, unknown> }> {
  const tools: Array<{ name: string; description: string; schema: Record<string, unknown> }> = [];

  for (const toolName of registry.enabledTools) {
    const tool = registry.tools.get(toolName);
    if (tool) {
      tools.push({
        name: tool.name,
        description: tool.description,
        schema: tool.schema,
      });
    }
  }

  return tools;
}

/**
 * Check if a message suggests enabling certain conditional tools
 */
export function suggestToolsForMessage(message: string): string[] {
  const normalizedMessage = message.toLowerCase();
  const suggestions: string[] = [];

  // Check for URL patterns
  const urlPattern = /https?:\/\/[^\s]+/i;
  if (urlPattern.test(message)) {
    suggestions.push('WebFetch');
  }

  // Check for notebook references
  if (normalizedMessage.includes('.ipynb') || normalizedMessage.includes('notebook') || normalizedMessage.includes('jupyter')) {
    suggestions.push('NotebookEdit');
  }

  // Check for search/information queries
  const searchKeywords = ['latest', 'current', 'news', 'recent', 'find', 'search', 'look up'];
  if (searchKeywords.some((kw) => normalizedMessage.includes(kw))) {
    suggestions.push('WebSearch');
  }

  // Check for tool triggers
  for (const [toolName, tool] of registry.tools.entries()) {
    if (tool.tier === 'conditional' && tool.triggers) {
      for (const trigger of tool.triggers) {
        if (normalizedMessage.includes(trigger.toLowerCase())) {
          suggestions.push(toolName);
          break;
        }
      }
    }
  }

  return suggestions;
}

/**
 * Auto-enable tools based on message content
 */
export function autoEnableToolsForMessage(message: string): string[] {
  const suggestions = suggestToolsForMessage(message);
  const newlyEnabled: string[] = [];

  for (const toolName of suggestions) {
    const tool = registry.tools.get(toolName);
    if (tool && !registry.enabledTools.has(toolName)) {
      enableTool(toolName);
      newlyEnabled.push(toolName);
      logger.info(`[tool-registry] Auto-enabled ${toolName} for message`);
    }
  }

  return newlyEnabled;
}

/**
 * Enable tools by tier
 */
export function enableToolsByTier(tier: ToolTier): string[] {
  const enabled: string[] = [];
  for (const [toolName, tool] of registry.tools.entries()) {
    if (tool.tier === tier && !registry.enabledTools.has(toolName)) {
      enableTool(toolName);
      enabled.push(toolName);
    }
  }
  return enabled;
}

/**
 * Disable tools by tier (except 'always' tier)
 */
export function disableToolsByTier(tier: ToolTier): string[] {
  if (tier === 'always') {
    logger.warn('[tool-registry] Cannot disable always-available tools');
    return [];
  }

  const disabled: string[] = [];
  for (const toolName of registry.enabledTools) {
    const tool = registry.tools.get(toolName);
    if (tool?.tier === tier) {
      disableTool(toolName);
      disabled.push(toolName);
    }
  }
  return disabled;
}

/**
 * Reset to default tool set
 */
export function resetTools(): void {
  initializeToolRegistry();
  logger.info('[tool-registry] Reset to defaults');
}

/**
 * Get registry diagnostics
 */
export function getRegistryDiagnostics(): {
  totalTools: number;
  enabledTools: number;
  toolsByTier: Record<ToolTier, number>;
  enabledToolNames: string[];
} {
  const toolsByTier: Record<ToolTier, number> = { 'always': 0, 'conditional': 0, 'high-cost': 0 };

  for (const tool of registry.tools.values()) {
    toolsByTier[tool.tier]++;
  }

  return {
    totalTools: registry.tools.size,
    enabledTools: registry.enabledTools.size,
    toolsByTier,
    enabledToolNames: Array.from(registry.enabledTools),
  };
}

// Initialize on module load
initializeToolRegistry();
