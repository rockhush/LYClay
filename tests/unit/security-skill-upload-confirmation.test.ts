import { describe, expect, it } from 'vitest';
import { SkillUploadConfirmationStore } from '@electron/security/skill-upload-confirmation';

describe('skill upload confirmation store', () => {
  it('consumes a matching token only once', () => {
    const store = new SkillUploadConfirmationStore();
    const token = store.create('safe-skill.zip', 'digest-a');

    expect(store.consume(token, 'safe-skill.zip', 'digest-a')).toBe(true);
    expect(store.consume(token, 'safe-skill.zip', 'digest-a')).toBe(false);
  });

  it('rejects a token when the uploaded ZIP changes', () => {
    const store = new SkillUploadConfirmationStore();
    const token = store.create('safe-skill.zip', 'digest-a');

    expect(store.consume(token, 'safe-skill.zip', 'digest-b')).toBe(false);
  });

  it('rejects an expired token', () => {
    let now = 100;
    const store = new SkillUploadConfirmationStore(50, () => now);
    const token = store.create('safe-skill.zip', 'digest-a');
    now = 151;

    expect(store.consume(token, 'safe-skill.zip', 'digest-a')).toBe(false);
  });
});
