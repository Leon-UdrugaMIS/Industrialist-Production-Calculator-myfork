import { useEffect } from 'react';
import { useFlowStore } from '../stores/useFlowStore';
import { useUIStore } from '../stores/useUIStore';
import { useGlobalSettingsStore } from '../stores/useGlobalSettingsStore';
import { getAutosave } from './idb';
import { applySaveSettings, deserializeCanvas } from './transformer';
import { getAutosaveTabId } from './autosaveIdentity';
import {
  markStartupAutosaveLoadComplete,
  preserveAutosaveAfterLoadFailure,
  saveCurrentAutosave,
} from './autosaveWriter';

let startupAutosavePromise: ReturnType<typeof getAutosave> | null = null;

function getStartupAutosave(): ReturnType<typeof getAutosave> {
  startupAutosavePromise ??= getAutosave(getAutosaveTabId());
  return startupAutosavePromise;
}

export function useAutosave(): void {
  useEffect(() => {
    let isMounted = true;
    getStartupAutosave()
      .then(async (record) => {
        if (!isMounted) return;
        if (record && record.data) {
          let canvas: ReturnType<typeof deserializeCanvas>;
          try {
            canvas = deserializeCanvas(record.data);
          } catch (error) {
            const tabId = getAutosaveTabId();
            const preservedSeparateSlot =
              record.id !== tabId || preserveAutosaveAfterLoadFailure(tabId);
            const detail =
              error instanceof Error ? error.message : 'The save data could not be validated.';
            const nextStep = preservedSeparateSlot
              ? 'The original autosave remains unchanged. New changes in this tab will use a separate autosave slot.'
              : 'The original autosave remains unchanged, but this browser could not create a separate slot, so autosaving is paused for this session.';
            await useUIStore.getState().confirm({
              title: 'AUTOSAVE COULD NOT BE LOADED',
              message: `${detail}\n\n${nextStep}`,
              confirmLabel: 'CONTINUE',
              showCancel: false,
              intent: 'error',
            });
            return;
          }

          const currentStore = useFlowStore.getState();
          if (currentStore.nodes.length === 0 && currentStore.edges.length === 0) {
            const { nodes, edges, globalSettings } = canvas;

            if (nodes.length >= 250) {
              const confirmed = await useUIStore.getState().confirm({
                title: 'PERFORMANCE WARNING',
                message: `This autosave contains ${nodes.length} nodes. Loading this graph will degrade graph performance and take a while to load. Continue?`,
                confirmLabel: 'LOAD AUTOSAVE',
                cancelLabel: 'START FRESH',
                intent: 'info',
              });

              if (!confirmed) {
                return;
              }
            }

            currentStore.setNodesAndEdges(nodes, edges, {
              recordHistory: false,
              resetHistory: true,
            });
            applySaveSettings(globalSettings);
          }
        }
      })
      .catch(async (err) => {
        console.warn('Failed to load autosave on startup:', err);
        if (!isMounted) return;
        const tabId = getAutosaveTabId();
        const hasSeparateSlot = preserveAutosaveAfterLoadFailure(tabId);
        const detail = err instanceof Error ? err.message : 'The save data could not be read.';
        await useUIStore.getState().confirm({
          title: 'AUTOSAVE COULD NOT BE READ',
          message: `${detail}\n\n${hasSeparateSlot ? 'The original autosave remains unchanged; future changes will use a separate slot.' : 'The original autosave remains unchanged, but this browser could not create a separate slot, so autosaving is paused for this session.'}`,
          confirmLabel: 'CONTINUE',
          showCancel: false,
          intent: 'error',
        });
      })
      .finally(() => {
        if (!isMounted) return;
        markStartupAutosaveLoadComplete();
        useUIStore.getState().setAutosaveLoaded();
      });

    let dirtyVersion = 0;
    let lastSavedVersion = 0;
    let isSaving = false;
    let autosaveFailureReported = false;

    const unsub = useFlowStore.subscribe(
      (state) => ({ nodes: state.nodes, edges: state.edges }),
      () => {
        dirtyVersion++;
      },
      {
        equalityFn: (prev, next) => prev.nodes === next.nodes && prev.edges === next.edges,
      },
    );

    const unsubGlobalSettings = useGlobalSettingsStore.subscribe(() => {
      dirtyVersion++;
    });

    const saveIfDirty = () => {
      if (dirtyVersion === lastSavedVersion) return;
      if (isSaving) return;

      isSaving = true;
      const capturedVersion = dirtyVersion;
      saveCurrentAutosave(getAutosaveTabId())
        .then(() => {
          autosaveFailureReported = false;
          if (dirtyVersion === capturedVersion) {
            lastSavedVersion = capturedVersion;
          }
        })
        .catch(async (err) => {
          console.warn('Failed to commit autosave interval:', err);
          if (autosaveFailureReported) return;
          autosaveFailureReported = true;
          const detail =
            err instanceof Error ? err.message : 'The current canvas could not be saved.';
          await useUIStore.getState().confirm({
            title: 'AUTOSAVE COULD NOT BE UPDATED',
            message: `${detail}\n\nThe previous autosave remains unchanged. The current canvas changes have not been saved yet; automatic retries will continue.`,
            confirmLabel: 'CONTINUE',
            showCancel: false,
            intent: 'error',
          });
        })
        .finally(() => {
          isSaving = false;
        });
    };

    const intervalId = setInterval(() => {
      if (!document.hidden) saveIfDirty();
    }, 5000);

    const handleBeforeUnload = () => {
      void saveCurrentAutosave(getAutosaveTabId()).catch((err) => {
        console.warn('Failed to commit autosave beforeunload:', err);
      });
    };

    const handleVisibilityChange = () => {
      if (document.hidden) saveIfDirty();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      isMounted = false;
      clearInterval(intervalId);
      unsub();
      unsubGlobalSettings();
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);
}
