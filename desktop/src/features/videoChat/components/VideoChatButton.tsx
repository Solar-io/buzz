import { Video } from "lucide-react";
import * as React from "react";

import { Button } from "@/shared/ui/button";

import { VideoChatPanel } from "./VideoChatPanel";

/**
 * The camera button for agent DMs — mounts the video-chat panel for the
 * agent on the other side of the conversation.
 */
export function VideoChatButton(props: {
  channelId: string;
  agentPubkey: string;
  agentName?: string | null;
  renderMode?: "button" | "menu-item";
}) {
  const { channelId, agentPubkey, agentName, renderMode = "button" } = props;
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Start video chat"
        onClick={() => setOpen(true)}
      >
        <Video className="size-4" />
        {renderMode === "button" ? "Video" : null}
      </Button>
      {open && (
        <VideoChatPanel
          channelId={channelId}
          agentPubkey={agentPubkey}
          agentName={agentName}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
