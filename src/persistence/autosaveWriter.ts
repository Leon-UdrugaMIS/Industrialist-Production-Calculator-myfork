import { useFlowStore } from '../stores/useFlowStore';
import { useGlobalSettingsStore } from '../stores/useGlobalSettingsStore';
import { getDataOverrides, saveAutosave } from './idb';
import { serializeCanvas } from './transformer';
import { rotateAutosaveTabId } from './autosaveIdentity';

let writeQueue: Promise<void> = Promise.resolve();
const protectedWriteTargets = new Map<string, string>();
let autosaveWritesBlocked = false;
let startupAutosaveLoadComplete = false;

export function markStartupAutosaveLoadComplete(): void {
  startupAutosaveLoadComplete = true;
}

export function preserveAutosaveAfterLoadFailure(tabId: string): boolean {
  if (protectedWriteTargets.has(tabId)) return !autosaveWritesBlocked;

  const replacementId = rotateAutosaveTabId();
  if (replacementId === tabId || (replacementId === 'latest' && tabId !== 'latest')) {
    autosaveWritesBlocked = true;
    return false;
  }

  protectedWriteTargets.set(tabId, replacementId);
  return true;
}

export interface AutosaveSnapshotVersion {
  nodes: ReturnType<typeof useFlowStore.getState>['nodes'];
  edges: ReturnType<typeof useFlowStore.getState>['edges'];
  settings: ReturnType<typeof useGlobalSettingsStore.getState>;
}

export function saveCurrentAutosave(tabId: string): Promise<AutosaveSnapshotVersion> {
  const write = writeQueue.then(async () => {
    if (!startupAutosaveLoadComplete) {
      throw new Error(
        'Autosave cannot be written until the existing startup save has been checked.',
      );
    }
    if (autosaveWritesBlocked) {
      throw new Error(
        'Autosave is paused because this browser could not create a separate slot for the preserved save.',
      );
    }
    const flow = useFlowStore.getState();
    const settings = useGlobalSettingsStore.getState();
    const overrides = await getDataOverrides();
    const targetId = protectedWriteTargets.get(tabId) ?? tabId;
    await saveAutosave(serializeCanvas(flow.nodes, flow.edges, overrides), targetId);
    return { nodes: flow.nodes, edges: flow.edges, settings };
  });

  writeQueue = write.then(
    () => undefined,
    () => undefined,
  );
  return write;
}
