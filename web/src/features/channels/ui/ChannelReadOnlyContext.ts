import { createContext } from "react";

/** Keeps every composer, including inline thread replies, read-only together. */
export const ChannelReadOnlyContext = createContext(false);
