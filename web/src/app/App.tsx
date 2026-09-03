import { RouterProvider } from "@tanstack/react-router";

import { router } from "@/app/router";
import { AuthProvider, useAuth } from "@/features/auth/ui/AuthProvider";
import { RelaySessionProvider } from "@/shared/api/RelaySessionProvider";
import { ObserverProvider } from "@/features/agents/ObserverProvider";
import { SnapshotPreviewProvider } from "@/features/agents/ui/SnapshotPreviewProvider";
import { UpdatePrompt } from "@/shared/ui/UpdatePrompt";

function AuthenticatedApp() {
  const { canSign } = useAuth();
  return (
    <RelaySessionProvider enabled={canSign}>
      <ObserverProvider enabled={canSign}>
        {/* Snapshot review (Phase 3 §2.1): bridges timeline snapshot cards to
            the preview dialog's session/admin dependencies. One app-wide
            instance; surfaces that never pass imeta never see a card. */}
        <SnapshotPreviewProvider>
          <RouterProvider router={router} />
        </SnapshotPreviewProvider>
        <UpdatePrompt />
      </ObserverProvider>
    </RelaySessionProvider>
  );
}

export function App() {
  return (
    <AuthProvider>
      <AuthenticatedApp />
    </AuthProvider>
  );
}
