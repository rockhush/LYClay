import { describe, expect, it, vi } from 'vitest';
import {
  createRunawayToolObservation,
  detectTaskWorkflowKind,
  observeRunawayToolEvent,
} from '@/stores/chat/runaway-tool-observer';
import { buildInitialConvergenceSystemPrompt } from '@/stores/chat/task-convergence-strategy';
import type { ToolStatus } from '@/stores/chat/types';

function runningTool(name: string, id: string, input: Record<string, unknown> = {}) {
  return {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id,
        name,
        input,
      },
    ],
  };
}

function completedTool(name: string, id: string): ToolStatus {
  return {
    name,
    toolCallId: id,
    status: 'completed',
    updatedAt: 1,
  };
}

describe('runaway tool observer', () => {
  it('detects document and data workflow kinds from attachments and text', () => {
    expect(detectTaskWorkflowKind('帮我计算 VMI 补货', [
      { fileName: 'vmi.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileSize: 10 },
    ])).toBe('spreadsheet');
    expect(detectTaskWorkflowKind('summarize report.pdf')).toBe('pdf');
    expect(detectTaskWorkflowKind('处理 sales.jsonl 数据集')).toBe('data-analysis');
    expect(detectTaskWorkflowKind('处理附件', [
      { fileName: 'a.xlsx', mimeType: '', fileSize: 1 },
      { fileName: 'b.pdf', mimeType: '', fileSize: 1 },
    ])).toBe('batch-files');
  });

  it('counts unique tool calls and results without double counting repeated events', () => {
    const observation = createRunawayToolObservation({
      sessionKey: 'session-1',
      runId: 'run-1',
      taskKind: 'spreadsheet',
      now: 1,
    });

    const once = observeRunawayToolEvent({
      observation,
      event: { message: runningTool('exec', 'tool-1', { command: 'uv run python script.py' }) },
      resolvedState: 'delta',
      runId: 'run-1',
      sessionKey: 'session-1',
      toolUpdates: [],
      now: 2,
    });
    const twice = observeRunawayToolEvent({
      observation: once,
      event: { message: runningTool('exec', 'tool-1', { command: 'uv run python script.py' }) },
      resolvedState: 'delta',
      runId: 'run-1',
      sessionKey: 'session-1',
      toolUpdates: [completedTool('exec', 'tool-1'), completedTool('exec', 'tool-1')],
      now: 3,
    });

    expect(twice?.toolCallCount).toBe(1);
    expect(twice?.toolResultCount).toBe(1);
  });

  it('marks repeated write plus exec loops as debug_loop', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let observation = createRunawayToolObservation({
      sessionKey: 'session-1',
      runId: 'run-1',
      taskKind: 'spreadsheet',
      now: 1,
    });

    for (let i = 0; i < 4; i += 1) {
      observation = observeRunawayToolEvent({
        observation,
        event: { message: runningTool('write', `write-${i}`, { path: `debug_${i}.py` }) },
        resolvedState: 'delta',
        runId: 'run-1',
        sessionKey: 'session-1',
        toolUpdates: [],
        now: 10 + i,
      })!;
      observation = observeRunawayToolEvent({
        observation,
        event: { message: runningTool('exec', `exec-${i}`, { command: 'uv run python debug.py' }) },
        resolvedState: 'delta',
        runId: 'run-1',
        sessionKey: 'session-1',
        toolUpdates: [],
        now: 20 + i,
      })!;
    }

    expect(observation.writeExecPairCount).toBeGreaterThanOrEqual(3);
    expect(observation.riskState).toBe('debug_loop');
    expect(observation.convergenceDirectiveLevel).toBe('medium');
    expect(observation.convergenceDirective).toContain('complete processing script');
    expect(observation.riskReasons.join(' ')).toContain('write/exec');
    infoSpy.mockRestore();
  });

  it('detects repeated debug scripts, repeated output shapes, and excessive structure probing', () => {
    let observation = createRunawayToolObservation({
      sessionKey: 'session-1',
      runId: 'run-1',
      taskKind: 'spreadsheet',
      now: 1,
    });

    for (let i = 0; i < 4; i += 1) {
      observation = observeRunawayToolEvent({
        observation,
        event: { message: runningTool('read', `read-${i}`, { filePath: `sheet-${i}.txt` }) },
        resolvedState: 'delta',
        runId: 'run-1',
        sessionKey: 'session-1',
        toolUpdates: [],
        now: 10 + i,
      })!;
    }

    for (let i = 0; i < 3; i += 1) {
      observation = observeRunawayToolEvent({
        observation,
        event: { message: runningTool('write', `write-debug-${i}`, { path: `vmi_check_${i}.py` }) },
        resolvedState: 'delta',
        runId: 'run-1',
        sessionKey: 'session-1',
        toolUpdates: [],
        now: 20 + i,
      })!;
    }

    const repeatedResult = {
      role: 'toolResult',
      toolCallId: 'result-1',
      toolName: 'exec',
      content: [{ type: 'text', text: 'Row6 empty\nRow7 has value\nRow8 empty\nSheet: VMI' }],
    };
    observation = observeRunawayToolEvent({
      observation,
      event: { message: repeatedResult },
      resolvedState: 'final',
      runId: 'run-1',
      sessionKey: 'session-1',
      toolUpdates: [{ name: 'exec', toolCallId: 'result-1', status: 'completed', updatedAt: 1 }],
      now: 30,
    })!;
    observation = observeRunawayToolEvent({
      observation,
      event: { message: { ...repeatedResult, toolCallId: 'result-2' } },
      resolvedState: 'final',
      runId: 'run-1',
      sessionKey: 'session-1',
      toolUpdates: [{ name: 'exec', toolCallId: 'result-2', status: 'completed', updatedAt: 2 }],
      now: 31,
    })!;

    expect(observation.structuralInspectionCount).toBe(4);
    expect(observation.repeatedDebugScriptCount).toBeGreaterThanOrEqual(2);
    expect(observation.repeatedOutputPatternCount).toBe(1);
    expect(observation.riskState).toBe('debug_loop');
    expect(observation.riskReasons.join(' ')).toContain('structural_inspections>=4');
    expect(observation.riskReasons.join(' ')).toContain('repeated debug scripts>=2');
  });

  it('escalates high tool counts to needs_pause', () => {
    let observation = createRunawayToolObservation({
      sessionKey: 'session-1',
      runId: 'run-1',
      taskKind: 'general',
      now: 1,
    });

    for (let i = 0; i < 45; i += 1) {
      observation = observeRunawayToolEvent({
        observation,
        event: { message: runningTool('read', `read-${i}`) },
        resolvedState: 'delta',
        runId: 'run-1',
        sessionKey: 'session-1',
        toolUpdates: [],
        now: 2 + i,
      })!;
    }

    expect(observation.toolCallCount).toBe(45);
    expect(observation.riskState).toBe('needs_pause');
    expect(observation.convergenceDirectiveLevel).toBe('force');
    expect(observation.convergenceDirective).toContain('runaway tool loop');
  });

  it('builds initial convergence prompts for document/data workflows only', () => {
    expect(buildInitialConvergenceSystemPrompt('general')).toBeNull();
    const spreadsheetPrompt = buildInitialConvergenceSystemPrompt('spreadsheet');
    expect(spreadsheetPrompt).toContain('Do at most 2-3 structural inspection steps');
    expect(spreadsheetPrompt).toContain('Spreadsheet tasks');

    const pdfPrompt = buildInitialConvergenceSystemPrompt('pdf');
    expect(pdfPrompt).toContain('PDF tasks');
    expect(pdfPrompt).toContain('OCR/image analysis');
  });
});
