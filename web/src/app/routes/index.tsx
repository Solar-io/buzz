import { createFileRoute, Navigate } from "@tanstack/react-router";

/** "/" is the relay's NIP-11/info endpoint — the app itself lives at /repos. */
export const Route = createFileRoute("/")({
  component: () => <Navigate to="/repos" />,
});
