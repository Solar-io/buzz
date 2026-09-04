import { Shield, ShieldCheck, User } from "lucide-react";

import { cn } from "@/shared/lib/cn";

import type { CommunityRole } from "../lib/members.ts";

const ROLE_LABEL: Record<CommunityRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

/**
 * The role pill.
 *
 * Colour is not the only channel — the word is always present — because the
 * difference between an admin and a member is exactly the sort of thing a
 * colour-blind reader must not have to infer from a hue.
 */
export function RoleBadge({
  role,
  className,
}: {
  role: CommunityRole;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-medium",
        role === "owner" && "bg-primary/10 text-primary",
        role === "admin" && "bg-blue-500/10 text-blue-500",
        role === "member" && "bg-muted text-muted-foreground",
        className,
      )}
      data-role={role}
      data-testid={`role-badge-${role}`}
    >
      {ROLE_LABEL[role]}
    </span>
  );
}

/** Glyph form, for rows too dense for the pill. */
export function RoleIcon({ role }: { role: CommunityRole }) {
  const label = `${ROLE_LABEL[role]} role`;
  if (role === "owner") {
    return (
      <ShieldCheck
        aria-label={label}
        className="size-4 shrink-0 text-primary"
      />
    );
  }
  if (role === "admin") {
    return (
      <Shield aria-label={label} className="size-4 shrink-0 text-blue-500" />
    );
  }
  return (
    <User
      aria-label={label}
      className="size-4 shrink-0 text-muted-foreground"
    />
  );
}

export { ROLE_LABEL };
