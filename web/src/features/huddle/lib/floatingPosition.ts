/**
 * Where the floating huddle panel sits, and how it stays reachable.
 *
 * Two rules, both earned by every draggable panel ever shipped:
 *
 *  CLAMP ON READ, NOT ONLY ON DRAG. A position saved on a 2560px monitor
 *  is off-screen on a laptop, and a panel you cannot see is a panel you
 *  cannot close. The stored value is therefore clamped every time it is
 *  loaded against the CURRENT viewport, not only while dragging.
 *
 *  DEFAULT BOTTOM-RIGHT. Derived from the viewport rather than stored, so
 *  the first appearance is correct at any window size.
 *
 * Import-free so `node --test` loads it.
 */

export interface PanelPosition {
  x: number;
  y: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface PanelSize {
  width: number;
  height: number;
}

/** Breathing room kept between the panel and every viewport edge. */
export const PANEL_MARGIN = 16;

export const FLOATING_POSITION_KEY = "buzz.huddle.float.position";

/** Bottom-right, one margin in from each edge. */
export function defaultPanelPosition(
  viewport: Viewport,
  size: PanelSize,
): PanelPosition {
  return clampPanelPosition(
    {
      x: viewport.width - size.width - PANEL_MARGIN,
      y: viewport.height - size.height - PANEL_MARGIN,
    },
    viewport,
    size,
  );
}

/**
 * Keep the panel fully inside the viewport.
 *
 * When the panel is LARGER than the viewport (a small window, a tall
 * panel), the lower bound would exceed the upper one; the margin wins in
 * that case, which pins the panel's top-left corner on screen rather than
 * pushing its title bar off the top.
 */
export function clampPanelPosition(
  position: PanelPosition,
  viewport: Viewport,
  size: PanelSize,
): PanelPosition {
  const maxX = viewport.width - size.width - PANEL_MARGIN;
  const maxY = viewport.height - size.height - PANEL_MARGIN;
  return {
    x: Math.round(
      Math.min(
        Math.max(position.x, PANEL_MARGIN),
        Math.max(PANEL_MARGIN, maxX),
      ),
    ),
    y: Math.round(
      Math.min(
        Math.max(position.y, PANEL_MARGIN),
        Math.max(PANEL_MARGIN, maxY),
      ),
    ),
  };
}

export interface PanelPositionStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/**
 * The remembered position, clamped to this viewport — or the default when
 * nothing is stored or the stored value is unusable.
 */
export function loadPanelPosition(
  store: PanelPositionStore | null,
  viewport: Viewport,
  size: PanelSize,
): PanelPosition {
  if (store === null) {
    return defaultPanelPosition(viewport, size);
  }
  let raw: string | null = null;
  try {
    raw = store.getItem(FLOATING_POSITION_KEY);
  } catch {
    return defaultPanelPosition(viewport, size);
  }
  if (raw === null) {
    return defaultPanelPosition(viewport, size);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultPanelPosition(viewport, size);
  }
  if (parsed === null || typeof parsed !== "object") {
    return defaultPanelPosition(viewport, size);
  }
  const record = parsed as { x?: unknown; y?: unknown };
  if (
    typeof record.x !== "number" ||
    typeof record.y !== "number" ||
    !Number.isFinite(record.x) ||
    !Number.isFinite(record.y)
  ) {
    return defaultPanelPosition(viewport, size);
  }
  return clampPanelPosition({ x: record.x, y: record.y }, viewport, size);
}

export function savePanelPosition(
  store: PanelPositionStore | null,
  position: PanelPosition,
): void {
  if (store === null) {
    return;
  }
  try {
    store.setItem(FLOATING_POSITION_KEY, JSON.stringify(position));
  } catch {
    // Position memory is a convenience; the panel still opens without it.
  }
}
