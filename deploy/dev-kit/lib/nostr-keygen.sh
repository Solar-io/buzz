#!/usr/bin/env bash
# ============================================================================
# nostr-keygen.sh — mint a Nostr (secp256k1 x-only) keypair with openssl.
#
# WHY NOT `buzz-admin generate-key`: that needs a full Rust build of the buzz
# workspace, which is minutes on a cold cache and is not available before the
# checkout exists. This needs to work at bootstrap time, on a machine with
# nothing but openssl.
#
# VERIFIED 2026-08-23: a key minted by this script was set as
# BUZZ_RELAY_PRIVATE_KEY on a real relay; the relay's NIP-11 document reported
# `self` equal to the pubkey this script derived. So the derivation matches
# what Buzz itself computes. Evidence: docs/evidence/BUZZ-W1-SMOKE-2026-08-23.md
#
# A Nostr pubkey is the X coordinate only (BIP-340 x-only), which is why the
# leading `04` and the whole Y half of the uncompressed point are dropped.
#
# Prints: "<64-hex secret> <64-hex pubkey>"
# ============================================================================
set -euo pipefail
command -v openssl >/dev/null 2>&1 || { echo "openssl not found" >&2; exit 1; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
openssl ecparam -name secp256k1 -genkey -noout -out "$tmp/k.pem" 2>/dev/null

sec="$(openssl ec -in "$tmp/k.pem" -text -noout 2>/dev/null \
  | awk '/priv:/{f=1;next} /pub:/{f=0} f' | tr -d ' :\n')"
pub="$(openssl ec -in "$tmp/k.pem" -text -noout 2>/dev/null \
  | awk '/pub:/{f=1;next} /ASN1|NIST|Field/{f=0} f' | tr -d ' :\n' \
  | sed 's/^04//' | cut -c1-64)"

# openssl strips leading zero bytes from the private scalar; Nostr wants 32
# bytes. Left-pad rather than regenerate, so the key is stable.
sec="$(printf '%064s' "$sec" | tr ' ' '0')"

[ "${#sec}" -eq 64 ] || { echo "bad secret length ${#sec}" >&2; exit 1; }
[ "${#pub}" -eq 64 ] || { echo "bad pubkey length ${#pub}" >&2; exit 1; }
printf '%s %s\n' "$sec" "$pub"
