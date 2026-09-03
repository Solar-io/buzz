import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { useDesktopCatalogs } from "@/features/agents/useDesktopCatalogs";
import type { ResolvedSnapshotCard } from "@/features/channels/lib/snapshotCard.ts";
import { useAdminCommands } from "./AgentAdminPanel.tsx";
import { SnapshotPreviewDialog } from "./SnapshotPreviewDialog.tsx";

/**
 * Bridge between the deep timeline (MarkdownContent → SnapshotCard) and the
 * preview dialog's session/admin dependencies. The timeline components have
 * no relay-session context of their own; rather than thread `admin` through
 * MarkdownContent's public props (it is a leaf rendering primitive), the
 * page mounts this provider once and cards call `openSnapshotPreview(card)`.
 * Outside a provider (ForumView/SearchPanel, §3.7 recorded gap) the card
 * renders without a Preview button — honest-absent, not a dead button.
 */

const SnapshotPreviewContext = createContext<{
  openSnapshotPreview: (card: ResolvedSnapshotCard, sharedBy?: string) => void;
} | null>(null);

export function useSnapshotPreview():
  | ((card: ResolvedSnapshotCard, sharedBy?: string) => void)
  | null {
  return useContext(SnapshotPreviewContext)?.openSnapshotPreview ?? null;
}

export function SnapshotPreviewProvider({ children }: { children: ReactNode }) {
  const { session, status } = useRelaySession();
  const admin = useAdminCommands(session, status);
  const catalogs = useDesktopCatalogs();
  const [open, setOpen] = useState<{
    card: ResolvedSnapshotCard;
    sharedBy?: string;
  } | null>(null);

  const openSnapshotPreview = useCallback(
    (card: ResolvedSnapshotCard, sharedBy?: string) => {
      setOpen({ card, sharedBy });
    },
    [],
  );
  const contextValue = useMemo(
    () => ({ openSnapshotPreview }),
    [openSnapshotPreview],
  );

  return (
    <SnapshotPreviewContext.Provider value={contextValue}>
      {children}
      {open && (
        <SnapshotPreviewDialog
          card={open.card}
          sharedBy={open.sharedBy}
          admin={admin}
          catalogs={catalogs}
          onClose={() => setOpen(null)}
        />
      )}
    </SnapshotPreviewContext.Provider>
  );
}
