/**
 * On app startup: after skills list loads, run batch update detection (check-only)
 * and show a single persistent toast when updates are available.
 */
import { createElement, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { detectUpdatableInstalledSkills } from '@/lib/skill-update-check';
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
        if (updatable.length === 0) return;

        const description = createElement(
          'div',
          { className: 'mt-1 max-h-48 overflow-y-auto pr-1 flex flex-col gap-0.5 text-[12px] leading-5' },
          updatable.map((item) => createElement(
            'div',
            {
              key: item.slug,
              className: 'whitespace-normal break-words',
            },
            item.name,
          )),
        );

        toast.success(t('toast.updatesFound', { count: updatable.length }), {
          description,
          duration: Infinity,
          closeButton: true,
        });
      } catch (error) {
        console.warn('[Startup] Skill update detection failed (silent):', error);
      } finally {
        inFlightRef.current = false;
      }
    })();
  }, [isGatewayReady, skillsLoading, skillsError, t]);
}
