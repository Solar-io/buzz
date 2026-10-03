import type { JobLabel } from "../lib/workTypes.ts";

/** Deterministic engine and role label, shared by rail, Done and phone strip. */
export function JobSuffix({ job }: { job?: JobLabel | null }) {
  return job ? (
    <>
      {" "}
      → {job.engine ? `${job.engine} ` : ""}
      {job.role}
    </>
  ) : null;
}
