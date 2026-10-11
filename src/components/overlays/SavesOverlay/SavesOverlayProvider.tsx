import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { SavesOverlayContext } from './SavesOverlayContext';
import { createSavesOverlayStore } from './savesOverlayStore';

interface SavesOverlayProviderProps {
  children: ReactNode;
}

export function SavesOverlayProvider({ children }: SavesOverlayProviderProps) {
  const [store] = useState(createSavesOverlayStore);

  useEffect(() => {
    const s = store.getState();
    s.refreshSaves();
    return () => {
      s.clearStatus();
      s.cancelRename();
    };
  }, [store]);

  return <SavesOverlayContext.Provider value={store}>{children}</SavesOverlayContext.Provider>;
}
