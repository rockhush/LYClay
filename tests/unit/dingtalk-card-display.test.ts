import { describe, expect, it, beforeEach } from 'vitest';
import {
  applyDingtalkCardDisplayFlags,
  clearDingtalkCardPendingRun,
  computeDingtalkCardFingerprint,
  getDingtalkCardFingerprintsForSession,
  getDingtalkCardMessageIdsForSession,
  getDingtalkCardRunIdsForSession,
  loadDingtalkCardEnabled,
  persistDingtalkCardEnabled,
  persistDingtalkCardFingerprint,
  persistDingtalkCardMessageId,
  persistDingtalkCardRunId,
  propagateDingtalkCardFlagsFromLocal,
  reconcileDingtalkCardPersistence,
  tagDingtalkCardMessageIfPending,
  collectLocalMessagesForDingtalkMerge,
  shouldRenderAssistantAsDingtalkCard,
} from '@/lib/dingtalk-card-display';
import type { RawMessage } from '@/stores/chat/types';

describe('dingtalk-card-display', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('persists and loads enabled flag', () => {
    expect(loadDingtalkCardEnabled()).toBe(false);
    persistDingtalkCardEnabled(true);
    expect(loadDingtalkCardEnabled()).toBe(true);
  });

  it('persists message ids, run ids, and fingerprints per session', () => {
    persistDingtalkCardMessageId('agent:main:session-1', 'msg-123');
    persistDingtalkCardRunId('agent:main:session-1', 'run-abc');
    persistDingtalkCardFingerprint('agent:main:session-1', 'fp-test-42');
    expect(getDingtalkCardMessageIdsForSession('agent:main:session-1')).toEqual(new Set(['msg-123']));
    expect(getDingtalkCardRunIdsForSession('agent:main:session-1')).toEqual(new Set(['run-abc']));
    expect(getDingtalkCardFingerprintsForSession('agent:main:session-1')).toEqual(new Set(['fp-test-42']));
  });

  it('computes stable fingerprints', () => {
    const a = computeDingtalkCardFingerprint('科比 vs 詹姆斯');
    const b = computeDingtalkCardFingerprint('科比  vs  詹姆斯');
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('applies display flags by message id, run id, and fingerprint', () => {
    const text = '勒布朗·詹姆斯 vs 凯文·杜兰特';
    const fingerprint = computeDingtalkCardFingerprint(text);
    const messages: RawMessage[] = [
      { role: 'assistant', content: 'hello', id: 'msg-123' },
      { role: 'assistant', content: 'other', id: 'run-run-abc' },
      { role: 'assistant', content: text, id: 'gateway-uuid' },
    ];
    const flagged = applyDingtalkCardDisplayFlags(
      messages,
      new Set(['msg-123']),
      new Set(['run-abc']),
      new Set([fingerprint]),
      (content) => (typeof content === 'string' ? content : ''),
    );
    expect(flagged[0]?._dingtalkCard).toBe(true);
    expect(flagged[1]?._dingtalkCard).toBe(true);
    expect(flagged[2]?._dingtalkCard).toBe(true);
  });

  it('propagates dingtalk card flags from local messages by text', () => {
    const loaded: RawMessage[] = [
      { role: 'assistant', content: '科比 vs 詹姆斯', id: 'gateway-id-1' },
    ];
    const local: RawMessage[] = [
      { role: 'assistant', content: '科比 vs 詹姆斯', id: 'run-run-1', _dingtalkCard: true },
    ];
    const flagged = propagateDingtalkCardFlagsFromLocal(
      loaded,
      local,
      (content) => (typeof content === 'string' ? content : ''),
    );
    expect(flagged[0]?._dingtalkCard).toBe(true);
  });

  it('reconciles gateway ids and fingerprints after history reload', () => {
    const text = '勒布朗·詹姆斯 vs 凯文·杜兰特';
    reconcileDingtalkCardPersistence(
      'agent:main:session-1',
      [{ role: 'assistant', content: text, id: 'gateway-id-1', _dingtalkCard: true }],
      (content) => (typeof content === 'string' ? content : ''),
    );
    expect(getDingtalkCardMessageIdsForSession('agent:main:session-1')).toEqual(new Set(['gateway-id-1']));
    expect(getDingtalkCardFingerprintsForSession('agent:main:session-1').size).toBe(1);
  });

  it('clears pending run ids for a session', () => {
    expect(clearDingtalkCardPendingRun({ 'agent:main:main': 'run-1' }, 'agent:main:main')).toEqual({});
    expect(clearDingtalkCardPendingRun({ 'agent:main:main': 'run-1' }, 'agent:main:other')).toEqual({
      'agent:main:main': 'run-1',
    });
  });

  it('tags pending background messages and persists fingerprints', () => {
    const tagged = tagDingtalkCardMessageIfPending(
      { role: 'assistant', content: '荷兰队分析', id: 'gateway-id' },
      'agent:main:session-1',
      'run-1',
      { 'agent:main:session-1': 'run-1' },
      (content) => (typeof content === 'string' ? content : ''),
    );
    expect(tagged._dingtalkCard).toBe(true);
    expect(getDingtalkCardMessageIdsForSession('agent:main:session-1')).toEqual(new Set(['gateway-id']));
    expect(getDingtalkCardFingerprintsForSession('agent:main:session-1').size).toBe(1);
  });

  it('merges dingtalk flags from session snapshot into current messages', () => {
    const merged = collectLocalMessagesForDingtalkMerge(
      [{ role: 'assistant', content: '荷兰队分析', id: 'gateway-id' }],
      [{ role: 'assistant', content: '荷兰队分析', id: 'run-run-1', _dingtalkCard: true }],
    );
    expect(merged[0]?._dingtalkCard).toBe(true);
  });

  it('detects dingtalk card rendering', () => {
    const message: RawMessage = { role: 'assistant', content: 'hello', _dingtalkCard: true };
    expect(shouldRenderAssistantAsDingtalkCard(message)).toBe(true);
    expect(shouldRenderAssistantAsDingtalkCard({ role: 'assistant', content: 'hello' }, true)).toBe(true);
  });
});
