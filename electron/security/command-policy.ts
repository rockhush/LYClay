import path from 'node:path';
import { evaluatePathPolicy } from './path-policy';
import type {
  CommandPolicyRequest,
  CommandPolicyResult,
  CommandSegmentDecision,
  FileCapability,
  SecurityDecision,
  SecurityRisk,
} from './types';

function allow(reasons: string[], risk: SecurityRisk = 'low'): SecurityDecision {
  return { action: 'allow', risk, reasons };
}

function prompt(reasons: string[], risk: SecurityRisk = 'medium', promptLevel: 'normal' | 'high' = 'normal'): SecurityDecision {
  return { action: 'prompt', risk, reasons, promptLevel, allowRememberChoice: true };
}

function deny(code: string, reasons: string[], risk: SecurityRisk = 'high'): SecurityDecision {
  return { action: 'deny', risk, reasons, code };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function commandToString(request: CommandPolicyRequest): string {
  if (request.command?.trim()) return request.command.trim();
  const executable = request.executable?.trim();
  if (!executable) return '';
  return [executable, ...(request.args ?? [])].map(shellQuote).join(' ');
}

export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | '`' | null = null;
  let depth = 0;

  const push = () => {
    const trimmed = current.trim();
    if (trimmed) segments.push(trimmed);
    current = '';
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    const next = command[i + 1] ?? '';

    if (quote) {
      current += char;
      if (char === quote && command[i - 1] !== '\\') quote = null;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      current += char;
      continue;
    }

    if (char === '(') {
      if (depth === 0) push();
      depth += 1;
      current += char;
      continue;
    }
    if (char === ')') {
      current += char;
      depth = Math.max(0, depth - 1);
      if (depth === 0) push();
      continue;
    }

    if (depth === 0) {
      if ((char === '&' && next === '&') || (char === '|' && next === '|') || (char === '>' && next === '>')) {
        push();
        i += 1;
        continue;
      }
      if (char === '|' || char === ';' || char === '>' || char === '<') {
        push();
        continue;
      }
    }

    current += char;
  }

  push();
  return segments;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|`([^`]*)`|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(segment)) !== null) {
    tokens.push(stripQuotes(match[1] ?? match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return tokens;
}

function isNullDeviceRedirectionTarget(target: string): boolean {
  const normalized = stripQuotes(target).trim().replace(/\\/g, '/').toLowerCase();
  return normalized === 'nul'
    || normalized === 'nul:'
    || normalized === '$null'
    || normalized === '/dev/null';
}

function isShellControlChar(char: string): boolean {
  return char === ';' || char === '&' || char === '|' || char === '\n' || char === '\r';
}

function isCommandBoundary(char: string | undefined): boolean {
  return !char || /\s/.test(char) || isShellControlChar(char) || char === '(' || char === ')';
}

function redirectOperatorAt(command: string, index: number): { capability: FileCapability; length: number } | null {
  const char = command[index];
  if (char !== '>' && char !== '<') return null;

  const capability: FileCapability = char === '<' ? 'read' : 'write';
  const length = char === '>' && command[index + 1] === '>' ? 2 : 1;
  const previous = command[index - 1];
  if (isCommandBoundary(previous)) return { capability, length };

  if (previous === '*') {
    return isCommandBoundary(command[index - 2]) ? { capability, length } : null;
  }

  if (/\d/.test(previous ?? '')) {
    let cursor = index - 1;
    while (cursor >= 0 && /\d/.test(command[cursor] ?? '')) cursor -= 1;
    return isCommandBoundary(command[cursor]) ? { capability, length } : null;
  }

  return null;
}

function readRedirectTarget(command: string, start: number): { target?: string; nextIndex: number } {
  let index = start;
  while (index < command.length && /\s/.test(command[index] ?? '')) index += 1;
  if (index >= command.length) return { nextIndex: index };

  const quote = command[index];
  if (quote === '"' || quote === "'") {
    let target = quote;
    index += 1;
    for (; index < command.length; index += 1) {
      const char = command[index]!;
      target += char;
      if (char === quote && command[index - 1] !== '\\' && command[index - 1] !== '`') {
        index += 1;
        break;
      }
    }
    return { target, nextIndex: index };
  }

  let target = '';
  for (; index < command.length; index += 1) {
    const char = command[index]!;
    if (/\s/.test(char) || isShellControlChar(char)) break;
    target += char;
  }
  return { target, nextIndex: index };
}

function basenameLower(token: string): string {
  const cleaned = stripQuotes(token).replace(/\\/g, '/');
  return cleaned.slice(cleaned.lastIndexOf('/') + 1).toLowerCase();
}

function isEscapedAt(text: string, index: number): boolean {
  let backslashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}

function findSubexpressionBodies(text: string): string[] {
  const bodies: string[] = [];
  for (let i = 0; i < text.length - 1; i += 1) {
    if (text[i] !== '$' || text[i + 1] !== '(' || isEscapedAt(text, i)) continue;
    let depth = 1;
    let quote: '"' | "'" | '`' | null = null;
    let body = '';
    i += 2;
    for (; i < text.length; i += 1) {
      const char = text[i]!;
      if (quote) {
        body += char;
        if (char === quote && text[i - 1] !== '\\') quote = null;
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        quote = char;
        body += char;
        continue;
      }
      if (char === '(') {
        depth += 1;
        body += char;
        continue;
      }
      if (char === ')') {
        depth -= 1;
        if (depth === 0) break;
        body += char;
        continue;
      }
      body += char;
    }
    if (depth === 0) bodies.push(body);
  }
  return bodies;
}

function isSimplePowerShellVariableExpression(body: string): boolean {
  return /^\s*\$[\w?]+(?:\.[A-Za-z_][\w]*|\[[^\]\r\n;|&<>]+\])*\s*$/.test(body)
    || /^\s*\$_(?:\.[A-Za-z_][\w]*|\[[^\]\r\n;|&<>]+\])*\s*$/.test(body);
}

function stripPowerShellEscapedCharacters(text: string): string {
  return text.replace(/`["'`$]/g, '');
}

function hasRiskyCommandSubstitution(text: string): boolean {
  if (/`[^`]+`/.test(stripPowerShellEscapedCharacters(text))) return true;
  return findSubexpressionBodies(text).some((body) => !isSimplePowerShellVariableExpression(body));
}

function classifySegment(segment: string): CommandSegmentDecision {
  const lower = segment.toLowerCase();
  const tokens = tokenize(segment);
  const exe = tokens[0] ? basenameLower(tokens[0]) : '';
  const reasons: string[] = [];
  const matchedRules: string[] = [];
  let action: SecurityDecision['action'] = 'allow';
  let risk: SecurityRisk = 'low';
  let code: string | undefined;

  const setDeny = (nextCode: string, reason: string, nextRisk: SecurityRisk = 'critical', rule = nextCode) => {
    action = 'deny';
    risk = nextRisk;
    code = nextCode;
    reasons.push(reason);
    matchedRules.push(rule);
  };
  const setPrompt = (reason: string, nextRisk: SecurityRisk = 'medium', rule = 'requires-confirmation') => {
    if (action === 'deny') return;
    action = 'prompt';
    risk = nextRisk;
    reasons.push(reason);
    matchedRules.push(rule);
  };

  if (!segment.trim()) {
    setDeny('EMPTY_COMMAND', 'Command must be a non-empty string', 'high');
    return { segment, action, risk, reasons, matchedRules, code };
  }

  if (hasRiskyCommandSubstitution(lower)) {
    setPrompt('Command substitution requires confirmation', 'high', 'command-substitution');
  }

  if (/\bexecutionpolicy\s+bypass\b/i.test(segment) || /\b(encodedcommand|enc)\b/i.test(segment)) {
    setDeny('POWERSHELL_POLICY_BYPASS', 'PowerShell policy bypass or encoded command is blocked', 'critical', 'powershell-policy-bypass');
  }

  if (/\b(rm|remove-item)\b[\s\S]*\b(-rf|-fr|-recurse)\b[\s\S]*(?:^|\s|["'])(\/|[a-z]:\\?)(?:\s|["']|$)/i.test(segment)
    || ((exe === 'rm' || exe === 'remove-item')
      && tokens.some((token) => /^-(?:[a-z]*r[a-z]*f?|recurse)$/i.test(token))
      && tokens.some((token) => token === '/' || /^[A-Za-z]:\\?$/.test(token)))) {
    setDeny('DESTRUCTIVE_ROOT_DELETE', 'Deleting a filesystem root is blocked', 'critical', 'destructive-root-delete');
  }

  if (/\bchmod\b[\s\S]*\b-r\b[\s\S]*\b777\b[\s\S]*(?:^|\s|["'])\/(?:\s|["']|$)/i.test(segment)) {
    setDeny('DANGEROUS_ROOT_CHMOD', 'Recursive chmod 777 on the filesystem root is blocked', 'critical', 'dangerous-root-chmod');
  }

  if (action !== 'deny') {
    if ((exe === 'rm' && tokens.some((token) => /^-[a-z]*r[a-z]*f?[a-z]*$/i.test(token)))
      || (exe === 'remove-item' && tokens.some((token) => /^-(recurse|r)$/i.test(token)))
      || (exe === 'del' && tokens.some((token) => /^\/s$/i.test(token)))) {
      setPrompt('Recursive delete requires confirmation', 'high', 'recursive-delete');
    }

    if (exe === 'sudo' || exe === 'su' || exe === 'runas' || exe === 'chmod' || exe === 'chown' || exe === 'icacls') {
      setPrompt('Privilege or permission changes require confirmation', 'high', 'privilege-or-permission-change');
    }

    if (tokens.some((token) => /^(clawhub|clawhub\.cmd|clawdhub\.js|lyclaw-marketplace|lyclaw-marketplace-cli\.mjs)$/i.test(basenameLower(token)))
      && tokens.some((token) => ['install', 'uninstall', 'remove', 'update', 'upgrade'].includes(token.toLowerCase()))) {
      setPrompt('Skill marketplace changes may install or remove executable local content', 'medium', 'skill-marketplace-change');
    }

    if ((exe === 'npx' || exe === 'pnpx' || exe === 'dlx')
      || ((exe === 'pnpm' || exe === 'yarn') && tokens.some((token) => token.toLowerCase() === 'dlx'))) {
      setPrompt('Package runner commands download and execute remote code', 'high', 'package-runner');
    }

    if (tokens.some((token) => /^(set-executionpolicy|reg|sc|schtasks)$/i.test(token))) {
      setPrompt('System configuration command requires confirmation', 'high', 'system-configuration');
    }

    if (tokens.some((token) => /^--?fix$/i.test(token))) {
      setPrompt('Repair commands require explicit user confirmation', 'medium', 'repair-command');
    }

    if (reasons.length === 0) {
      reasons.push('Command is read-only or low-risk by policy');
      matchedRules.push('low-risk-default');
    }
  }

  return { segment, action, risk, reasons, matchedRules, code };
}

function classifyWholeCommand(command: string): CommandSegmentDecision[] {
  const segments: CommandSegmentDecision[] = [];
  if (/\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[\s\S]*\|[\s\S]*\b(sh|bash|zsh|pwsh|powershell|iex|invoke-expression)\b/i.test(command)) {
    segments.push({
      segment: command,
      action: 'deny',
      risk: 'critical',
      reasons: ['Downloading a remote script and executing it is blocked'],
      matchedRules: ['remote-script-pipe'],
      code: 'REMOTE_SCRIPT_PIPE',
    });
  }
  if (/\b(iwr|irm|invoke-webrequest|invoke-restmethod)\b[\s\S]*\|[\s\S]*\b(iex|invoke-expression)\b/i.test(command)) {
    segments.push({
      segment: command,
      action: 'deny',
      risk: 'critical',
      reasons: ['PowerShell download-and-execute is blocked'],
      matchedRules: ['powershell-remote-execution'],
      code: 'POWERSHELL_REMOTE_EXECUTION',
    });
  }
  return segments;
}

function mergeRisk(a: SecurityRisk, b: SecurityRisk): SecurityRisk {
  const order: SecurityRisk[] = ['low', 'medium', 'high', 'critical'];
  return order[Math.max(order.indexOf(a), order.indexOf(b))]!;
}

function pathLikeTokens(tokens: string[]): string[] {
  return tokens
    .slice(1)
    .filter((token) => {
      if (!token || token.startsWith('-')) return false;
      if (/^\/[A-Za-z?]$/.test(token)) return false;
      return token.includes('/') || token.includes('\\') || token.startsWith('.') || /^[A-Za-z]:/.test(token);
    });
}

type CommandPathAccess = {
  path: string;
  capability: FileCapability;
  matchedRule: string;
  promptOnAllow?: boolean;
  promptReason?: string;
  promptRisk?: SecurityRisk;
};

function isShellOption(token: string): boolean {
  if (!token) return true;
  if (/^[A-Za-z]:/.test(token)) return false;
  if (token === '-' || token === '--') return true;
  if (/^--[A-Za-z]/.test(token)) return true;
  if (/^-[A-Za-z]/.test(token)) return true;
  return /^\/[A-Za-z?]$/i.test(token);
}

function commandArgumentPaths(tokens: string[]): string[] {
  return tokens.slice(1).filter((token) => token && !isShellOption(token));
}

function optionValuePaths(tokens: string[], optionNames: string[]): string[] {
  const names = new Set(optionNames.map((name) => name.toLowerCase()));
  const paths: string[] = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (!names.has(token.toLowerCase())) continue;
    const next = tokens[i + 1];
    if (next && !isShellOption(next)) paths.push(next);
  }
  return paths;
}

function firstCommandArgumentPath(tokens: string[]): string | undefined {
  return commandArgumentPaths(tokens)[0];
}

function uniqueAccesses(accesses: CommandPathAccess[]): CommandPathAccess[] {
  const seen = new Set<string>();
  return accesses.filter((access) => {
    const key = `${access.capability}:${access.path}:${access.matchedRule}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function segmentPathAccesses(segment: string): CommandPathAccess[] {
  const tokens = tokenize(segment);
  const exe = tokens[0] ? basenameLower(tokens[0]) : '';
  const accesses: CommandPathAccess[] = [];

  const readExecutables = new Set(['cat', 'type', 'get-content', 'gc', 'more']);
  const deleteExecutables = new Set(['rm', 'del', 'erase', 'remove-item', 'rmdir', 'rd']);
  const writeExecutables = new Set(['set-content', 'add-content', 'out-file', 'tee', 'tee-object']);

  if (readExecutables.has(exe)) {
    accesses.push(...pathLikeTokens(tokens).map((token) => ({
      path: token,
      capability: 'read' as const,
      matchedRule: 'command-path-read',
    })));
  }

  if (deleteExecutables.has(exe)) {
    accesses.push(...commandArgumentPaths(tokens).map((token) => ({
      path: token,
      capability: 'delete' as const,
      matchedRule: 'command-path-delete',
      promptOnAllow: true,
      promptReason: 'Deleting local files requires confirmation',
      promptRisk: 'high' as const,
    })));
  }

  if (writeExecutables.has(exe)) {
    const optionPaths = optionValuePaths(tokens, ['-path', '-literalpath', '-filepath']);
    const fallback = firstCommandArgumentPath(tokens);
    const paths = optionPaths.length > 0 ? optionPaths : fallback ? [fallback] : [];
    accesses.push(...paths.map((token) => ({
      path: token,
      capability: 'write' as const,
      matchedRule: 'command-path-write',
      promptOnAllow: true,
      promptReason: 'Writing local files from a command requires confirmation',
      promptRisk: 'medium' as const,
    })));
  }

  return uniqueAccesses(accesses);
}

function redirectionPathAccesses(command: string): CommandPathAccess[] {
  const accesses: CommandPathAccess[] = [];
  let quote: '"' | "'" | '`' | null = null;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (quote) {
      if (char === quote && command[i - 1] !== '\\' && command[i - 1] !== '`') quote = null;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    const redirect = redirectOperatorAt(command, i);
    if (!redirect) continue;

    const { target, nextIndex } = readRedirectTarget(command, i + redirect.length);
    i = Math.max(i, nextIndex - 1);
    if (
      !target
      || target.startsWith('&')
      || isNullDeviceRedirectionTarget(target)
    ) continue;
    accesses.push({
      path: target,
      capability: redirect.capability,
      matchedRule: redirect.capability === 'write' ? 'command-path-write' : 'command-path-read',
      promptOnAllow: redirect.capability === 'write',
      promptReason: redirect.capability === 'write' ? 'Writing local files from command redirection requires confirmation' : undefined,
      promptRisk: redirect.capability === 'write' ? 'medium' : undefined,
    });
  }

  return uniqueAccesses(accesses);
}

function promoteToPrompt(
  decision: CommandSegmentDecision,
  reason: string,
  risk: SecurityRisk,
  matchedRule: string,
): CommandSegmentDecision {
  if (decision.action === 'deny') return decision;
  return {
    ...decision,
    action: 'prompt',
    risk: mergeRisk(decision.risk, risk),
    reasons: [...decision.reasons, reason],
    matchedRules: [...decision.matchedRules, matchedRule],
  };
}

async function applySinglePathAccess(
  decision: CommandSegmentDecision,
  request: CommandPolicyRequest,
  access: CommandPathAccess,
): Promise<CommandSegmentDecision> {
  if (decision.action === 'deny') return decision;

  const result = await evaluatePathPolicy({
    path: access.path,
    capability: access.capability,
    source: request.source ?? 'command-policy',
    baseDir: request.cwd,
    allowedRoots: request.allowedRoots,
  });

  if (result.decision.action === 'deny') {
    // For delete/write operations on paths outside workspace that aren't sensitive,
    // promote to prompt so the user can confirm before proceeding.
    if (access.promptOnAllow && result.decision.code === 'PATH_OUTSIDE_AUTHORIZED_ROOTS') {
      return promoteToPrompt(
        decision,
        access.promptReason ?? 'File operation outside the workspace requires confirmation',
        access.promptRisk ?? 'high',
        access.matchedRule,
      );
    }

    if (access.capability === 'delete' && result.decision.code === 'DELETE_REQUIRES_CONFIRMATION') {
      return promoteToPrompt(
        decision,
        access.promptReason ?? 'Deleting local files requires confirmation',
        access.promptRisk ?? 'high',
        access.matchedRule,
      );
    }

    return {
      ...decision,
      action: 'deny',
      risk: mergeRisk(decision.risk, result.decision.risk),
      reasons: [...decision.reasons, ...result.decision.reasons],
      matchedRules: [...decision.matchedRules, access.matchedRule],
      code: result.decision.code,
    };
  }

  if (result.decision.action === 'prompt') {
    return promoteToPrompt(
      decision,
      result.decision.reasons.join('; '),
      result.decision.risk,
      access.matchedRule,
    );
  }

  if (access.promptOnAllow) {
    return promoteToPrompt(
      decision,
      access.promptReason ?? 'Command path access requires confirmation',
      access.promptRisk ?? 'medium',
      access.matchedRule,
    );
  }

  return decision;
}

async function applyPathChecks(
  decision: CommandSegmentDecision,
  request: CommandPolicyRequest,
): Promise<CommandSegmentDecision> {
  let next = decision;
  for (const access of segmentPathAccesses(decision.segment)) {
    next = await applySinglePathAccess(next, request, access);
    if (next.action === 'deny') break;
  }

  return next;
}

export async function evaluateCommandPolicy(request: CommandPolicyRequest): Promise<CommandPolicyResult> {
  const command = commandToString(request);
  if (!command) {
    return {
      command,
      cwd: request.cwd,
      segments: [],
      decision: deny('EMPTY_COMMAND', ['Command must be a non-empty string']),
    };
  }

  const preflightSegments = classifyWholeCommand(command);
  const redirectionSegments = await Promise.all(redirectionPathAccesses(command).map((access) => applySinglePathAccess({
    segment: `${access.capability} redirect ${access.path}`,
    action: 'allow',
    risk: 'low',
    reasons: ['Command redirection target is checked by path policy'],
    matchedRules: [],
  }, request, access)));
  const segments = preflightSegments.concat(redirectionSegments, await Promise.all(
    splitCommandSegments(command).map((segment) => applyPathChecks(classifySegment(segment), request)),
  ));

  if (request.cwd && !request.allowCwdOutsideWorkspace) {
    const cwdResult = await evaluatePathPolicy({
      path: request.cwd,
      capability: 'read',
      source: request.source ?? 'command-policy:cwd',
      allowedRoots: request.allowedRoots,
    });
    if (cwdResult.decision.action === 'deny') {
      segments.unshift({
        segment: `cwd ${path.normalize(request.cwd)}`,
        action: 'deny',
        risk: cwdResult.decision.risk,
        reasons: cwdResult.decision.reasons,
        matchedRules: ['cwd-path-policy'],
        code: cwdResult.decision.code,
      });
    }
  }

  const denySegment = segments.find((segment) => segment.action === 'deny');
  if (denySegment) {
    return {
      command,
      cwd: request.cwd,
      segments,
      decision: deny(denySegment.code ?? 'COMMAND_DENIED', denySegment.reasons, denySegment.risk),
    };
  }

  const promptSegments = segments.filter((segment) => segment.action === 'prompt');
  if (promptSegments.length > 0 && !request.confirmed) {
    const risk = promptSegments.reduce<SecurityRisk>((current, segment) => mergeRisk(current, segment.risk), 'medium');
    return {
      command,
      cwd: request.cwd,
      segments,
      decision: prompt(
        [...new Set(promptSegments.flatMap((segment) => segment.reasons))],
        risk,
        risk === 'high' || risk === 'critical' ? 'high' : 'normal',
      ),
    };
  }

  return {
    command,
    cwd: request.cwd,
    segments,
    decision: allow(
      request.confirmed && promptSegments.length > 0
        ? ['Allowed after user confirmation']
        : ['Command allowed by policy'],
      segments.reduce<SecurityRisk>((current, segment) => mergeRisk(current, segment.risk), 'low'),
    ),
  };
}

export async function assertCommandAllowed(request: CommandPolicyRequest): Promise<CommandPolicyResult> {
  const result = await evaluateCommandPolicy(request);
  if (result.decision.action !== 'allow') {
    const error = new Error(result.decision.reasons.join('; '));
    (error as Error & { code?: string; decision?: SecurityDecision }).code =
      result.decision.action === 'deny' ? result.decision.code : 'COMMAND_REQUIRES_CONFIRMATION';
    (error as Error & { code?: string; decision?: SecurityDecision }).decision = result.decision;
    throw error;
  }
  return result;
}
