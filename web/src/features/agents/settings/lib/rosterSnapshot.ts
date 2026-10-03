import type { Profile } from "@/features/channels/hooks";
import type { PersonaDefinition } from "../../lib/personas";
import type { RosterRow } from "../../lib/roster";

/** Browser export is the existing definition snapshot, with this instance's identity.
 * Missing private runtime configuration stays absent; this object is never published.
 */
export function rosterSnapshot(
  row: RosterRow,
  profile?: Profile,
): PersonaDefinition {
  const content = row.persona ? JSON.parse(row.persona.event.content) : {};
  return {
    id: row.pubkey,
    name: row.name,
    systemPrompt: row.systemPrompt,
    model: row.model,
    provider: row.provider,
    runtime: row.persona?.runtime ?? "",
    updatedAt: row.entry.updatedAt,
    event: {
      id: "",
      sig: "",
      kind: 30175,
      pubkey: row.pubkey,
      created_at: row.entry.updatedAt,
      tags: [["d", row.pubkey]],
      content: JSON.stringify({
        ...content,
        display_name: row.name,
        system_prompt: row.systemPrompt,
        model: row.model,
        provider: row.provider,
        ...(row.entry.parallelism !== null
          ? { parallelism: row.entry.parallelism }
          : {}),
        respond_to: row.entry.respondTo,
        respond_to_allowlist: row.entry.respondToAllowlist,
        ...(profile?.avatar ? { avatar_url: profile.avatar } : {}),
      }),
    },
  };
}
