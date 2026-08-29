import { RouterProvider } from "@tanstack/react-router";

import { router } from "@/app/router";
import { AuthProvider, useAuth } from "@/features/auth/ui/AuthProvider";
import { RelaySessionProvider } from "@/shared/api/RelaySessionProvider";

function AuthenticatedApp() {
  const { canSign } = useAuth();
  return (
    <RelaySessionProvider enabled={canSign}>
      <RouterProvider router={router} />
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
