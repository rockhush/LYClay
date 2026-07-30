---
id: prevent-script-generation-debug-loop
title: Prevent script generation debug loops in document and data workflows
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Prevent document/data agents from repeatedly writing and executing broken generated scripts by adding convergence limits, generated-code validation, skill source protection, and a structured pause path before the chat appears stuck.
touchedAreas:
  - electron/main/ipc-handlers.ts
  - electron/runtime/tool-run-registry.ts
  - electron/security
  - electron/services/tool-registry.ts
  - src/stores/chat/types.ts
  - src/stores/chat/runaway-tool-observer.ts
  - src/stores/chat/task-convergence-strategy.ts
  - src/stores/chat/runtime-send-actions.ts
  - src/stores/chat/runtime-event-actions.ts
  - src/stores/chat/runtime-event-handlers.ts
  - src/pages/Chat/index.tsx
  - tests/unit/chat-runaway-tool-observer.test.ts
  - tests/unit/chat-runtime-send-actions.test.ts
  - tests/unit/chat-runtime-event-handlers.test.ts
  - tests/unit/generated-code-validation.test.ts
  - tests/unit/skill-source-protection.test.ts
expectedUserBehavior:
  - Normal chat, normal short tool calls, and normal successful document/data workflows remain unchanged.
  - Spreadsheet, PDF, Word, PowerPoint, presentation, and data-analysis workflows receive a bounded convergence strategy before the first model call.
  - The agent may inspect task structure briefly and run one complete processing path, but repeated script debugging must converge or pause instead of continuing indefinitely.
  - Generated `.py`, `.js`, `.ts`, `.mjs`, `.cjs`, `.json`, and shell-script files are validated after write/edit operations before the agent keeps building on them.
  - If a generated Python file contains null bytes or fails syntax compilation, the model receives a structured failure result that forbids repeating the same write/exec path.
  - After repeated generated-script failures, Chat shows an actionable paused/risky-run state rather than a generic thinking state.
  - Application-managed skill source files are treated as read-only during ordinary task execution; user-managed `~/.openclaw/skills/...` remains editable local content.
  - If a skill appears broken or missing a required method, the agent reports a skill defect and asks the user to repair/update the skill outside the current task.
  - User stop/abort still works through the existing abort flow and clears active run UI state.
  - Empty-final recovery, subagent announce finalization, and normal stalled-run diagnostics remain separate concerns and are not weakened.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/prevent-script-generation-debug-loop.md
  - pnpm exec vitest run tests/unit/chat-runaway-tool-observer.test.ts tests/unit/chat-runtime-send-actions.test.ts tests/unit/chat-runtime-event-handlers.test.ts tests/unit/generated-code-validation.test.ts tests/unit/skill-source-protection.test.ts
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - Document/data workflow detection includes spreadsheet, PDF, Word, presentation, PowerPoint, generated-report, charting, batch-file, and data-analysis tasks.
  - The convergence strategy tells the model to inspect structure briefly, choose one bounded implementation path, validate at most twice, and stop with a concise failure summary when validation still fails.
  - The convergence strategy includes Windows-safe execution guidance: do not use heredoc, do not rely on `&&`, do not run Python files with Node, prefer `python <file>` or `uv run python <file>`, and keep generated script content UTF-8 without null bytes.
  - Generated-code validation runs after tool results that create or modify executable/script/config files when the path is visible in the tool call or result.
  - Validation detects null bytes in all generated text/code files before any language-specific validation.
  - Python validation uses syntax compilation such as `py_compile` or an equivalent parser check without executing the generated script.
  - JavaScript/TypeScript validation uses an available parser/type-aware check when cheap and safe; otherwise it at least records that only null-byte/text validation was performed.
  - JSON validation parses JSON without executing code.
  - Validation failures are stored in `RunawayToolObservation` with file path, language, failure kind, count, and a bounded message.
  - Validation failure text is redacted and bounded; it must not include full generated source files or large tool outputs.
  - A generated file with null bytes produces a structured failure reason such as `generated_code_null_bytes`.
  - A Python syntax failure produces a structured failure reason such as `generated_python_syntax_error`.
  - A shell mismatch such as PowerShell rejecting `&&` produces a structured failure reason such as `shell_operator_unsupported`.
  - Running a `.py` file with `node` produces a structured failure reason such as `wrong_interpreter`.
  - The runaway observer increments repeated debug/script counters for repeated `write/edit -> exec -> validation/tool error` patterns.
  - The observer treats repeated failures on the same file path or same command family as stronger evidence than unrelated failures.
  - Risk progression for generated-script workflows is deterministic: `normal` -> `needs_convergence` -> `debug_loop` -> `needs_pause`.
  - `needs_convergence` may inject one medium/force convergence directive into the next model turn.
  - `debug_loop` must warn the user but may still allow one final bounded recovery attempt if limits are not exhausted.
  - `needs_pause` must stop automatic self-repair for the current run path and ask the model to summarize failure and request user direction, instead of continuing to write/execute similar scripts.
  - The system must not silently clear `sending`, `activeRunId`, or `pendingFinal` when entering `needs_pause`; it remains active until the runtime emits final/error/abort or the user stops the run.
  - If `needs_pause` is surfaced to the model, the model instruction must explicitly say not to repeat the same command, not to rewrite the same file again, and not to patch installed skill source during this task.
  - Skill source protection applies to application-managed skill directories, including bundled OpenClaw skills, bundled plugin skill directories, Codex system skills, and plugin cache roots.
  - Ordinary task runs may read installed skill files but may not write/edit/delete them unless the user explicitly asked to edit/update that skill.
  - When a tool call attempts to write/edit/delete installed skill source without explicit skill-edit intent, the call is blocked or converted into a structured tool error with reason `skill_source_readonly`.
  - The structured `skill_source_readonly` error tells the model to create a workspace runner/wrapper or report a skill defect.
  - Explicit skill maintenance tasks are out of this spec's default protection and must be governed by the existing skill security/permission flow.
  - Workspace-generated runners are allowed, but they remain subject to generated-code validation and repeated-failure limits.
  - The same generated script should not be executed more than a bounded number of times after validation/tool failures without either changing strategy materially or pausing.
  - The same command family should not be retried more than a bounded number of times after identical shell/interpreter failures.
  - Tool output summarization/compression is not introduced here unless already available; this spec only requires bounded failure messages and convergence guidance.
  - Renderer continues to use existing store/runtime event/host-api/api-client boundaries and must not add direct Gateway HTTP or direct `ipcRenderer.invoke` calls.
  - The implementation includes unit coverage for null-byte validation, Python syntax validation, wrong-interpreter detection, PowerShell `&&` failure classification, repeated write/exec debug-loop escalation, `needs_pause` directive generation, and skill source read-only blocking.
  - The implementation includes coverage that normal successful script generation is not warned or paused.
  - The implementation includes coverage that an explicitly requested skill-edit task is not blocked by ordinary task read-only protection.
docs:
  required: false
---

## Problem

In the observed stuck conversations, the agent tried to complete a DOE/PowerPoint/data task by writing long Python scripts containing Chinese text and report-generation logic. The generated scripts became malformed, including null bytes and syntax errors. The agent then repeatedly tried to repair the script, used unsupported PowerShell operators, ran Python files with Node, attempted to patch installed skill source files, and kept asking the model for another recovery path.

This is not just a weak-model problem. Better models may reduce the probability, but the system currently allows unbounded self-repair on a bad path. The fix needs runtime guardrails.

## Relationship To Existing Specs

This task complements these specs:

- `prevent-runaway-tool-loop-and-stalled-thinking`: records observer state and convergence metadata.
- `surface-stalled-and-runaway-chat-state`: makes unhealthy active runs visible to users.
- `settle-hung-tool-runs-with-watchdog`: handles active/hung tool lifecycle and cleanup.
- `settle-subagent-announce-finalization`: handles safe finalization when a run is actually done.

This task owns the specific prevention path for generated-code debug loops and skill-source mutation during document/data workflows.

## Non-Goals

- Do not solve this by changing finalization reconciliation.
- Do not treat a risky active run as completed.
- Do not automatically delete generated files.
- Do not automatically rewrite installed skills.
- Do not disable script generation entirely.
- Do not block normal user-requested skill editing.
- Do not add renderer-owned Gateway transport logic.
- Do not rely only on model choice or prompt wording.

## Required State Concepts

Add or reuse structured observations for:

- `generatedCodeValidation`: latest validation results by file path.
- `generatedCodeFailureCount`: total generated-code validation/tool failures in the run.
- `sameGeneratedFileFailureCount`: repeated failures for the same path.
- `sameCommandFamilyFailureCount`: repeated shell/interpreter failures for equivalent commands.
- `skillSourceMutationBlockedCount`: blocked attempts to modify installed skill source.
- `pauseReason`: nullable structured reason when automatic self-repair should stop.

Suggested failure kinds:

```ts
type GeneratedCodeFailureKind =
  | 'generated_code_null_bytes'
  | 'generated_python_syntax_error'
  | 'generated_json_parse_error'
  | 'shell_operator_unsupported'
  | 'wrong_interpreter'
  | 'skill_source_readonly'
  | 'repeated_debug_loop'
  | 'validation_unavailable';
```

## Generated-Code Validation

Validation must be a safe check, not execution.

For all generated text/code files:

1. Read a bounded prefix or the full file only when it is reasonably small.
2. Detect null bytes before language-specific parsing.
3. Detect binary-looking content where a text/code file was expected.
4. Store only bounded diagnostics.

For Python:

- Use `py_compile` or an equivalent parser check.
- Do not execute the script as validation.
- Treat null bytes as terminal for that generated file until the model chooses a materially different approach.

For JSON:

- Parse JSON.
- Do not accept partial JSON for files intended to be consumed as JSON.

For JavaScript/TypeScript:

- Prefer an available parser or cheap compile/syntax check.
- If no safe parser is available, record `validation_unavailable` after null-byte/text checks rather than pretending the file is valid.

## Failure Classification

Runtime/tool-result parsing should classify common repeated failures:

- PowerShell `&&` or heredoc/operator parse errors -> `shell_operator_unsupported`
- `node some_file.py` / Node syntax error on Python file -> `wrong_interpreter`
- Python `source code cannot contain null bytes` -> `generated_code_null_bytes`
- Python `SyntaxError` from generated script -> `generated_python_syntax_error`
- edit failure because old text does not match while patching generated script -> contributes to `debug_loop`
- attempted write/edit/delete under skill source root -> `skill_source_readonly`

These classifications should feed the runaway observer. They should not by themselves abort the run.

## Convergence Limits

Default limits should be conservative and configurable from a single shared place:

- At most 2 validation failures for the same generated file before `debug_loop`.
- At most 3 generated-script execution failures in one document/data run before `needs_pause`.
- At most 2 identical shell/interpreter failures before `needs_pause`.
- At most 1 blocked skill-source mutation before forcing a strategy change.

When limits are reached, the next model-facing directive should say:

- Do not repeat the same command.
- Do not rewrite the same file with the same strategy.
- Do not patch installed skill source in this task.
- Summarize what failed.
- Ask the user whether to simplify the task, repair the skill separately, or continue with a smaller bounded step.

## Skill Source Protection

Installed skills are dependencies, not scratch space.

Protected roots include:

- bundled OpenClaw skills
- bundled plugin skills
- Codex system skills
- plugin cache skill roots

Allowed by default:

- read skill source
- import/use skill source
- create and edit user-managed `~/.openclaw/skills/**` content
- create workspace runner or wrapper files
- report skill defects

Blocked by default:

- write/edit/delete skill source
- patch skill modules during ordinary user tasks
- mutate skill metadata during ordinary user tasks

Exception:

- Explicit user intent to create, edit, update, or repair a skill may go through the existing skill security and permission flow.

## User Experience

When the run reaches `debug_loop`, Chat should surface a warning once UI support from `surface-stalled-and-runaway-chat-state` is available.

When the run reaches `needs_pause`, the model should be instructed to produce a concise failure summary and ask for user direction. The UI should not keep showing only generic thinking if risk state is available.

The stop button must remain the existing primary escape hatch.

## Validation Scenarios

Required scenarios:

- A generated Python file containing `\x00` is detected before execution retry.
- A generated Python file with syntax errors is detected by compile validation.
- A PowerShell command using `&&` is classified as unsupported shell syntax.
- A Python file executed with Node is classified as wrong interpreter.
- Repeated write/exec failures on the same runner escalate to `debug_loop` and then `needs_pause`.
- Attempting to patch `~/.openclaw/skills/.../doe_report_generator.py` during an ordinary PPT task is blocked as `skill_source_readonly`.
- The model receives a directive to create a workspace wrapper or report the skill defect instead.
- A normal generated script that validates and succeeds does not trigger warnings.
- A user explicitly asking to edit a skill is routed through the skill security/permission path and is not blocked by this ordinary-task protection.
