import type {
  PromptScanRequest,
  PromptScanResult,
  PromptScanRuleMatch,
  PromptScanSource,
  SecurityDecision,
  SecurityRisk,
} from './types';

type PromptRule = {
  id: string;
  category: PromptScanRuleMatch['category'];
  risk: SecurityRisk;
  reason: string;
  patterns: RegExp[];
};

const MAX_EXCERPT_LENGTH = 160;

const SOURCE_DENY_RISKS: Record<PromptScanSource, SecurityRisk[]> = {
  skill: ['high', 'critical'],
  mcp: ['high', 'critical'],
  memory: ['critical'],
  knowledge: ['critical'],
  transcript: ['critical'],
  attachment: ['critical'],
  unknown: ['critical'],
};

const RULES: PromptRule[] = [
  {
    id: 'prompt.ignore-instructions',
    category: 'instruction-override',
    risk: 'high',
    reason: 'Text attempts to override existing system or developer instructions',
    patterns: [
      /\bignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)\b/i,
      /\bdisregard\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)\b/i,
      /忽略(之前|以上|所有|系统|开发者).{0,12}(指令|提示词|规则)/i,
      /无视(之前|以上|所有|系统|开发者).{0,12}(指令|提示词|规则)/i,
    ],
  },
  {
    id: 'prompt.policy-bypass',
    category: 'policy-bypass',
    risk: 'high',
    reason: 'Text asks the agent to bypass security policy or user confirmation',
    patterns: [
      /\bbypass\s+(the\s+)?(security|safety)\s+(policy|policies|checks?)\b/i,
      /\b(do\s+not|don't)\s+(ask|request)\s+(the\s+)?user\s+(for\s+)?confirmation\b/i,
      /\bskip\s+(permission|authorization|confirmation)\s+(checks?|prompts?)\b/i,
      /绕过.{0,12}(安全策略|权限检查|用户确认|授权)/i,
      /不要.{0,8}(请求|询问).{0,8}(用户确认|授权|权限)/i,
    ],
  },
  {
    id: 'prompt.credential-theft',
    category: 'credential-theft',
    risk: 'critical',
    reason: 'Text asks for credentials, tokens, or sensitive local secret files',
    patterns: [
      /\b(read|cat|open|copy|collect|steal)\s+.{0,40}(\.ssh\/id_rsa|\.env|api[_-]?key|token|password|credential)/i,
      /\b(steal|exfiltrate|dump)\s+.{0,40}(api[_-]?key|token|password|credential|secret)\b/i,
      /读取.{0,24}(\.env|SSH\s*私钥|id_rsa|API\s*Key|token|密码|凭据|密钥)/i,
      /窃取.{0,24}(API\s*Key|token|密码|凭据|密钥|Cookie)/i,
    ],
  },
  {
    id: 'prompt.data-exfiltration',
    category: 'data-exfiltration',
    risk: 'critical',
    reason: 'Text asks the agent to send local data to an external destination',
    patterns: [
      /\b(send|upload|post)\s+.{0,80}(files?|source\s+code|workspace|secrets?|credentials?)\s+.{0,40}\b(to|http|https|webhook)\b/i,
      /\bexfiltrate\s+.{0,80}\b(to|http|https|webhook)\b/i,
      /上传.{0,80}(文件|源码|工作区|密钥|凭据).{0,40}(http|https|服务器|接口|webhook)/i,
      /发送.{0,80}(文件|源码|工作区|密钥|凭据).{0,40}(http|https|服务器|接口|webhook)/i,
    ],
  },
  {
    id: 'prompt.hidden-behavior',
    category: 'hidden-behavior',
    risk: 'high',
    reason: 'Text asks the agent to hide actions from the user',
    patterns: [
      /\b(do\s+not|don't|never)\s+(tell|inform|notify|warn)\s+(the\s+)?user\b/i,
      /\bhide\s+(this|the)\s+(action|operation|request|tool\s+call)\s+from\s+(the\s+)?user\b/i,
      /不要.{0,8}(告诉|通知|提醒).{0,8}用户/i,
      /向用户.{0,8}(隐藏|保密).{0,12}(操作|行为|工具调用|请求)/i,
    ],
  },
  {
    id: 'prompt.identity-hijack',
    category: 'identity-hijack',
    risk: 'medium',
    reason: 'Text attempts to redefine the assistant identity or authority level',
    patterns: [
      /\byou\s+are\s+now\s+(the\s+)?(system|developer|administrator|root)\b/i,
      /\bact\s+as\s+(the\s+)?(system|developer|administrator|root)\b/i,
      /你现在是.{0,8}(系统|开发者|管理员|root)/i,
      /扮演.{0,8}(系统|开发者|管理员|root)/i,
    ],
  },
];

function riskScore(risk: SecurityRisk): number {
  if (risk === 'critical') return 4;
  if (risk === 'high') return 3;
  if (risk === 'medium') return 2;
  return 1;
}

function highestRisk(matches: PromptScanRuleMatch[]): SecurityRisk {
  return matches.reduce<SecurityRisk>((highest, match) => (
    riskScore(match.risk) > riskScore(highest) ? match.risk : highest
  ), 'low');
}

function excerptForMatch(text: string, match: RegExpExecArray): string {
  const start = Math.max(0, match.index - 48);
  const end = Math.min(text.length, match.index + match[0].length + 48);
  const excerpt = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (excerpt.length <= MAX_EXCERPT_LENGTH) return excerpt;
  return `${excerpt.slice(0, MAX_EXCERPT_LENGTH - 3)}...`;
}

function findRuleMatches(text: string): PromptScanRuleMatch[] {
  const matches: PromptScanRuleMatch[] = [];
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      pattern.lastIndex = 0;
      const match = pattern.exec(text);
      if (!match) continue;
      matches.push({
        id: rule.id,
        category: rule.category,
        risk: rule.risk,
        reason: rule.reason,
        excerpt: excerptForMatch(text, match),
      });
      break;
    }
  }
  return matches;
}

function allowDecision(): SecurityDecision {
  return {
    action: 'allow',
    risk: 'low',
    reasons: ['No prompt-injection indicators matched'],
  };
}

function warnDecision(matches: PromptScanRuleMatch[], risk: SecurityRisk): SecurityDecision {
  return {
    action: 'prompt',
    risk,
    reasons: [...new Set(matches.map((match) => match.reason))],
    promptLevel: risk === 'high' || risk === 'critical' ? 'high' : 'normal',
    allowRememberChoice: false,
  };
}

function denyDecision(matches: PromptScanRuleMatch[], risk: SecurityRisk): SecurityDecision {
  return {
    action: 'deny',
    risk,
    reasons: [...new Set(matches.map((match) => match.reason))],
    code: 'PROMPT_INJECTION_DETECTED',
    ...(risk === 'critical' ? { hardDeny: true } : {}),
  };
}

export function evaluatePromptInjectionPolicy(request: PromptScanRequest): PromptScanResult {
  const matches = findRuleMatches(request.text);
  if (matches.length === 0) {
    return {
      decision: allowDecision(),
      source: request.source,
      name: request.name,
      matchedRules: [],
      matches: [],
      excerpts: [],
    };
  }

  const risk = highestRisk(matches);
  const shouldDeny = SOURCE_DENY_RISKS[request.source].includes(risk);
  const decision = shouldDeny ? denyDecision(matches, risk) : warnDecision(matches, risk);

  return {
    decision,
    source: request.source,
    name: request.name,
    matchedRules: matches.map((match) => match.id),
    matches,
    excerpts: matches.map((match) => match.excerpt),
  };
}

export function assertPromptInjectionSafe(request: PromptScanRequest): PromptScanResult {
  const result = evaluatePromptInjectionPolicy(request);
  if (result.decision.action === 'deny') {
    const error = new Error(result.decision.reasons.join('; '));
    (error as Error & { code?: string; decision?: SecurityDecision }).code = result.decision.code;
    (error as Error & { code?: string; decision?: SecurityDecision }).decision = result.decision;
    throw error;
  }
  return result;
}
