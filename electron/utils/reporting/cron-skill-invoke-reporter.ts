import { parseSkillReadsFromTranscript } from '../../../shared/reporting/skill-invoke-transcript';
import { logger } from '../logger';
import { recordSkillInvoke } from './index';
import { formatReportDateTime } from './time';
import { resolveSkillInvokeSourceForReport } from './resolve-skill-invoke-source';
import type { ExecutionRecord } from './types';

type CronSkillInvokeStatus = 'success' | 'failed' | 'cancelled';

function mapExecutionStatus(status: ExecutionRecord['status']): CronSkillInvokeStatus {
  if (status === 'success') return 'success';
  if (status === 'cancelled') return 'cancelled';
  return 'failed';
}

/**
 * Report skill-invoke records for a cron turn by scanning its session transcript.
 * Renderer skill-invoke tracking is bypassed for supervisor-fired runs.
 */
export async function reportCronSkillInvokesFromTranscript(input: {
  transcript: string;
  executionId: string;
  agentId: string;
  sessionStartedAtMs: number;
  turnStartedAtMs: number;
  turnEndedAtMs: number;
  executionStatus: ExecutionRecord['status'];
}): Promise<number> {
  const reads = parseSkillReadsFromTranscript(input.transcript, {
    afterMs: input.turnStartedAtMs,
  });
  if (reads.length === 0) return 0;

  const status = mapExecutionStatus(input.executionStatus);
  const invokeEndTime = formatReportDateTime(input.turnEndedAtMs);
  const createDate = formatReportDateTime(input.sessionStartedAtMs);
  let reported = 0;

  for (const read of reads) {
    try {
      const skill_source = await resolveSkillInvokeSourceForReport(read.skillId, read.skillPath);
      await recordSkillInvoke({
        skillId: read.skillId,
        count: 1,
        execution_id: input.executionId,
        agent_id: input.agentId,
        skill_source,
        invoke_mode: 'model_selected',
        invoke_time: formatReportDateTime(read.invokeTimeMs),
        invoke_end_time: invokeEndTime,
        status,
        create_date: createDate,
        update_date: invokeEndTime,
      });
      reported += 1;
    } catch (error) {
      logger.warn('[UsageReport] cron skill-invoke: failed to queue record', {
        skillId: read.skillId,
        executionId: input.executionId,
        error: String(error),
      });
    }
  }

  if (reported > 0) {
    logger.info('[UsageReport] cron skill-invoke queued', {
      executionId: input.executionId,
      count: reported,
    });
  }

  return reported;
}
