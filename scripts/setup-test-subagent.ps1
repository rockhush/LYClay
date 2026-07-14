<#
.SYNOPSIS
  创建测试用岗位助理 "test-analyst"，写入本地 ~/.openclaw 存储。

.DESCRIPTION
  运行后会在以下路径创建完整的岗位助理数据：
  - ~/.openclaw/digital-employee/test-analyst/     (Skills + MCP + 人设模板)
  - ~/.openclaw/workspace-test-analyst/            (运行时 workspace + 记忆)
  - ~/.openclaw/agents/test-analyst/agent/         (运行配置)
  同时更新 openclaw.json 注册新 Agent。

  创建完毕后，可在 LYClaw 会话中 @test-analyst 测试子 Agent 执行流程。

.NOTES
  运行方式:
    powershell -ExecutionPolicy Bypass -File scripts/setup-test-subagent.ps1
#>

$ErrorActionPreference = "Stop"
$OPENCLAW = "$env:USERPROFILE\.openclaw"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  创建测试岗位助理 test-analyst" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ============================================================
# 1. 创建包目录 digital-employee/test-analyst/
# ============================================================
$PKG = "$OPENCLAW\digital-employee\test-analyst"
$dirs = @(
    "$PKG\skills\doc-report",
    "$PKG\skills\empty-skill",
    "$PKG\skills\broken-skill",
    "$PKG\mcp",
    "$PKG\agent\workspace",
    "$PKG\workflows",
    "$PKG\resources"
)
foreach ($d in $dirs) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    Write-Host "  DIR  $d" -ForegroundColor DarkGray
}

# ---------- employee.json ----------
@'
{
  "schemaVersion": 1,
  "package": {
    "id": "com.lyclaw.employee.test-analyst",
    "name": "测试分析岗位助理",
    "version": "1.0.0",
    "description": "用于测试子 Agent 执行流程的模拟数据",
    "category": "test",
    "tags": ["测试"]
  },
  "agent": {
    "entryTemplate": "agent/agent.template.json",
    "workspaceSource": "agent/workspace",
    "inheritMainWorkspace": false
  },
  "skills": [
    { "slug": "doc-report",   "source": "bundled",     "path": "skills/doc-report",   "required": true },
    { "slug": "empty-skill",  "source": "bundled",     "path": "skills/empty-skill",  "required": false },
    { "slug": "broken-skill", "source": "bundled",     "path": "skills/broken-skill", "required": false },
    { "slug": "missing-skill","source": "dependency",  "version": "*",               "required": false }
  ],
  "mcp": {
    "serverTemplate": "mcp/servers.json",
    "bindings": [
      { "server": "test-docs", "required": true, "enabled": true,
        "allowedTools": ["search", "get"] }
    ]
  },
  "install": {
    "createAgent": true,
    "agentOwnership": "exclusive"
  }
}
'@ | Set-Content -Encoding utf8 "$PKG\employee.json"

# ---------- skills/doc-report/SKILL.md ----------
@'
---
name: doc-report
slug: doc-report
description: 测试用文档报告生成技能 - 分析用户指定的文件并输出结构化报告
version: 1.0.0
author: LYClaw Test
permissions:
  filesystem:
    - workspace:read
    - workspace:write
  network: []
  commands: []
---

# 文档报告生成（测试用）

## 工作步骤
1. 确认需要处理的源文件和用户期望的输出形式
2. 提取关键信息（事实、日期、数量、状态等）
3. 按以下结构输出报告：
   - 执行摘要
   - 资料范围
   - 关键发现
   - 后续建议

## 安全边界
- 只读取 workspace 内的文件
- 不执行外部命令
- 不覆盖源文件
'@ | Set-Content -Encoding utf8 "$PKG\skills\doc-report\SKILL.md"

# ---------- skills/empty-skill/SKILL.md ----------
@'
---
name: empty-skill
slug: empty-skill
description: 内容为空的测试 Skill，用于验证空 Skill 的加载行为
---
'@ | Set-Content -Encoding utf8 "$PKG\skills\empty-skill\SKILL.md"

# ---------- skills/broken-skill/SKILL.md ----------
@'
---
name: broken-skill
slug: broken-skill
description: "未闭合的引号 导致 YAML 解析失败
permissions: {
  invalid json
---
# 这个 Skill 的 frontmatter 格式错误
内容无法正常解析，用于测试错误处理。
'@ | Set-Content -Encoding utf8 "$PKG\skills\broken-skill\SKILL.md"

# ---------- mcp/servers.json ----------
@'
{
  "servers": {
    "test-docs": {
      "type": "streamable-http",
      "url": "http://localhost:19999/mcp",
      "headers": {
        "Authorization": "Bearer test-token-xxxx"
      },
      "disabled": false,
      "tools": {
        "allow": ["search", "get"]
      }
    },
    "test-disabled": {
      "type": "streamable-http",
      "url": "http://localhost:19998/mcp",
      "disabled": true,
      "tools": {
        "allow": ["list"]
      }
    }
  }
}
'@ | Set-Content -Encoding utf8 "$PKG\mcp\servers.json"

# ---------- agent/agent.template.json ----------
@'
{
  "id": "${AGENT_ID}",
  "name": "测试分析岗位助理",
  "workspace": "~/.openclaw/workspace-test-analyst",
  "agentDir": "~/.openclaw/agents/test-analyst/agent"
}
'@ | Set-Content -Encoding utf8 "$PKG\agent\agent.template.json"

# ---------- agent/workspace/* ----------
@'
# test-analyst 行为规则
- 输出格式使用 Markdown，结构清晰
- 事实与分析判断明确区分，不得混在一起
- 读取文件前先确认文件路径在 workspace 内
- 无法完成任务时直接说明原因，不编造结果
'@ | Set-Content -Encoding utf8 "$PKG\agent\workspace\AGENTS.md"

@'
# SOUL.md - 测试分析岗位助理
## Core Truths
Be precise and thorough. Double-check facts before reporting.
## Vibe
Professional and concise. No fluff, no filler.
'@ | Set-Content -Encoding utf8 "$PKG\agent\workspace\SOUL.md"

@'
# IDENTITY.md
- **Name:** Test Analyst
- **Creature:** AI Agent
- **Vibe:** Precise, detail-oriented
- **Emoji:** 🔍
'@ | Set-Content -Encoding utf8 "$PKG\agent\workspace\IDENTITY.md"

@'
# USER.md
- 用户是测试人员，正在验证子 Agent 执行流程
'@ | Set-Content -Encoding utf8 "$PKG\agent\workspace\USER.md"

@'
# TOOLS.md
- 使用 Read 读取文件
- 使用 Write 生成报告
- 使用 Bash 执行必要的数据处理命令
'@ | Set-Content -Encoding utf8 "$PKG\agent\workspace\TOOLS.md"

@'
# HEARTBEAT.md
test-analyst 上线提醒: 我已就绪，随时可以执行文档分析任务。
'@ | Set-Content -Encoding utf8 "$PKG\agent\workspace\HEARTBEAT.md"

@'
# BOOT.md
首次启动时向用户简单介绍自己的能力范围：文档分析、报告生成。
'@ | Set-Content -Encoding utf8 "$PKG\agent\workspace\BOOT.md"

# ---------- workflows/default.md ----------
@'
# 默认工作流程
1. 理解用户的任务目标
2. 确认需要的源文件齐全
3. 生成简短的执行计划
4. 按计划执行
5. 检查结果，报告发现
'@ | Set-Content -Encoding utf8 "$PKG\workflows\default.md"

# ---------- resources/report-guidelines.md ----------
@'
# 报告规范
- 使用 Markdown 格式
- 数据要有来源引用
- 风险项必须标注严重程度（高/中/低）
'@ | Set-Content -Encoding utf8 "$PKG\resources\report-guidelines.md"

Write-Host ""
Write-Host "  [OK] digital-employee/test-analyst/ 创建完成" -ForegroundColor Green

# ============================================================
# 2. 创建运行时 workspace workspace-test-analyst/
# ============================================================
$WS = "$OPENCLAW\workspace-test-analyst"
$wsDirs = @(
    "$WS\.openclaw",
    "$WS\memory"
)
foreach ($d in $wsDirs) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}

Copy-Item "$PKG\agent\workspace\AGENTS.md"    "$WS\AGENTS.md" -Force
Copy-Item "$PKG\agent\workspace\SOUL.md"      "$WS\SOUL.md" -Force
Copy-Item "$PKG\agent\workspace\IDENTITY.md"  "$WS\IDENTITY.md" -Force
Copy-Item "$PKG\agent\workspace\USER.md"      "$WS\USER.md" -Force
Copy-Item "$PKG\agent\workspace\TOOLS.md"     "$WS\TOOLS.md" -Force
Copy-Item "$PKG\agent\workspace\HEARTBEAT.md" "$WS\HEARTBEAT.md" -Force

@'
# Workspace State
{ "createdAt": "2026-06-10T00:00:00Z", "agentId": "test-analyst" }
'@ | Set-Content -Encoding utf8 "$WS\.openclaw\workspace-state.json"

@'
# test-analyst 的记忆

## 能力范围
- 分析文档内容，生成结构化报告
- 支持格式: .txt, .md, .csv

## 工作偏好
- 输出使用中文
- 报告格式偏好 Markdown
'@ | Set-Content -Encoding utf8 "$WS\memory\workspace.md"

Write-Host "  [OK] workspace-test-analyst/ 创建完成" -ForegroundColor Green

# ============================================================
# 3. 创建运行配置 agents/test-analyst/agent/
# ============================================================
$AG = "$OPENCLAW\agents\test-analyst\agent"
New-Item -ItemType Directory -Force -Path $AG | Out-Null

@'
{
  "providers": {
    "ly-auto": {
      "models": ["auto"]
    }
  }
}
'@ | Set-Content -Encoding utf8 "$AG\models.json"

@'
{
  "profiles": {},
  "order": []
}
'@ | Set-Content -Encoding utf8 "$AG\auth-profiles.json"

@'
{
  "profileId": null,
  "profileSource": null,
  "updatedAt": null
}
'@ | Set-Content -Encoding utf8 "$AG\auth-state.json"

Write-Host "  [OK] agents/test-analyst/agent/ 创建完成" -ForegroundColor Green

# ============================================================
# 4. 注册到 openclaw.json
# ============================================================
$configPath = "$OPENCLAW\openclaw.json"
$config = Get-Content -Encoding utf8 $configPath | ConvertFrom-Json

$exists = $config.agents.list | Where-Object { $_.id -eq 'test-analyst' }
if ($exists) {
    Write-Host ""
    Write-Host "  [SKIP] test-analyst 已在 openclaw.json 中注册" -ForegroundColor Yellow
} else {
    $newAgent = [PSCustomObject]@{
        id         = 'test-analyst'
        name       = '测试分析岗位助理'
        workspace  = '~/.openclaw/workspace-test-analyst'
        agentDir   = '~/.openclaw/agents/test-analyst/agent'
    }
    $config.agents.list += $newAgent

    # 保持格式化的 JSON 输出
    $json = $config | ConvertTo-Json -Depth 10
    # PowerShell ConvertTo-Json 会转义 Unicode，这里保持 UTF-8
    [System.IO.File]::WriteAllText($configPath, $json, [System.Text.UTF8Encoding]($false))
    Write-Host "  [OK] test-analyst 已注册到 openclaw.json" -ForegroundColor Green
}

# ============================================================
# 5. 汇总
# ============================================================
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  创建完成!" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  包目录:     $PKG" -ForegroundColor White
Write-Host "  Workspace:  $WS" -ForegroundColor White
Write-Host "  Agent配置:  $AG" -ForegroundColor White
Write-Host ""
Write-Host "  Skills:" -ForegroundColor White
Write-Host "    - doc-report     (正常 Skill)" -ForegroundColor DarkGray
Write-Host "    - empty-skill    (空 Skill / 边界测试)" -ForegroundColor DarkGray
Write-Host "    - broken-skill   (格式错误 / 异常测试)" -ForegroundColor DarkGray
Write-Host "    - missing-skill  (dependency 未安装)" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  MCP:" -ForegroundColor White
Write-Host "    - test-docs      (可用, localhost:19999)" -ForegroundColor DarkGray
Write-Host "    - test-disabled  (已禁用)" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  下一步: 重启 LYClaw，即可在会话中 @test-analyst 测试" -ForegroundColor Yellow
