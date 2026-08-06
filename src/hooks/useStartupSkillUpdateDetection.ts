/**
 * On app startup: after skills list loads, run batch update detection (check-only)
 * for installed skills, then detect newly listed uninstalled skills, and show a
 * single persistent toast only when unseen update/new entries are detected.
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  detectNewUninstalledSkills,
  detectUpdatableInstalledSkills,
} from '@/lib/skill-update-check';
import { showStartupSkillNotificationToast } from '@/lib/show-startup-skill-notification-toast';
import {
  evaluateStartupSkillNotification,
  loadSeenStartupSkillNotificationKeys,
  saveSeenStartupSkillNotificationKeys,
} from '@/lib/startup-skill-notification-seen';
import { useStartupSkillNotificationStore } from '@/lib/startup-skill-notification-state';
import { useGatewayStore } from '@/stores/gateway';
import { useSkillsStore } from '@/stores/skills';

let startupSkillUpdateDetectionDone = false;

export function useStartupSkillUpdateDetection(): void {
  const { t } = useTranslation('skills');
  const isGatewayReady = useGatewayStore(
    (state) => state.status.state === 'running' && state.status.gatewayReady === true,
  );
  const skillsLoading = useSkillsStore((state) => state.loading);
  const skillsError = useSkillsStore((state) => state.error);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!isGatewayReady) return;
    if (skillsLoading) return;
    if (skillsError) return;
    if (startupSkillUpdateDetectionDone || inFlightRef.current) return;

    inFlightRef.current = true;
    startupSkillUpdateDetectionDone = true;

    void (async () => {
      try {
        const updatable = await detectUpdatableInstalledSkills();
        const newSkills = detectNewUninstalledSkills();

        useStartupSkillNotificationStore.getState().setPending(updatable, newSkills);

        const seenKeys = loadSeenStartupSkillNotificationKeys();
        const { shouldShow, nextSeenKeys } = evaluateStartupSkillNotification(
          updatable,
          newSkills,
          seenKeys,
        );

        if (!shouldShow) return;

        saveSeenStartupSkillNotificationKeys(nextSeenKeys);
        showStartupSkillNotificationToast({ updatable, newSkills }, t);
      } catch (error) {
        console.warn('[Startup] Skill update detection failed (silent):', error);
      } finally {
        inFlightRef.current = false;
      }
    })();
  }, [isGatewayReady, skillsLoading, skillsError, t]);
}
