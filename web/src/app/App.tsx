import { RouterProvider } from "@tanstack/react-router";

import { router } from "@/app/router";
import { useZoomShortcuts } from "@/app/useZoomShortcuts";
import { AuthProvider, useAuth } from "@/features/auth/ui/AuthProvider";
import { RelaySessionProvider } from "@/shared/api/RelaySessionProvider";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";
import { ObserverProvider } from "@/features/agents/ObserverProvider";
import { SnapshotPreviewProvider } from "@/features/agents/ui/SnapshotPreviewProvider";
import { UpdatePrompt } from "@/shared/ui/UpdatePrompt";
import { FileViewerProvider } from "@/shared/ui/FileViewerDialog";

function AuthenticatedApp() {
  const { canSign } = useAuth();
  return (
    <RelaySessionProvider enabled={canSign}>
      <ObserverProvider enabled={canSign}>
        {/* Snapshot review (Phase 3 §2.1): bridges timeline snapshot cards to
            the preview dialog's session/admin dependencies. One app-wide
            instance; surfaces that never pass imeta never see a card. */}
        <SnapshotPreviewProvider>
          {/* In-app file viewer: file-typical message links render here
              instead of opening popup windows (which manufacture browser
              chrome in the installed app). One app-wide instance. */}
          <FileViewerProvider relayBase={relayHttpBaseUrl()}>
            <RouterProvider router={router} />
          </FileViewerProvider>
        </SnapshotPreviewProvider>
        <UpdatePrompt />
      </ObserverProvider>
    </RelaySessionProvider>
  );
}

export function App() {
  useZoomShortcuts();
  return (
    <AuthProvider>
      <AuthenticatedApp />
    </AuthProvider>
  );
}
