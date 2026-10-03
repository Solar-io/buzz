/** Owner-admin protocol capabilities. Append only after the applier exists. */
export const OWNER_ADMIN_CAPS = [
  "ping",
  "ack.result",
  "requires",
  "fresh",
] as const;
