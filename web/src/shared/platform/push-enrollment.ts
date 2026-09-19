import type { NativePushPlugin } from "./native.ts";
import {
  delegateTranscript,
  enrollTranscript,
  revokeTranscript,
  rotateTranscript,
  renewTranscript,
  transcriptHash,
  type GatewayChallenge,
  type PushSubscription,
} from "./push-wire.ts";

export interface PushLeaseEvent {
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
}
export interface PushEnrollmentOptions {
  relayUrl: string;
  gatewayUrl: string;
  profile: "buzz-capacitor-ios-sandbox" | "buzz-capacitor-ios-production";
  pubkey: string;
  plugin: NativePushPlugin;
  publish(event: PushLeaseEvent): Promise<{ ok: boolean; message?: string }>;
  encrypt(peer: string, plaintext: string): Promise<{ ciphertext: string }>;
  fetch?: typeof fetch;
  now?: () => number;
}
interface LeaseState {
  v: 1;
  handle: string;
  keyId: string;
  token: string;
  epoch: number;
  generation: number;
  createdAt: number;
  installationExpires: number;
  leaseExpires: number;
  enabled: boolean;
  desired: boolean;
  relayKey: string;
  executorKey: string;
  subscriptions: PushSubscription[];
  pending?: { event: PushLeaseEvent; active: boolean; expires: number };
  revokePending?: boolean;
}
export interface PushEnrollmentStatus {
  enabled: boolean;
  expiresAt: number | null;
  pending: boolean;
}
type Descriptor = {
  origin: string;
  relayKey: string;
  executorKey: string;
  ttl: number;
};
const locks = new Map<string, Promise<unknown>>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const DAY = 86400;

function origin(value: string, protocols: string[]): string {
  const url = new URL(value);
  if (
    !protocols.includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      "Push requires a secure origin without credentials, path, query or fragment.",
    );
  }
  return url.origin;
}
function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value)
    throw new Error(`Push response lacks ${name}.`);
  return value;
}
function requireNumber(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error(`Invalid push ${name}.`);
  return value as number;
}

/** Existing NIP-PL/APNs handshake, with native custody and encrypted leases.
 * Only explicit enable asks for permission; maintain never re-enables a disabled lease.
 * Persistent pending events are replayed byte-for-byte after an uncertain relay ack.
 */
export function createPushEnrollment(options: PushEnrollmentOptions) {
  const relay = origin(options.relayUrl, ["wss:"]);
  const http = relay.replace(/^wss:/, "https:");
  const gateway = origin(options.gatewayUrl, ["https:"]);
  if (!HEX.test(options.pubkey))
    throw new Error("Push requires the signed-in identity.");
  const scope = `push.v1:${relay}:${options.profile}:${options.pubkey}`;
  const request = options.fetch ?? fetch;
  const now = () => Math.floor((options.now ?? Date.now)() / 1000);

  async function serial<T>(action: () => Promise<T>): Promise<T> {
    const prior = locks.get(scope) ?? Promise.resolve();
    const result = prior.catch(() => {}).then(action);
    locks.set(scope, result);
    try {
      return await result;
    } finally {
      if (locks.get(scope) === result) locks.delete(scope);
    }
  }
  async function read(): Promise<LeaseState | null> {
    const { value } = await options.plugin.readState({ scope });
    if (value === null) return null;
    const state = JSON.parse(value) as LeaseState;
    if (
      state.v !== 1 ||
      !UUID.test(state.handle) ||
      !state.keyId ||
      !Number.isSafeInteger(state.generation) ||
      state.generation < 0 ||
      !Number.isSafeInteger(state.epoch) ||
      state.epoch < 1 ||
      !HEX.test(state.relayKey)
    ) {
      throw new Error(
        "Stored push registration is invalid. It was not discarded.",
      );
    }
    return state;
  }
  const save = (state: LeaseState) =>
    options.plugin.writeState({ scope, value: JSON.stringify(state) });
  async function json(
    url: string,
    init?: RequestInit,
  ): Promise<Record<string, unknown>> {
    const response = await request(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new Error(`Push request failed (HTTP ${response.status}).`);
    const body = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error("Invalid push response.");
    return body;
  }
  const post = (path: string, body: unknown) =>
    json(gateway + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  async function challenge(): Promise<GatewayChallenge> {
    const c = await post("/v1/installations/challenges", { v: 1 });
    const id = requireString(c.challenge_id, "challenge id");
    if (!UUID.test(id)) throw new Error("Invalid push challenge id.");
    const expires = requireNumber(c.expires_at, "challenge expiration");
    if (expires <= now()) throw new Error("Push challenge expired.");
    return {
      challenge_id: id,
      challenge: requireString(c.challenge, "challenge"),
      expires_at: expires,
    };
  }
  async function discover(requireProfile = true): Promise<Descriptor> {
    const document = await json(`${http}/info`, {
      headers: { accept: "application/json" },
    });
    const push = document.push as Record<string, unknown> | undefined;
    if (!push || push.origin !== relay)
      throw new Error("Relay does not advertise push for this origin.");
    const profiles = push.app_profiles as { id: string; transport: string }[];
    if (
      requireProfile &&
      (!Array.isArray(profiles) ||
        !profiles.some(
          (p) => p.id === options.profile && p.transport === "apns",
        ))
    )
      throw new Error("This relay has not enabled the Capacitor push profile.");
    const keys = push.keys as {
      id: string;
      pubkey: string;
      current: boolean;
    }[];
    const key = Array.isArray(keys)
      ? keys.find((k) => k.current === true && HEX.test(k.pubkey))
      : undefined;
    if (!key) throw new Error("Relay has no current push encryption key.");
    const limits = push.limitation as Record<string, unknown>;
    return {
      origin: relay,
      relayKey: key.pubkey,
      executorKey: requireString(key.id, "executor key"),
      ttl: Math.min(
        requireNumber(limits?.max_lease_ttl, "lease lifetime"),
        30 * DAY,
      ),
    };
  }
  async function flush(state: LeaseState): Promise<void> {
    if (!state.pending) return;
    const result = await options.publish(state.pending.event);
    if (!result.ok)
      throw new Error(result.message || "Relay rejected the push lease.");
    state.enabled = state.pending.active;
    state.leaseExpires = state.pending.expires;
    delete state.pending;
    await save(state);
  }
  async function lease(
    state: LeaseState,
    descriptor: Descriptor,
    active: boolean,
    grant?: string,
  ): Promise<void> {
    const expires = active
      ? Math.min(now() + descriptor.ttl, state.installationExpires)
      : now() + descriptor.ttl;
    const plaintext = active
      ? {
          v: 1,
          origin: relay,
          generation: state.generation,
          active: true,
          app_profile: options.profile,
          transport: "apns",
          endpoint: grant,
          subscriptions: state.subscriptions,
        }
      : { v: 1, origin: relay, generation: state.generation, active: false };
    const { ciphertext } = await options.encrypt(
      descriptor.relayKey,
      JSON.stringify(plaintext),
    );
    state.createdAt = Math.max(now(), state.createdAt + 1);
    if (state.createdAt > now() + 60)
      throw new Error("Too many push changes; retry in a minute.");
    state.pending = {
      active,
      expires,
      event: {
        kind: 30350,
        content: ciphertext,
        created_at: state.createdAt,
        tags: [
          ["d", state.handle],
          ["expiration", String(expires)],
          ["exec", descriptor.executorKey],
          ["alt", "push lease"],
        ],
      },
    };
    await save(state);
    await flush(state);
  }
  async function token(wait: boolean): Promise<string> {
    const deadline = Date.now() + (wait ? 10000 : 0);
    do {
      const { token: value } = await options.plugin.apnsToken();
      if (
        value &&
        /^[0-9a-f]+$/.test(value) &&
        value.length % 2 === 0 &&
        value.length <= 1024
      )
        return value;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    } while (Date.now() < deadline);
    throw new Error("APNs registration has not produced a device token.");
  }
  async function create(
    descriptor: Descriptor,
    endpoint: string,
  ): Promise<LeaseState> {
    if (!(await options.plugin.isSupported()).supported)
      throw new Error("App Attest requires a supported physical iPhone.");
    const c = await challenge();
    const { keyId } = await options.plugin.generateKey();
    const expires = now() + descriptor.ttl;
    const { attestation } = await options.plugin.attest({
      keyId,
      clientDataHash: await transcriptHash(
        enrollTranscript(c, keyId, options.profile, endpoint, expires),
      ),
    });
    const result = await post("/v1/installations", {
      v: 1,
      challenge_id: c.challenge_id,
      challenge: c.challenge,
      key_id: keyId,
      attestation,
      app_profile: options.profile,
      endpoint,
      endpoint_epoch: 1,
      expires_at: expires,
    });
    const handle = requireString(
      result.installation_handle,
      "installation handle",
    );
    if (!UUID.test(handle) || result.endpoint_epoch !== 1)
      throw new Error("Invalid push installation response.");
    const state: LeaseState = {
      v: 1,
      handle,
      keyId,
      token: endpoint,
      epoch: 1,
      generation: 0,
      createdAt: 0,
      installationExpires: requireNumber(
        result.expires_at,
        "installation expiration",
      ),
      leaseExpires: 0,
      enabled: false,
      desired: true,
      relayKey: descriptor.relayKey,
      executorKey: descriptor.executorKey,
      subscriptions: [
        { filter: { kinds: [9], "#p": [options.pubkey] }, class: "default" },
      ],
    };
    await save(state);
    return state;
  }
  async function assertion(keyId: string, transcript: string): Promise<string> {
    return (
      await options.plugin.assertKey({
        keyId,
        clientDataHash: await transcriptHash(transcript),
      })
    ).assertion;
  }
  async function renew(
    state: LeaseState,
    descriptor: Descriptor,
    endpoint: string,
  ): Promise<void> {
    await flush(state);
    if (state.revokePending) await revoke(state);
    if (state.installationExpires <= now())
      throw new Error("Push installation expired; re-enrollment is required.");
    if (state.installationExpires - now() < 2 * DAY) {
      const c = await challenge();
      const expires = now() + descriptor.ttl;
      const signed = await assertion(
        state.keyId,
        renewTranscript(c, state.handle, state.epoch, expires),
      );
      const renewed = await post("/v1/installations/renew", {
        v: 1,
        challenge_id: c.challenge_id,
        challenge: c.challenge,
        installation_handle: state.handle,
        endpoint_epoch: state.epoch,
        expires_at: expires,
        assertion: signed,
      });
      if (
        renewed.installation_handle !== state.handle ||
        renewed.endpoint_epoch !== state.epoch ||
        renewed.expires_at !== expires
      )
        throw new Error("Invalid installation renewal response.");
      state.installationExpires = expires;
      await save(state);
    }
    if (state.token !== endpoint) {
      const c = await challenge();
      const signed = await assertion(
        state.keyId,
        rotateTranscript(c, state.handle, state.epoch, endpoint),
      );
      await post("/v1/installations/endpoint", {
        v: 1,
        challenge_id: c.challenge_id,
        challenge: c.challenge,
        installation_handle: state.handle,
        endpoint_epoch: state.epoch,
        new_endpoint_epoch: state.epoch + 1,
        endpoint,
        assertion: signed,
      });
      state.epoch += 1;
      state.token = endpoint;
      await save(state);
    }
    state.generation += 1;
    state.relayKey = descriptor.relayKey;
    state.executorKey = descriptor.executorKey;
    // Burn a generation before the request; a lost response cannot make a
    // retry accidentally reuse a generation the gateway already accepted.
    await save(state);
    const c = await challenge();
    const expires = Math.min(now() + descriptor.ttl, state.installationExpires);
    const notBefore = now();
    const signed = await assertion(
      state.keyId,
      delegateTranscript(
        c,
        state.handle,
        state.epoch,
        state.generation,
        descriptor.relayKey,
        notBefore,
        expires,
      ),
    );
    const grant = await post("/v1/delegations", {
      v: 1,
      challenge_id: c.challenge_id,
      challenge: c.challenge,
      installation_handle: state.handle,
      endpoint_epoch: state.epoch,
      generation: state.generation,
      relay_pubkey: descriptor.relayKey,
      not_before: notBefore,
      expires_at: expires,
      assertion: signed,
    });
    await lease(
      state,
      descriptor,
      true,
      requireString(grant.endpoint_grant, "endpoint grant"),
    );
  }
  async function revoke(state: LeaseState): Promise<void> {
    // A previous revoke may have committed despite a lost response. Burning
    // another generation makes a fresh signed retry safe on either side.
    state.generation += 1;
    await save(state);
    const c = await challenge();
    const signed = await assertion(
      state.keyId,
      revokeTranscript(c, state.handle, state.relayKey, state.generation),
    );
    await post("/v1/delegations/revoke", {
      v: 1,
      challenge_id: c.challenge_id,
      challenge: c.challenge,
      installation_handle: state.handle,
      relay_pubkey: state.relayKey,
      generation: state.generation,
      assertion: signed,
    });
    delete state.revokePending;
    await save(state);
  }
  const statusOf = (s: LeaseState | null): PushEnrollmentStatus => ({
    enabled: Boolean(s?.enabled && s.leaseExpires > now()),
    expiresAt: s?.leaseExpires || null,
    pending: Boolean(s?.pending || s?.revokePending),
  });
  return {
    status: () => serial(async () => statusOf(await read())),
    enable: (subscriptions?: PushSubscription[]) =>
      serial(async () => {
        const d = await discover();
        if (!(await options.plugin.requestAuthorizationAndRegister()).granted)
          throw new Error("Notifications permission was not granted.");
        const endpoint = await token(true);
        const previous = await read();
        const s =
          previous && previous.installationExpires > now()
            ? previous
            : await create(d, endpoint);
        if (previous && previous !== s)
          s.subscriptions = previous.subscriptions;
        s.desired = true;
        if (subscriptions) s.subscriptions = subscriptions;
        await save(s);
        await renew(s, d, endpoint);
        return statusOf(s);
      }),
    maintain: () =>
      serial(async () => {
        const s = await read();
        if (!s) return statusOf(null);
        await flush(s);
        if (s.revokePending) await revoke(s);
        if (!s.desired) return statusOf(s);
        const endpoint = await token(false);
        const d = await discover();
        if (s.installationExpires <= now()) {
          const fresh = await create(d, endpoint);
          fresh.subscriptions = s.subscriptions;
          await renew(fresh, d, endpoint);
          return statusOf(fresh);
        }
        if (s.leaseExpires - now() < DAY || s.token !== endpoint)
          await renew(s, d, endpoint);
        return statusOf(s);
      }),
    disable: () =>
      serial(async () => {
        const s = await read();
        if (!s) return statusOf(null);
        // Never force a failed pending ENABLE through before allowing disable.
        // The new inactive generation supersedes it even if it reached the relay.
        delete s.pending;
        const d = await discover(false);
        s.desired = false;
        s.generation += 1;
        s.revokePending = true;
        await save(s);
        await lease(s, d, false);
        await revoke(s);
        return statusOf(s);
      }),
  };
}
