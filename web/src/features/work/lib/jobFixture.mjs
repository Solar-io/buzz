/** Raw job wire fixtures for the Work unit suites. */
export function jobEvent(overrides = {}) {
  const channel = overrides.channel ?? "0f5c1e8a-2b3d-4c5e-8f60-718293a4b5c6";
  const state = overrides.state ?? "running";
  const at = overrides.at ?? 1000;
  const jobId = overrides.jobId ?? "j1";
  return {
    id: overrides.id ?? `${jobId}-${at}`,
    pubkey: overrides.author ?? "aa".repeat(32),
    kind: 30624,
    created_at: at,
    content: overrides.content ?? "",
    tags: [
      ["d", `job:${overrides.dChannel ?? channel}:${jobId}`],
      ["h", channel],
      ...(overrides.role === null ? [] : [["role", overrides.role ?? "coder"]]),
      ["state", state],
      ["started", String(overrides.started ?? 900)],
      ...((state !== "running" && overrides.ended !== null) ||
      (overrides.ended !== undefined && overrides.ended !== null)
        ? [["ended", String(overrides.ended ?? at)]]
        : []),
      ...(overrides.model === undefined ? [] : [["model", overrides.model]]),
      ...(overrides.title === undefined ? [] : [["title", overrides.title]]),
      ...(overrides.turn === undefined ? [] : [["turn", overrides.turn]]),
      ...(overrides.trigger === undefined
        ? []
        : [["e", overrides.trigger, "", "trigger"]]),
      ...(overrides.reason === undefined ? [] : [["reason", overrides.reason]]),
      ...(overrides.extra ?? []),
    ],
  };
}
