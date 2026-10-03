import {
  AgentChannelsCard,
  type AgentChannelsProps,
} from "./AgentChannelsCard";

export function AgentChannelsTab(props: AgentChannelsProps) {
  return <AgentChannelsCard {...props} preview={false} />;
}
