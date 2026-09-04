/**
 * Classifying what the user pasted into the key box.
 *
 * A direct port of `desktop/src/features/onboarding/lib/keyImportInput.ts`,
 * with one deliberate difference: the desktop defers nsec validation to
 * `nsecToNpub`, which pulls in a signing library. Here the same Bech32
 * machinery already needed for `ncryptsec` also answers for `nsec`, so this
 * module stays import-free and `node --test` can load it.
 *
 * `ncryptsec1…` is a NIP-49 encrypted backup: no npub preview is possible (the
 * pubkey is inside the ciphertext) and a passphrase is required. Password
 * validation happens at decrypt time; everything here is the
 * password-independent structural check that decides when the form may switch
 * modes on its own.
 */

export type KeyImportKind = "nsec" | "ncryptsec" | "unknown";

const NCRYPTSEC_HRP = "ncryptsec";
const NSEC_HRP = "nsec";
const NIP49_VERSION = 2;
const NIP49_PAYLOAD_BYTES = 91;
const NSEC_PAYLOAD_BYTES = 32;
/** Current NIP-49 payloads encode to 162 characters including the checksum. */
export const NCRYPTSEC_ENCODED_LENGTH = 162;
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_GENERATORS = [
  0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
] as const;

function bech32Polymod(values: readonly number[]): number {
  let checksum = 1;
  for (const value of values) {
    const high = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let index = 0; index < BECH32_GENERATORS.length; index += 1) {
      if ((high >>> index) & 1) checksum ^= BECH32_GENERATORS[index];
    }
  }
  return checksum >>> 0;
}

function expandBech32Hrp(hrp: string): number[] {
  return [
    ...Array.from(hrp, (character) => character.charCodeAt(0) >>> 5),
    0,
    ...Array.from(hrp, (character) => character.charCodeAt(0) & 31),
  ];
}

function convertFiveBitWordsToBytes(words: readonly number[]): number[] | null {
  let accumulator = 0;
  let bitCount = 0;
  const bytes: number[] = [];

  for (const word of words) {
    accumulator = (accumulator << 5) | word;
    bitCount += 5;
    while (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((accumulator >>> bitCount) & 0xff);
    }
  }

  // Bech32 conversion without padding permits fewer than five zero remainder
  // bits. Any larger or non-zero remainder is not a canonical byte encoding.
  if (bitCount >= 5 || ((accumulator << (8 - bitCount)) & 0xff) !== 0) {
    return null;
  }
  return bytes;
}

/** Decode a Bech32 string to its payload bytes, or null if it is not valid. */
function bech32Payload(input: string, hrp: string): number[] | null {
  const trimmed = input.trim();
  if (trimmed !== trimmed.toLowerCase() && trimmed !== trimmed.toUpperCase()) {
    return null;
  }
  const normalized = trimmed.toLowerCase();
  const separatorIndex = normalized.lastIndexOf("1");
  if (
    separatorIndex !== hrp.length ||
    normalized.slice(0, separatorIndex) !== hrp
  ) {
    return null;
  }
  const encoded = normalized.slice(separatorIndex + 1);
  const words = Array.from(encoded, (character) =>
    BECH32_CHARSET.indexOf(character),
  );
  if (words.some((word) => word < 0) || words.length <= 6) return null;
  if (bech32Polymod([...expandBech32Hrp(hrp), ...words]) !== 1) return null;
  return convertFiveBitWordsToBytes(words.slice(0, -6));
}

export function classifyKeyImportInput(input: string): KeyImportKind {
  const trimmed = input.trim();
  // Case-insensitive on the HRP to match the Rust classifier: an uppercase
  // valid backup routes to the encrypted path (and decodes there); mixed case
  // routes there too and fails with the accurate error.
  if (trimmed.slice(0, 10).toLowerCase() === "ncryptsec1") return "ncryptsec";
  if (trimmed.toLowerCase().startsWith("nsec1")) return "nsec";
  return "unknown";
}

/**
 * Password-independent NIP-49 validation used for the automatic UI transition.
 * A candidate must have canonical casing and length, a valid Bech32 checksum,
 * and the current 91-byte/version-2 NIP-49 payload shape.
 */
export function isPlausibleNcryptsec(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed.length !== NCRYPTSEC_ENCODED_LENGTH) return false;
  const payload = bech32Payload(trimmed, NCRYPTSEC_HRP);
  return (
    payload?.length === NIP49_PAYLOAD_BYTES && payload[0] === NIP49_VERSION
  );
}

/** A structurally valid `nsec1…`: Bech32 checksum plus a 32-byte payload. */
export function isPlausibleNsec(input: string): boolean {
  return bech32Payload(input, NSEC_HRP)?.length === NSEC_PAYLOAD_BYTES;
}

/**
 * Whether the import form's submit should be enabled.
 * nsec: must decode. ncryptsec: plausible blob AND a non-empty passphrase.
 */
export function keyImportSubmitEnabled(
  input: string,
  passphrase: string,
): boolean {
  const kind = classifyKeyImportInput(input);
  if (kind === "ncryptsec") {
    return isPlausibleNcryptsec(input) && passphrase.length > 0;
  }
  return isPlausibleNsec(input);
}
