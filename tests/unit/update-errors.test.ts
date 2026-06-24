import { describe, expect, it } from 'vitest';
import {
  formatSkillBatchUpdateFailureReason,
  formatUpdateFriendlyError,
  isUpdateIntranetOrNetworkError,
  UPDATE_INTRANET_REQUIRED_MESSAGE,
} from '@/lib/update-errors';

describe('update-errors', () => {
  const batchLabels = {
    skillNotInMarketplace: '技能广场没有此技能',
    rateLimited: '网络限流，请重新再试',
    useIntranet: '请使用内网',
  };

  it('maps JSON parse failures to intranet message', () => {
    expect(formatUpdateFriendlyError('Unexpected token < in JSON at position 0'))
      .toBe(UPDATE_INTRANET_REQUIRED_MESSAGE);
  });

  it('maps small download failures to intranet message', () => {
    expect(formatUpdateFriendlyError('Download failed: file too small (125 bytes)'))
      .toBe(UPDATE_INTRANET_REQUIRED_MESSAGE);
  });

  it('keeps unrelated errors unchanged', () => {
    expect(formatUpdateFriendlyError('Permission denied')).toBe('Permission denied');
  });

  it('detects intranet/network patterns', () => {
    expect(isUpdateIntranetOrNetworkError('fetch failed')).toBe(true);
    expect(isUpdateIntranetOrNetworkError('Permission denied')).toBe(false);
  });

  it('maps batch update Company API 404 to marketplace missing message', () => {
    expect(formatSkillBatchUpdateFailureReason('Company API error: 404', batchLabels))
      .toBe('技能广场没有此技能');
  });

  it('maps batch update Company API 429 to rate limit message', () => {
    expect(formatSkillBatchUpdateFailureReason('Company API error: 429', batchLabels))
      .toBe('网络限流，请重新再试');
  });

  it('maps batch update JSON parse failures to intranet message', () => {
    expect(formatSkillBatchUpdateFailureReason(
      'Unexpected token \'<\', "<HTML> <H"... is not valid JSON',
      batchLabels,
    )).toBe('请使用内网');
  });
});
