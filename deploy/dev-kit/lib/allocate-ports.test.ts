import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  BUZZ_PORT_ROLES,
  DEFAULT_BLOCK_SIZE,
  allocate,
  findFreeBlock,
  takenPorts,
} from './allocate-ports.ts';
import { WHATWG_BAD_PORTS } from '../../../shared/bad-ports.ts';

const dirs: string[] = [];
function write(registry: unknown, indent = 2): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'portreg-'));
  dirs.push(d);
  const f = path.join(d, 'port-registry.json');
  fs.writeFileSync(f, JSON.stringify(registry, null, indent) + '\n');
  return f;
}
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('takenPorts — schema-agnostic, because the registry is not ours', () => {
  test('collects ports under any key name', () => {
    const t = takenPorts({ project_port_blocks: { noet: { primary: 7000, weird_name: 7001 } } });
    expect(t.has(7000)).toBe(true);
    expect(t.has(7001)).toBe(true);
  });

  test('expands declared spans, so bounds-only projects are not walked over', () => {
    const t = takenPorts({ project_port_blocks: { x: { start: 6000, end: 6049 } } });
    expect(t.has(6000)).toBe(true);
    expect(t.has(6025)).toBe(true);
    expect(t.has(6049)).toBe(true);
    expect(t.has(6050)).toBe(false);
  });

  test('recurses through nested objects and arrays', () => {
    const t = takenPorts({ project_port_blocks: { a: { sub: { deep: 8080 } }, b: { list: [9090] } } });
    expect(t.has(8080)).toBe(true);
    expect(t.has(9090)).toBe(true);
  });

  test('ignores non-port numbers and strings', () => {
    const t = takenPorts({ project_port_blocks: { a: { primary: 6000, note: 'x', huge: 999999, zero: 0 } } });
    expect(t.has(999999)).toBe(false);
    expect(t.has(0)).toBe(false);
  });
});

describe('findFreeBlock', () => {
  test('never overlaps an existing block', () => {
    const taken = takenPorts({ project_port_blocks: { 'evie-ui': { start: 6000, end: 6049 } } });
    const a = findFreeBlock(taken);
    expect(a.base).toBeGreaterThanOrEqual(6050);
    for (const p of Object.values(a.ports)) expect(taken.has(p)).toBe(false);
  });

  test('skips a block where even ONE recorded port sits', () => {
    // A single stray port must invalidate the whole block, or two services
    // end up interleaved in one range.
    const taken = takenPorts({ project_port_blocks: { x: { odd: 6137 } } });
    const a = findFreeBlock(taken, { floor: 6100, size: 50 });
    expect(a.base).toBe(6150);
  });

  test('hands out no WHATWG bad port', () => {
    const a = findFreeBlock(new Set(), { floor: 5950, size: 50 });
    for (const p of Object.values(a.ports)) expect(WHATWG_BAD_PORTS).not.toContain(p);
  });

  test('blocks are aligned, so ranges stay readable', () => {
    expect(findFreeBlock(new Set(), { floor: 6013 }).base % DEFAULT_BLOCK_SIZE).toBe(0);
  });

  test('primary and https differ — the :6000/:6001 lesson', () => {
    const a = findFreeBlock(new Set());
    expect(a.ports['primary']).not.toBe(a.ports['https']);
  });

  test('every role gets a port', () => {
    const a = findFreeBlock(new Set());
    for (const r of BUZZ_PORT_ROLES) expect(typeof a.ports[r]).toBe('number');
  });
});

describe('allocate — atomic, idempotent, non-destructive', () => {
  test('patches the registry and returns the block', () => {
    const f = write({ project_port_blocks: { 'evie-ui': { start: 6000, end: 6049 } } });
    const r = allocate(f);
    expect(r.allocated).toBe(true);
    const after = JSON.parse(fs.readFileSync(f, 'utf8'));
    expect(after.project_port_blocks.buzz.primary).toBe(r.ports['primary']);
  });

  test('is IDEMPOTENT and never moves an existing block', () => {
    // Re-running an installer must not relocate a live service's ports.
    const f = write({ project_port_blocks: { buzz: { primary: 1234, https: 1235 } } });
    const r = allocate(f);
    expect(r.allocated).toBe(false);
    expect(r.ports['primary']).toBe(1234);
    expect(JSON.parse(fs.readFileSync(f, 'utf8')).project_port_blocks.buzz.primary).toBe(1234);
  });

  test('preserves every other project untouched', () => {
    const before = { project_port_blocks: { noet: { primary: 7000 }, tallyx: { primary: 7100 } }, other_key: { keep: true } };
    const f = write(before);
    allocate(f);
    const after = JSON.parse(fs.readFileSync(f, 'utf8'));
    expect(after.project_port_blocks.noet).toEqual({ primary: 7000 });
    expect(after.project_port_blocks.tallyx).toEqual({ primary: 7100 });
    expect(after.other_key).toEqual({ keep: true });
  });

  test('leaves a backup', () => {
    const f = write({ project_port_blocks: {} });
    const r = allocate(f);
    expect(r.backup).toBeDefined();
    expect(fs.existsSync(r.backup!)).toBe(true);
  });

  test('--dry-run changes nothing on disk', () => {
    const f = write({ project_port_blocks: { a: { primary: 6000 } } });
    const before = fs.readFileSync(f, 'utf8');
    const r = allocate(f, { dryRun: true });
    expect(r.allocated).toBe(true);
    expect(fs.readFileSync(f, 'utf8')).toBe(before);
  });

  test('the result is valid JSON with the original indentation', () => {
    const f = write({ project_port_blocks: { a: { primary: 6000 } } }, 4);
    allocate(f);
    const txt = fs.readFileSync(f, 'utf8');
    expect(() => JSON.parse(txt)).not.toThrow();
    expect(txt).toContain('\n    "project_port_blocks"');
  });

  test('no temp file is left behind', () => {
    const f = write({ project_port_blocks: {} });
    allocate(f);
    const leftovers = fs.readdirSync(path.dirname(f)).filter((n) => n.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  test('allocating twice across processes cannot double-assign', () => {
    // Second call sees the first's block and returns it rather than picking a
    // new one — which is what makes a re-run of the installer safe.
    const f = write({ project_port_blocks: {} });
    const a = allocate(f);
    const b = allocate(f);
    expect(b.allocated).toBe(false);
    expect(b.ports['primary']).toBe(a.ports['primary']);
  });
});
