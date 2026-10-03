import { nip98Headers } from "../../../shared/lib/nip98.ts";
import { speechServiceUrl } from "../../../shared/lib/relay-url.ts";
import {
  parseLibraryVoices,
  parseVoiceInput,
  type AvailableVoice,
  type LibraryEngine,
  type LibraryVoice,
} from "./voiceLibraryModel.ts";
import { invalidateVoiceLibrary } from "./voiceLibraryRevision.ts";

/** Use the configured speech bridge, including native service configuration. */
export function voiceLibraryUrl(path: string): string {
  return new URL(path, speechServiceUrl("tts")).href;
}

async function responseBody(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : "";
    const messages: Record<number, string> = {
      401: "Sign in again to edit the voice library.",
      403: "Only the voice-library admin may add or remove voices.",
      404: "Voice not found. For ElevenLabs, add it to your ElevenLabs account first.",
      422: "This voice is not usable yet. Choose a trained speech model.",
      502: "The voice provider is unavailable. Try again later.",
      503: "The voice library is unavailable. Try again later.",
    };
    throw new Error(
      `${messages[response.status] ?? `Voice library request failed (${response.status}).`}${detail ? ` ${detail}` : ""}`,
    );
  }
  return body;
}

/** Curated library. Abortable so stale engine loads cannot replace current rows. */
export async function listLibrary(
  engine: LibraryEngine,
  signal?: AbortSignal,
): Promise<LibraryVoice[]> {
  return parseLibraryVoices(
    await responseBody(
      await fetch(voiceLibraryUrl(`/voices/${engine}`), { signal }),
    ),
  );
}

/** Fish: own models without a query, whole public library with a query. */
export async function listAvailable(
  engine: LibraryEngine,
  query = "",
  signal?: AbortSignal,
): Promise<AvailableVoice[]> {
  const q = query.trim().slice(0, 64);
  const url = voiceLibraryUrl(
    `/voices/${engine}/available${q ? `?q=${encodeURIComponent(q)}` : ""}`,
  );
  const body = await responseBody(await fetch(url, { signal }));
  const rows = parseLibraryVoices(body);
  const available = (body as { voices: { id: string; inLibrary?: boolean }[] })
    .voices;
  return rows.map((row) => ({
    ...row,
    inLibrary: available.some(
      (item) => item.id === row.id && item.inLibrary === true,
    ),
  }));
}

/** Sign the exact POST bytes with the existing session's NIP-98 helper. */
export async function addVoice(
  engine: LibraryEngine,
  idOrUrl: string,
): Promise<LibraryVoice[]> {
  const url = voiceLibraryUrl(`/voices/${engine}`);
  const body = JSON.stringify({ id: parseVoiceInput(engine, idOrUrl) });
  const headers = await nip98Headers(url, "POST", { body });
  const voices = parseLibraryVoices(
    await responseBody(await fetch(url, { method: "POST", headers, body })),
  );
  invalidateVoiceLibrary();
  return voices;
}

/** Soft removal: no selection, assignment or device preference is rewritten. */
export async function removeVoice(
  engine: LibraryEngine,
  id: string,
): Promise<LibraryVoice[]> {
  const url = voiceLibraryUrl(
    `/voices/${engine}/${encodeURIComponent(parseVoiceInput(engine, id))}`,
  );
  const headers = await nip98Headers(url, "DELETE");
  const voices = parseLibraryVoices(
    await responseBody(await fetch(url, { method: "DELETE", headers })),
  );
  invalidateVoiceLibrary();
  return voices;
}
