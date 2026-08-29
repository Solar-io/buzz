import { createFileRoute, Link } from "@tanstack/react-router";
import { ReposPage } from "@/features/repos/ui/ReposPage";

export const Route = createFileRoute("/repos/browse")({
  component: BrowseRoute,
});

function BrowseRoute() {
  return (
    <div className="min-h-dvh">
      <div className="border-b border-border px-4 py-2">
        <Link
          to="/repos"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Back to channels
        </Link>
      </div>
      <ReposPage />
    </div>
  );
}
