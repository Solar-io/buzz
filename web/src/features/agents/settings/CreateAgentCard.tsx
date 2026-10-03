import type { ReactNode } from "react";
import { Card } from "@/shared/ui/card";

/** Card rhythm shared by the blank-create settings sections. */
export function CreateAgentCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0 overflow-hidden">
      <h3 className="border-b border-border px-4 py-3 text-sm font-semibold">
        {title}
      </h3>
      <div className="space-y-4 p-4">{children}</div>
    </Card>
  );
}
