import { describe, expect, it } from 'vitest';
import { formatWelcomeDisplayName } from '@/lib/welcome-display-name';

describe('formatWelcomeDisplayName', () => {
  it('drops English prefix before slash and shows last two Chinese chars', () => {
    expect(formatWelcomeDisplayName('Ken/袁益千')).toBe('益千');
  });

  it('shows two-character Chinese names in full', () => {
    expect(formatWelcomeDisplayName('张三')).toBe('张三');
    expect(formatWelcomeDisplayName('Ken/张三')).toBe('张三');
  });

  it('handles empty and plain Chinese names', () => {
    expect(formatWelcomeDisplayName('')).toBe('');
    expect(formatWelcomeDisplayName('  欧阳娜娜  ')).toBe('娜娜');
  });
});
