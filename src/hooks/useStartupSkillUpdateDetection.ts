/**
 * On app startup: after skills list loads, run batch update detection (check-only)
 * for installed skills, then detect newly listed uninstalled skills, and show a
 * single persistent toast when either category has results.
 */
import { createElement, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { StartupSkillNotificationToast } from '@/components/skills/StartupSkillNotificationToast';
import {
  detectNewUninstalledSkills,
  detectUpdatableInstalledSkills,
} from '@/lib/skill-update-check';
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

        if (updatable.length === 0 && newSkills.length === 0) return;

        toast.custom(
          (toastId) => createElement(StartupSkillNotificationToast, {
            toastId,
            title: t('toast.updateReminder'),
            updatable,
            newSkills,
            updatePrefix: t('toast.skillUpdatePrefix'),
            newPrefix: t('toast.skillNewPrefix'),
          }),
          {
            duration: Infinity,
            unstyled: true,
          },
        );
      } catch (error) {
        console.warn('[Startup] Skill update detection failed (silent):', error);
      } finally {
        inFlightRef.current = false;
      }
    })();
  }, [isGatewayReady, skillsLoading, skillsError, t]);
}
