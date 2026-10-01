/**
 * The `/bug` · `/backlog` publish sequence, with its two load-bearing orders:
 *
 * 1. The confirmation row is SIGNED before the item, so the item can name the
 *    row as its source (`["e", <row id>, "", "source"]`) — the row IS where
 *    it was captured, and "Open in channel" lands on it.
 * 2. The item is PUBLISHED before the row, so a refused item never leaves a
 *    row in the channel claiming it was filed. A refused row after an
 *    accepted item is reported, not rolled back: the item exists.
 *
 * Every publish verdict is read — `publish()` resolves `{ok:false}` on a
 * refusal rather than throwing (AGENTS.md, web send-path traps).
 *
 * Signing and the socket are injected, so the orders are testable.
 */

import { type ItemType, itemTemplate } from "./itemEvent.ts";
import { confirmationTemplate, type MessageTemplate } from "./itemMessages.ts";

export interface FileItemDeps<Signed extends { id: string }> {
  sign: (
    template: MessageTemplate & { created_at?: number },
  ) => Promise<Signed>;
  publish: (event: Signed) => Promise<{ ok: boolean; message: string }>;
  newId: () => string;
  nowS: number;
}

export type FileItemOutcome<Signed> =
  | { ok: false; error: string }
  | {
      ok: true;
      d: string;
      head: Signed;
      row: Signed;
      /** The row's verdict: null when it was accepted. */
      rowRefused: string | null;
    };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function fileItem<Signed extends { id: string }>(
  deps: FileItemDeps<Signed>,
  input: {
    type: ItemType;
    title: string;
    channelId: string;
    reporter: string;
    project: { name: string | null; coordinate: string | null } | null;
  },
): Promise<FileItemOutcome<Signed>> {
  const d = deps.newId();
  let row: Signed;
  try {
    row = await deps.sign(
      confirmationTemplate({
        channelId: input.channelId,
        author: input.reporter,
        d,
        type: input.type,
        title: input.title,
      }),
    );
  } catch (error) {
    return { ok: false, error: message(error) };
  }
  const built = itemTemplate(
    {
      d,
      channelId: input.channelId,
      type: input.type,
      status: "open",
      title: input.title,
      summary: null,
      body: "",
      created: deps.nowS,
      reporter: input.reporter,
      owner: null,
      sourceEventId: row.id,
      projectCoordinate: input.project?.coordinate ?? null,
      projectName: input.project?.name ?? null,
    },
    deps.nowS,
    deps.nowS,
  );
  if (!built.ok) {
    return { ok: false, error: `item: ${built.error}` };
  }
  let head: Signed;
  try {
    head = await deps.sign(built.template);
    const filed = await deps.publish(head);
    if (!filed.ok) {
      return {
        ok: false,
        error: filed.message || "The relay refused the item.",
      };
    }
  } catch (error) {
    return { ok: false, error: message(error) };
  }
  let rowRefused: string | null = null;
  try {
    const posted = await deps.publish(row);
    if (!posted.ok) {
      rowRefused = posted.message || "refused";
    }
  } catch (error) {
    rowRefused = message(error);
  }
  return { ok: true, d, head, row, rowRefused };
}
