import { useState } from "react";
import { Check, CornerDownLeft, TriangleAlert } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { sendChannelMessage } from "../hooks.ts";
import type { TimelineMessage } from "../lib/messageBuffer.ts";

/**
 * D-035 decision card: renders the `["card", …]` tag payload of a kind 9
 * message as a tappable question — bold title, body, options with the
 * optional "Recommended" marker on the option's right side, plus
 * type-your-own. One tap publishes an ordinary kind 9 reply (NIP-10 e-tag to
 * the card event) whose content is the option's label verbatim, mentioning
 * the card's author so the answer notifies the asker; a typed answer is the
 * same reply with the typed text. Replies read as plain messages in every
 * client and thread under the card wherever threads render.
 *
 * The card itself is a render-time view of the tag: it never mutates, and a
 * malformed payload never reaches it (messageBuffer falls back to markdown).
 */
export function DecisionCard({ message }: { message: TimelineMessage }) {
  const card = message.card;
  const { session } = useRelaySession();
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "sending" }
    | { phase: "sent"; answer: string }
    | { phase: "error"; answer: string; message: string }
  >({ phase: "idle" });
  const [draft, setDraft] = useState("");

  async function reply(answer: string) {
    if (state.phase === "sending" || state.phase === "sent") {
      return;
    }
    const trimmed = answer.trim();
    if (!trimmed) {
      return;
    }
    setState({ phase: "sending" });
    try {
      // publish() RESOLVES {ok:false} on a relay FAILED or ack timeout —
      // it does not throw. Treating resolution as success rendered a false
      // "You replied" for sends the relay rejected (caught live 9/16); the
      // ok check is what makes the sent state honest.
      const result = await sendChannelMessage(session, {
        channelId: message.channelId,
        content: trimmed,
        mentionPubkeys: [message.authorPubkey],
        // A card that is itself a reply keeps ITS thread root — tagging the
        // card as root made the relay reject the reply ("root tag does not
        // match thread ancestry", caught live 9/16). A card sent as a plain
        // reply carries no root marker, only replyTo — and THAT parent is
        // the root the relay derived for the card. Root messages (both null)
        // become their own root, the ordinary first-reply case.
        threadRef: {
          rootId: message.rootId ?? message.replyToId ?? message.id,
          replyToId: message.id,
        },
      });
      if (!result.ok) {
        setState({
          phase: "error",
          answer: trimmed,
          message: result.message || "relay rejected the reply",
        });
        return;
      }
      setState({ phase: "sent", answer: trimmed });
    } catch (error) {
      setState({
        phase: "error",
        answer: trimmed,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!card) {
    return null;
  }

  return (
    <div
      data-testid="decision-card"
      className="my-1 max-w-xl rounded-xl border bg-muted/20 px-3 py-2.5"
    >
      <p className="text-sm font-bold leading-snug">{card.title}</p>
      {card.body && (
        <p className="mt-1 whitespace-pre-wrap text-sm leading-snug text-muted-foreground">
          {card.body}
        </p>
      )}

      {state.phase === "sent" ? (
        <p
          data-testid="decision-card-sent"
          className="mt-2 flex items-center gap-1.5 text-sm font-medium text-primary"
        >
          <Check className="size-3.5" aria-hidden />
          You replied: {state.answer}
        </p>
      ) : (
        <>
          <div className="mt-2 flex flex-col gap-1.5">
            {card.options.map((option) => (
              <button
                key={option.id}
                type="button"
                data-testid={`decision-card-option-${option.id}`}
                disabled={state.phase === "sending"}
                onClick={() => reply(option.label)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg border bg-background px-3 py-2 text-left text-sm",
                  "transition-colors hover:border-primary/50 hover:bg-primary/5",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                )}
              >
                <span className="min-w-0 flex-1 break-words">
                  {option.label}
                </span>
                {option.recommended === true && (
                  <span
                    data-testid="decision-card-recommended"
                    className="ml-auto shrink-0 rounded bg-accent/50 px-1.5 py-0.5 text-badge font-medium uppercase tracking-wide text-accent-foreground/80"
                  >
                    Recommended
                  </span>
                )}
              </button>
            ))}
          </div>

          <form
            className="mt-1.5 flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              reply(draft);
            }}
          >
            <input
              data-testid="decision-card-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              disabled={state.phase === "sending"}
              placeholder="Or type your own answer…"
              aria-label="Type your own answer"
              maxLength={2000}
              className="h-8 min-w-0 flex-1 rounded-lg border bg-background px-2.5 text-sm outline-none placeholder:text-muted-foreground/60 focus-visible:border-primary/50"
            />
            <button
              type="submit"
              data-testid="decision-card-send"
              disabled={
                state.phase === "sending" || draft.trim().length === 0
              }
              aria-label="Send your own answer"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <CornerDownLeft className="size-4" aria-hidden />
            </button>
          </form>

          {state.phase === "error" && (
            <p
              data-testid="decision-card-error"
              className="mt-1.5 flex items-center gap-1.5 text-xs text-destructive"
            >
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
              Reply failed ({state.message}) — try again.
            </p>
          )}
          {state.phase === "sending" && (
            <p className="mt-1.5 text-xs text-muted-foreground/70">
              Sending…
            </p>
          )}
        </>
      )}
    </div>
  );
}
