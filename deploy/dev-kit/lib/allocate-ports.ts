#!/usr/bin/env bun
/**
 * ALLOCATE A PORT BLOCK for buzz in infra/port-registry.json.
 *
 * The house rule (AGENTS.md, BUILD_PROMPT.md) is "never GUESS or HARDCODE a new
 * allocation" — not "never allocate". The `new-project` skill spells out the
 * intended operation: *"Read the port registry and allocate the next valid
 * project block without collisions; patch the registry atomically."* This is
 * that, for buzz.
 *
 * Design notes, because the registry's exact schema is not this repo's to know:
 *
 * · **Collision detection is schema-agnostic.** It walks `project_port_blocks`
 *   recursively and treats EVERY integer in 1..65535 it finds as taken,
 *   whatever the key is called. A block shape this file has never seen still
 *   reserves its ports. `start`/`end`/`from`/`to`/`base`/`range` pairs are
 *   additionally expanded as spans, so a project that records only its bounds
 *   is not walked over.
 * · **Never widens.** Only the `buzz` key is added; every other key, and the
 *   file's own ordering, is preserved.
 * · **Refuses to reallocate.** An existing `buzz` block is returned as-is.
 *   Silently moving a live service's ports would be worse than any collision.
 * · **Bad ports are excluded** via shared/bad-ports.ts — the measured WHATWG
 *   list. A block containing one would hand out a port node's own fetch, and
 *   every Chromium browser, refuses to dial.
 * · **Atomic.** Backup, write a temp file in the SAME directory, re-parse it,
 *   then rename. A partial write to this file would break six other projects.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { isBadPort } from '../../../shared/bad-ports.ts';

/** The roles buzz needs, in the order they are assigned from the block base. */
export const BUZZ_PORT_ROLES = [
  'primary',        // relay HTTP, bound to loopback
  'https',          // tailnet front door — MUST differ from primary
  'postgres',
  'redis',
  'minio_api',
  'minio_console',
  'adminer',
  'prometheus',
] as const;

export const DEFAULT_BLOCK_SIZE = 50;   // matches evie-ui's 6000-6049
export const DEFAULT_FLOOR = 6000;
export const MAX_PORT = 65_535;

type Json = Record<string, unknown>;

const SPAN_KEYS: ReadonlyArray<[string, string]> = [
  ['start', 'end'],
  ['from', 'to'],
  ['base', 'last'],
  ['min', 'max'],
];

/** Every port already spoken for, by any project, under any key name. */
export function takenPorts(registry: Json): Set<number> {
  const taken = new Set<number>();
  const blocks = registry['project_port_blocks'];
  const add = (n: unknown) => {
    if (typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= MAX_PORT) taken.add(n);
  };

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }
    if (node === null || typeof node !== 'object') {
      add(node);
      return;
    }
    const obj = node as Json;
    // Expand declared spans, so a project that records only its bounds still
    // reserves everything between them.
    for (const [lo, hi] of SPAN_KEYS) {
      const a = obj[lo];
      const b = obj[hi];
      if (typeof a === 'number' && typeof b === 'number' && b >= a && b - a <= 4096) {
        for (let p = a; p <= b; p++) add(p);
      }
    }
    for (const v of Object.values(obj)) walk(v);
  };

  walk(blocks ?? {});
  return taken;
}

export interface Allocation {
  base: number;
  size: number;
  ports: Record<string, number>;
}

/** Lowest aligned block at or above `floor` that collides with nothing. */
export function findFreeBlock(
  taken: ReadonlySet<number>,
  opts: { size?: number; floor?: number } = {},
): Allocation {
  const size = opts.size ?? DEFAULT_BLOCK_SIZE;
  const floor = opts.floor ?? DEFAULT_FLOOR;
  if (BUZZ_PORT_ROLES.length > size) throw new Error(`block size ${size} cannot hold ${BUZZ_PORT_ROLES.length} roles`);

  // Aligned to `size` so blocks stay human-readable (6000-6049, 6100-6149…).
  const start = Math.ceil(floor / size) * size;
  for (let base = start; base + size - 1 <= MAX_PORT; base += size) {
    let free = true;
    for (let p = base; p < base + size; p++) {
      if (taken.has(p)) { free = false; break; }
    }
    if (!free) continue;
    // Only the ports we will actually hand out must be dialable; a bad port
    // sitting unused inside the block is harmless.
    const ports: Record<string, number> = {};
    let usable = true;
    BUZZ_PORT_ROLES.forEach((role, i) => {
      const p = base + i;
      if (isBadPort(p)) usable = false;
      ports[role] = p;
    });
    if (!usable) continue;
    return { base, size, ports };
  }
  throw new Error('no free aligned port block available');
}

export interface AllocateResult {
  allocated: boolean;   // false ⇒ a buzz block already existed
  ports: Record<string, number>;
  base?: number;
  backup?: string;
}

/** Read → allocate if absent → atomically patch. Idempotent. */
export function allocate(
  registryPath: string,
  opts: { size?: number; floor?: number; dryRun?: boolean } = {},
): AllocateResult {
  const raw = fs.readFileSync(registryPath, 'utf8');
  const registry = JSON.parse(raw) as Json;

  const blocks = (registry['project_port_blocks'] ??= {}) as Json;
  const existing = blocks['buzz'];
  if (existing && typeof existing === 'object') {
    return { allocated: false, ports: existing as Record<string, number> };
  }

  const alloc = findFreeBlock(takenPorts(registry), opts);
  if (opts.dryRun) return { allocated: true, ports: alloc.ports, base: alloc.base };

  blocks['buzz'] = {
    ...alloc.ports,
    _range: `${alloc.base}-${alloc.base + alloc.size - 1}`,
    _allocated_by: 'evie-ui deploy/buzz/lib/allocate-ports.ts',
  };

  // Preserve the file's indentation rather than reformatting six other
  // projects' entries into a diff nobody asked for.
  const indent = /\n(\s+)"/.exec(raw)?.[1]?.length ?? 2;
  const next = JSON.stringify(registry, null, indent) + '\n';

  JSON.parse(next); // never rename something that will not parse

  const backup = `${registryPath}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(registryPath, backup);
  // Temp file in the SAME directory: rename is only atomic within a filesystem.
  const tmp = path.join(path.dirname(registryPath), `.port-registry.${process.pid}.tmp`);
  fs.writeFileSync(tmp, next, { mode: 0o644 });
  fs.renameSync(tmp, registryPath);

  return { allocated: true, ports: alloc.ports, base: alloc.base, backup };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: allocate-ports.ts <port-registry.json> [--dry-run] [--size N] [--floor N]');
    process.exit(2);
  }
  const num = (flag: string): number | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? Number(args[i + 1]) : undefined;
  };
  try {
    const r = allocate(file, {
      dryRun: args.includes('--dry-run'),
      ...(num('--size') !== undefined ? { size: num('--size')! } : {}),
      ...(num('--floor') !== undefined ? { floor: num('--floor')! } : {}),
    });
    console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    console.error(`allocate-ports: ${String(e instanceof Error ? e.message : e)}`);
    process.exit(1);
  }
}
