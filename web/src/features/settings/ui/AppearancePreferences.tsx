import { Eye } from "lucide-react";
import type { ReactNode } from "react";

import {
  conversationDensityStore,
  fontSizeStore,
  linkPreviewStyleStore,
  threadLayoutStore,
  useConversationDensity,
  useFontSize,
  useLinkPreviewStyle,
  useThreadLayout,
} from "../lib/appearanceStore.ts";
import type {
  ConversationDensity,
  FontSize,
  LinkPreviewStyle,
  ThreadLayout,
} from "../lib/appearancePrefs.ts";
import { SegmentedControl } from "./SegmentedControl.tsx";

/**
 * The reading-comfort half of Appearance — the web port of the desktop's
 * `ConversationDisplaySettings`, `LinkPreviewStyleSetting` and
 * `ThreadLayoutSetting` rows (`settings/ui/AppearanceSettingsControls.tsx`).
 *
 * Every row here drives an existing mechanism rather than introducing one:
 *
 *  - Font size and Conversation density set `data-font-size` /
 *    `data-conversation-density` on `<html>`, which `shared/styles/globals.css`
 *    already selects on. The 13 / 14 / 15px contract is the stylesheet's
 *    (`--buzz-type-scale`), not this file's — no component here knows a pixel
 *    value, which is the rule in this repo's CLAUDE.md and the thing that
 *    keeps Cmd +/- zoom working.
 *  - Link previews sets `data-link-preview-style`, which `LinkPreviewCards`
 *    reads to choose its presentation.
 *  - Thread layout sets `data-thread-layout`, which `ThreadPanel` reads to
 *    decide whether it docks beside the channel or covers it.
 *
 * The conversation sample below the first two rows is the point of them: a
 * type scale cannot be judged from the word "Larger". It is built from the
 * same tokens a real message row uses, so choosing an option shows the actual
 * result rather than an illustration of it.
 */

const FONT_SIZE_OPTIONS = [
  { value: "smaller", label: "Smaller" },
  { value: "default", label: "Default" },
  { value: "larger", label: "Larger" },
] as const satisfies readonly { value: FontSize; label: string }[];

const CONVERSATION_DENSITY_OPTIONS = [
  { value: "compact", label: "Compact" },
  { value: "comfortable", label: "Comfy" },
  { value: "spacious", label: "Spacious" },
] as const satisfies readonly { value: ConversationDensity; label: string }[];

const LINK_PREVIEW_STYLE_OPTIONS = [
  { value: "compact", label: "Compact" },
  { value: "rich", label: "Rich" },
] as const satisfies readonly { value: LinkPreviewStyle; label: string }[];

const LINK_PREVIEW_DESCRIPTIONS: Record<LinkPreviewStyle, string> = {
  compact: "Small cards with a thumbnail beside the title.",
  rich: "Large previews with the image above the description.",
};

const THREAD_LAYOUT_OPTIONS = [
  { value: "focus", label: "Focus" },
  { value: "split", label: "Split" },
] as const satisfies readonly { value: ThreadLayout; label: string }[];

const THREAD_LAYOUT_DESCRIPTIONS: Record<ThreadLayout, string> = {
  focus: "Threads open over the channel.",
  split: "Threads open in a side panel next to the channel.",
};

/** One labelled row: description on the left, control on the right. */
function PreferenceRow({
  control,
  description,
  label,
  testId,
}: {
  control: ReactNode;
  description: string;
  label: string;
  testId: string;
}) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 py-2"
      data-testid={testId}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {control}
    </div>
  );
}

/** One sample message, built from the same tokens a real message row uses. */
function PreviewMessage({
  author,
  avatar,
  children,
  timestamp,
}: {
  author: string;
  avatar: string;
  children: ReactNode;
  timestamp: string;
}) {
  return (
    <article className="flex gap-2.5 py-conversation-row">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
        {avatar}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 leading-message-author">
          <span className="text-message font-semibold leading-message-author text-foreground">
            {author}
          </span>
          <span className="text-message-timestamp text-muted-foreground/65">
            {timestamp}
          </span>
        </div>
        <div
          className="mt-conversation-body text-message text-foreground"
          data-testid="conversation-preview-body"
        >
          {children}
        </div>
      </div>
    </article>
  );
}

/**
 * Inert sample of a conversation.
 *
 * It uses `text-message`, `leading-message-author`, `py-conversation-row` and
 * `mt-conversation-body` — the same tokens `MessageRow` uses — so it is a
 * genuine preview rather than a drawing of one. Change the tokens and this
 * follows; hardcode a size here and it would start lying the first time the
 * scale moved.
 */
function ConversationPreview() {
  return (
    <div className="py-2" data-testid="conversation-preview">
      <div
        aria-hidden="true"
        className="relative overflow-hidden rounded-xl border border-border/65 p-4 pr-24"
      >
        <span className="absolute right-3.5 top-3 inline-flex items-center gap-1 text-2xs font-medium text-muted-foreground/55">
          <Eye aria-hidden="true" className="size-3" />
          Preview
        </span>
        <PreviewMessage author="Maya" avatar="M" timestamp="9:41">
          The revised conversation layout is ready to review.
        </PreviewMessage>
        <PreviewMessage author="Theo" avatar="T" timestamp="9:43">
          <p>
            A longer message, so line height and spacing can be compared rather
            than guessed at.
          </p>
          <p className="mt-conversation-paragraph">
            The same rhythm carries through channels, threads and DMs.
          </p>
        </PreviewMessage>
      </div>
    </div>
  );
}

export function AppearancePreferences() {
  const fontSize = useFontSize();
  const density = useConversationDensity();
  const linkPreviewStyle = useLinkPreviewStyle();
  const threadLayout = useThreadLayout();

  return (
    <div
      className="divide-y divide-border"
      data-testid="appearance-preferences"
    >
      <PreferenceRow
        control={
          <SegmentedControl
            legend="Font size"
            onValueChange={fontSizeStore.set}
            optionTestIdPrefix="font-size"
            options={FONT_SIZE_OPTIONS}
            testId="font-size-control"
            value={fontSize}
          />
        }
        description="Applies across conversations and interface text."
        label="Font size"
        testId="font-size-row"
      />
      <PreferenceRow
        control={
          <SegmentedControl
            legend="Conversation density"
            onValueChange={conversationDensityStore.set}
            optionTestIdPrefix="conversation-density"
            options={CONVERSATION_DENSITY_OPTIONS}
            testId="conversation-density-control"
            value={density}
          />
        }
        description="Spacing in conversations and Markdown content."
        label="Conversation density"
        testId="conversation-density-row"
      />
      <ConversationPreview />
      <PreferenceRow
        control={
          <SegmentedControl
            legend="Link previews"
            onValueChange={linkPreviewStyleStore.set}
            optionTestIdPrefix="link-preview-style"
            options={LINK_PREVIEW_STYLE_OPTIONS}
            testId="link-preview-style-control"
            value={linkPreviewStyle}
          />
        }
        description={LINK_PREVIEW_DESCRIPTIONS[linkPreviewStyle]}
        label="Link previews"
        testId="link-preview-style-row"
      />
      <PreferenceRow
        control={
          <SegmentedControl
            legend="Thread layout"
            onValueChange={threadLayoutStore.set}
            optionTestIdPrefix="thread-layout"
            options={THREAD_LAYOUT_OPTIONS}
            testId="thread-layout-control"
            value={threadLayout}
          />
        }
        description={THREAD_LAYOUT_DESCRIPTIONS[threadLayout]}
        label="Thread layout"
        testId="thread-layout-row"
      />
    </div>
  );
}
