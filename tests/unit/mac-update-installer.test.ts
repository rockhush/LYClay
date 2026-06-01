import { describe, expect, it } from 'vitest';
import { buildMacDmgInstallScript } from '@electron/utils/mac-update-installer';

describe('buildMacDmgInstallScript', () => {
  it('mounts the dmg, replaces the app bundle, and relaunches', () => {
    const script = buildMacDmgInstallScript({
      dmgPath: '/Users/test/Library/Application Support/lyclaw/update_123.dmg',
      targetAppPath: '/Applications/LYClaw.app',
      mountPoint: '/Users/test/Library/Application Support/lyclaw/update-mount',
      scriptPath: '/Users/test/Library/Application Support/lyclaw/install-update-123.sh',
    });

    expect(script).toContain("hdiutil attach -nobrowse -quiet -mountpoint");
    expect(script).toContain("find '/Users/test/Library/Application Support/lyclaw/update-mount' -maxdepth 1 -name '*.app'");
    expect(script).toContain("ditto \"$APP\" '/Applications/LYClaw.app'");
    expect(script).toContain("open '/Applications/LYClaw.app'");
  });
});
