/**
 * What a Stage showing SAYS: the paragraph without its image line and without
 * the markdown punctuation a TTS engine would read aloud ("star star").
 *
 * The attachment half is the huddle's `textWithoutAttachments` (desktop
 * parity: drops the `![image](url)` line for every `imeta` url). This file
 * adds the light markdown stripping Stage needs on top (design §7):
 * `**` / `__` / `*` / `_` emphasis, backticks, headings, and `[t](u)` → `t`.
 * Markdown images that carry no `imeta` are dropped too — a part's paragraph
 * never wants its own URL spoken.
 */

import {
  textWithoutAttachments,
  type SpeechEventLike,
} from "../../huddle/lib/huddleAgentSpeech.ts";

/** Strip markdown punctuation that TTS would otherwise pronounce. Pure. */
export function stripSpeakableMarkdown(text: string): string {
  return (
    text
      // Images first: `![alt](url)` would otherwise become `!alt` below.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      // Links keep their visible text.
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Fenced-code markers and inline backticks.
      .replace(/```[^\n]*\n?/g, "")
      .replace(/`/g, "")
      // Headings / blockquotes at line start.
      .replace(/^[ \t]*(?:#{1,6}|>)[ \t]+/gm, "")
      // Bold / italic markers (paired or stray). Underscores inside words
      // (snake_case) are left alone: only boundary underscores are markup.
      .replace(/\*\*|__/g, "")
      .replace(/\*/g, "")
      .replace(/(^|[\s(])_(?=\S)/g, "$1")
      .replace(/(\S)_(?=$|[\s).,!?;:])/g, "$1")
      // Collapse the whitespace the removals left behind.
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
  );
}

/** Spoken text for one part event: attachments removed, markdown stripped. */
export function speakableText(event: SpeechEventLike): string {
  return stripSpeakableMarkdown(textWithoutAttachments(event));
}
