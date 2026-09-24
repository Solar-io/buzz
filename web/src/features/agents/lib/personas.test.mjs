import assert from "node:assert/strict";
import { test } from "node:test";
import { mergePersona, personaFromEvent } from "./personas.ts";

function ev(overrides = {}) {
  return {
    id: "b".repeat(64),
    pubkey: "a".repeat(64),
    kind: 30175,
    created_at: 1000,
    tags: [["d", "helper"]],
    content: JSON.stringify({ display_name: "Helper", model: "m1" }),
    sig: "0".repeat(128),
    ...overrides,
  };
}

test("personaFromEvent keeps the raw event", () => {
  const raw = ev();
  const persona = personaFromEvent(raw);
  assert.equal(persona.event, raw);
  assert.equal(persona.id, "helper");
  assert.equal(persona.model, "m1");
  assert.equal(persona.updatedAt, 1000);
});

test("mergePersona: a newer created_at replaces the existing entry", () => {
  const first = mergePersona(new Map(), personaFromEvent(ev()));
  const next = mergePersona(
    first,
    personaFromEvent(
      ev({
        created_at: 1001,
        id: "f".repeat(64),
        content: '{"display_name":"New"}',
      }),
    ),
  );
  assert.equal(next.get("helper").name, "New");
});

test("mergePersona: an older event arriving later is ignored", () => {
  const first = mergePersona(
    new Map(),
    personaFromEvent(ev({ created_at: 2000 })),
  );
  const next = mergePersona(
    first,
    personaFromEvent(
      ev({
        created_at: 1999,
        id: "1".repeat(64),
        content: '{"display_name":"Old"}',
      }),
    ),
  );
  assert.equal(next, first);
  assert.equal(next.get("helper").name, "Helper");
});

test("mergePersona: equal created_at — the lower event id wins, either order", () => {
  const low = personaFromEvent(
    ev({ id: "1".repeat(64), content: '{"display_name":"Low"}' }),
  );
  const high = personaFromEvent(
    ev({ id: "9".repeat(64), content: '{"display_name":"High"}' }),
  );
  assert.equal(
    mergePersona(mergePersona(new Map(), high), low).get("helper").name,
    "Low",
  );
  assert.equal(
    mergePersona(mergePersona(new Map(), low), high).get("helper").name,
    "Low",
  );
});

test("personaFromEvent returns null for wrong kind, missing d, or bad JSON", () => {
  assert.equal(personaFromEvent(ev({ kind: 30177 })), null);
  assert.equal(personaFromEvent(ev({ tags: [] })), null);
  assert.equal(personaFromEvent(ev({ tags: [["d", "  "]] })), null);
  assert.equal(personaFromEvent(ev({ content: "{not json" })), null);
});
