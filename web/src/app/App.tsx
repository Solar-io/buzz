import { RouterProvider } from "@tanstack/react-router";

import { router } from "@/app/router";
import { AuthProvider, useAuth } from "@/features/auth/ui/AuthProvider";
import { RelaySessionProvider } from "@/shared/api/RelaySessionProvider";
import { ObserverProvider } from "@/features/agents/ObserverProvider";
import { UpdatePrompt } from "@/shared/ui/UpdatePrompt";

function AuthenticatedApp() {
  const { canSign } = useAuth();
  return (
    <RelaySessionProvider enabled={canSign}>
      <ObserverProvider enabled={canSign}>
        <RouterProvider router={router} />
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
