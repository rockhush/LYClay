import { describe, expect, it } from 'vitest';
import {
  dedupeConsecutiveEquivalentUserMessages,
  dedupeEquivalentAttachmentUserMessages,
  matchesOptimisticUserMessage,
} from '@/stores/chat/helpers';

describe('matchesOptimisticUserMessage', () => {
  it('matches when text is identical', () => {
    const optimistic = { role: 'user', content: 'run github1', timestamp: 1_700_000_000 } as const;
    const candidate = { role: 'user', content: 'run github1', timestamp: 1_700_000_000 } as const;

    expect(matchesOptimisticUserMessage(candidate, optimistic, 1_700_000_000_000)).toBe(true);
  });

  it('matches when Gateway prefixes a weekday/timestamp prefix on the echoed user message', () => {
    const optimistic = { role: 'user', content: 'run github1', timestamp: 1_700_000_000 } as const;
    const candidate = {
      role: 'user',
      content: '[Wed 2026-04-22 10:30 GMT+8] run github1',
      timestamp: 1_700_000_000,
    } as const;

    expect(matchesOptimisticUserMessage(candidate, optimistic, 1_700_000_000_000)).toBe(true);
  });

  it('matches when the server appends [media attached: ...] to the echoed user message', () => {
    const optimistic = {
      role: 'user',
      content: 'Describe this image',
      timestamp: 1_700_000_000,
      _attachedFiles: [
        {
          fileName: 'shot.png',
          mimeType: 'image/png',
          fileSize: 123,
          preview: null,
          filePath: '/tmp/shot.png',
        },
      ],
    } as const;
    const candidate = {
      role: 'user',
      content: 'Describe this image\n\n[media attached: /tmp/shot.png (image/png) | /tmp/shot.png]',
      timestamp: 1_700_000_000,
    } as const;

    expect(matchesOptimisticUserMessage(candidate, optimistic, 1_700_000_000_000)).toBe(true);
  });

  it('matches when the server strips a [message_id: ...] tag from the user message', () => {
    const optimistic = { role: 'user', content: 'hello world', timestamp: 1_700_000_000 } as const;
    const candidate = {
      role: 'user',
      content: 'hello world [message_id: 11111111-2222-3333-4444-555555555555]',
      timestamp: 1_700_000_000,
    } as const;

    expect(matchesOptimisticUserMessage(candidate, optimistic, 1_700_000_000_000)).toBe(true);
  });

  it('matches attachment-only UI placeholder against runtime transcript text', () => {
    const optimistic = {
      role: 'user',
      content: '(file attached)',
      timestamp: 1_700_000_000,
      _attachedFiles: [
        {
          fileName: 'qr.png',
          mimeType: 'image/png',
          fileSize: 456,
          preview: null,
          filePath: '/tmp/qr.png',
        },
      ],
    } as const;
    const candidate = {
      role: 'user',
      content: 'Process the attached file(s).',
      timestamp: 1_700_000_001,
    } as const;

    expect(matchesOptimisticUserMessage(candidate, optimistic, 1_700_000_000_000)).toBe(true);
  });

  it('dedupes attachment-only UI placeholder when runtime transcript text is present', () => {
    const messages = [
      {
        role: 'user',
        content: '(file attached)',
        timestamp: 1_700_000_000,
        _attachedFiles: [{ fileName: 'qr.png', mimeType: 'image/png', fileSize: 1, preview: null, filePath: '/tmp/qr.png' }],
      },
      {
        role: 'user',
        content: 'Process the attached file(s).',
        timestamp: 1_700_000_001,
      },
    ] as const;

    const deduped = dedupeEquivalentAttachmentUserMessages([...messages]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.content).toBe('Process the attached file(s).');
    expect(deduped[0]?._attachedFiles).toHaveLength(1);
  });

  it('dedupes attachment-only placeholder when runtime text includes /think directive', () => {
    const messages = [
      {
        role: 'user',
        content: '(file attached)',
        timestamp: 1_700_000_000,
        _attachedFiles: [{ fileName: 'qr.png', mimeType: 'image/png', fileSize: 1, preview: null, filePath: '/tmp/qr.png' }],
      },
      {
        role: 'user',
        content: '/think off Process the attached file(s).',
        timestamp: 1_700_000_001,
      },
    ] as const;

    const deduped = dedupeEquivalentAttachmentUserMessages([...messages]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?._attachedFiles).toHaveLength(1);
  });

  it('dedupes optimistic user text against gateway echo with working directory metadata', () => {
    const messages = [
      {
        role: 'user',
        content: '这张图是在哪个目录下面',
        timestamp: 1_700_000_000,
        id: 'local-user',
      },
      {
        role: 'user',
        content: '这张图是在哪个目录下面\n\n[Working Directory: C:\\Users\\test\\workspace]',
        timestamp: 1_700_000_001,
        id: 'gateway-user',
      },
    ] as const;

    const deduped = dedupeEquivalentAttachmentUserMessages([...messages]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.content).toBe('这张图是在哪个目录下面');
  });

  it('dedupes repeated send after abort when transcript already contains the user turn', () => {
    const messages = [
      {
        role: 'user',
        content: '这张图是在哪个目录下面',
        timestamp: 1_700_000_000,
        id: 'gateway-user',
      },
      {
        role: 'user',
        content: '这张图是在哪个目录下面',
        timestamp: 1_700_000_120,
        id: 'local-user',
      },
    ] as const;

    const deduped = dedupeEquivalentAttachmentUserMessages([...messages]);
    expect(deduped).toHaveLength(1);
  });

  it('dedupes consecutive user messages with identical text regardless of timestamp gap', () => {
    const messages = [
      {
        role: 'user',
        content: '这张图是什么类型的图片',
        timestamp: 1_700_000_000,
        id: 'gateway-user',
      },
      {
        role: 'user',
        content: '这张图是什么类型的图片',
        timestamp: 1_700_000_300,
        id: 'local-user',
      },
    ] as const;

    const deduped = dedupeConsecutiveEquivalentUserMessages([...messages]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.content).toBe('这张图是什么类型的图片');
  });

  it('keeps same user text when attached files differ', () => {
    const messages = [
      {
        role: 'user',
        content: '/think medium 这个呢',
        timestamp: 1_700_000_000,
        id: 'resume-a',
        _attachedFiles: [
          {
            fileName: '刁荣琦算法-3年.pdf',
            mimeType: 'application/pdf',
            fileSize: 1,
            preview: null,
            filePath: 'C:\\Users\\test\\刁荣琦算法-3年.pdf',
          },
        ],
      },
      {
        role: 'user',
        content: '/think medium 这个呢',
        timestamp: 1_700_000_120,
        id: 'resume-b',
        _attachedFiles: [
          {
            fileName: '谢皓杰-简历原件.pdf',
            mimeType: 'application/pdf',
            fileSize: 1,
            preview: null,
            filePath: 'C:\\Users\\test\\谢皓杰-简历原件.pdf',
          },
        ],
      },
    ] as const;

    const deduped = dedupeConsecutiveEquivalentUserMessages([...messages]);
    expect(deduped).toHaveLength(2);
  });

  it('keeps repeated user questions separated by an assistant reply', () => {
    const messages = [
      { role: 'user', content: 'hello', timestamp: 1 },
      { role: 'assistant', content: 'hi', timestamp: 2 },
      { role: 'user', content: 'hello', timestamp: 3 },
    ] as const;

    const deduped = dedupeConsecutiveEquivalentUserMessages([...messages]);
    expect(deduped).toHaveLength(3);
  });

  it('still rejects unrelated user messages', () => {
    const optimistic = { role: 'user', content: 'run github1', timestamp: 1_700_000_000 } as const;
    const candidate = {
      role: 'user',
      content: '[Wed 2026-04-22 10:30 GMT+8] completely different text',
      timestamp: 1_700_000_000,
    } as const;

    expect(matchesOptimisticUserMessage(candidate, optimistic, 1_700_000_000_000)).toBe(false);
  });

  it('keeps attachment-only turns with different files separated by an assistant reply', () => {
    const messages = [
      {
        role: 'user',
        content: '(file attached)',
        timestamp: 1_700_000_000,
        _attachedFiles: [{
          fileName: '谢皓杰-简历原件.pdf',
          mimeType: 'application/pdf',
          fileSize: 1,
          preview: null,
          filePath: 'C:\\Users\\test\\media\\谢皓杰-简历原件.pdf',
        }],
      },
      {
        role: 'assistant',
        content: 'analysis for resume A',
        timestamp: 1_700_000_030,
      },
      {
        role: 'user',
        content: '(file attached)',
        timestamp: 1_700_000_120,
        _attachedFiles: [{
          fileName: '赵展-简历原件.pdf',
          mimeType: 'application/pdf',
          fileSize: 1,
          preview: null,
          filePath: 'C:\\Users\\test\\media\\赵展-简历原件.pdf',
        }],
      },
    ] as const;

    const deduped = dedupeEquivalentAttachmentUserMessages([...messages]);
    expect(deduped).toHaveLength(3);
    expect(deduped[0]?._attachedFiles?.[0]?.fileName).toBe('谢皓杰-简历原件.pdf');
    expect(deduped[2]?._attachedFiles?.[0]?.fileName).toBe('赵展-简历原件.pdf');
  });

  it('keeps attachment-only gateway transcript turns when media paths differ', () => {
    const messages = [
      {
        role: 'user',
        content: '/think medium Process the attached file(s).\n[media attached: C:\\Users\\test\\media\\resume-a.pdf (application/pdf) | C:\\Users\\test\\media\\resume-a.pdf]',
        timestamp: 1_700_000_000,
      },
      {
        role: 'assistant',
        content: 'analysis for resume A',
        timestamp: 1_700_000_030,
      },
      {
        role: 'user',
        content: '/think medium Process the attached file(s).\n[media attached: C:\\Users\\test\\media\\resume-b.pdf (application/pdf) | C:\\Users\\test\\media\\resume-b.pdf]',
        timestamp: 1_700_000_120,
      },
    ] as const;

    const deduped = dedupeEquivalentAttachmentUserMessages([...messages]);
    expect(deduped).toHaveLength(3);
    expect(deduped[0]?.content).toContain('resume-a.pdf');
    expect(deduped[2]?.content).toContain('resume-b.pdf');
  });

  it('does not match attachment-only turns with different files even when text is equivalent', () => {
    const first = {
      role: 'user',
      content: '(file attached)',
      timestamp: 1_700_000_000,
      _attachedFiles: [{
        fileName: 'resume-a.pdf',
        mimeType: 'application/pdf',
        fileSize: 1,
        preview: null,
        filePath: 'C:\\Users\\test\\resume-a.pdf',
      }],
    } as const;
    const second = {
      role: 'user',
      content: 'Process the attached file(s).',
      timestamp: 1_700_000_120,
      _attachedFiles: [{
        fileName: 'resume-b.pdf',
        mimeType: 'application/pdf',
        fileSize: 1,
        preview: null,
        filePath: 'C:\\Users\\test\\resume-b.pdf',
      }],
    } as const;

    expect(matchesOptimisticUserMessage(second, first, 1_700_000_000_000)).toBe(false);
  });
});
