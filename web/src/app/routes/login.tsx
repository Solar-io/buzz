import { createFileRoute } from "@tanstack/react-router";
import { LoginPage } from "@/features/auth/ui/LoginPage";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});
