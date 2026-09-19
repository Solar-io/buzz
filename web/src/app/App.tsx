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
import { HuddleSessionProvider } from "@/features/huddle/HuddleSessionProvider";
import { NativePushRuntime } from "@/shared/platform/NativePush";

function AuthenticatedApp() {
  const { canSign } = useAuth();
  return (
    <RelaySessionProvider enabled={canSign}>
      <NativePushRuntime />
      <ObserverProvider enabled={canSign}>
        {/* Snapshot review (Phase 3 §2.1): bridges timeline snapshot cards to
            the preview dialog's session/admin dependencies. One app-wide
            instance; surfaces that never pass imeta never see a card. */}
        <SnapshotPreviewProvider>
          {/* In-app file viewer: file-typical message links render here
              instead of opening popup windows (which manufacture browser
              chrome in the installed app). One app-wide instance. */}
          <FileViewerProvider relayBase={relayHttpBaseUrl()}>
            {/* Above the router on purpose: ONE huddle call that outlives
                every route change, so it can be docked to the channel it
                started in or floated over everything else. */}
            <HuddleSessionProvider>
              <RouterProvider router={router} />
            </HuddleSessionProvider>
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
