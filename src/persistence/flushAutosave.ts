import { useFlowStore } from '../stores/useFlowStore';
import { useGlobalSettingsStore } from '../stores/useGlobalSettingsStore';
import {
  beginLatestPublicationDeferral,
  endLatestPublicationDeferral,
  publishCurrentAutosaveAsLatest,
  saveCurrentAutosave,
} from './autosaveWriter';
import { getAutosaveTabId } from './autosaveIdentity';

export async function flushAutosave(tabId = getAutosaveTabId()): Promise<void> {
  beginLatestPublicationDeferral();
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const saved = await saveCurrentAutosave(tabId, { deferLatestPublication: true });
      const flowAfter = useFlowStore.getState();
      const settingsAfter = useGlobalSettingsStore.getState();
      if (
        saved.nodes === flowAfter.nodes &&
        saved.edges === flowAfter.edges &&
        saved.settings === settingsAfter
      ) {
        if (saved.publishLatest) {
          const published = await publishCurrentAutosaveAsLatest(tabId, saved.targetId, saved);
          if (!published) continue;
        }
        return;
      }
    }

    throw new Error('The graph kept changing while it was being saved. Please retry the update.');
  } finally {
    endLatestPublicationDeferral();
  }
}
