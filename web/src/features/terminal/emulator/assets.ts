/**
 * Loading the vendored xterm bundle and the terminal font — only on the
 * Terminal page, never in the main bundle (phase-7.md §8). Ported from
 * evie-ui `term-xterm.js` (loadAssets, loadTermFont).
 *
 * The files live under `/assets/vendor/` because the relay only serves files
 * under `/assets/`; the directory names carry the version, because the
 * service worker caches `/assets/*` cache-first and a patched file at an
 * unchanged path would be masked by its stale copy.
 *
 * TWO TIERS. xterm, fit and clipboard are REQUIRED: without them there is no
 * terminal, or one with the wrong grid, or one whose OSC 52 copies vanish —
 * their failure rejects the boot with an honest error. The GPU renderers are
 * OPTIONAL: a renderer is an optimization and may never take the terminal
 * down. A bundle that fails to LOAD must look exactly like one that loaded
 * and refused to START; renderer.ts feature-detects and walks on.
 */

export const XTERM_DIR = "/assets/vendor/xterm-5.5.0";
export const FONT_DIR = "/assets/vendor/nerd-font-1";

export const REQUIRED_SCRIPTS = [
  `${XTERM_DIR}/xterm.js`,
  `${XTERM_DIR}/addon-fit.js`,
  `${XTERM_DIR}/addon-clipboard.js`,
] as const;

/** If you promote either of these into REQUIRED_SCRIPTS, you have re-armed the outage. */
export const OPTIONAL_SCRIPTS = [
  `${XTERM_DIR}/addon-webgl.js`,
  `${XTERM_DIR}/addon-canvas.js`,
] as const;

/**
 * The Nerd Font MONO build: TUIs (herdr, yazi, starship) draw icons at
 * Private Use codepoints the app's JetBrains Mono does not have.
 */
export const TERM_FONT_FAMILY = "JetBrainsMono Nerd Font Mono";
export const TERM_FONT_STACK = `"${TERM_FONT_FAMILY}", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace`;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[data-buzz-term-src="${src}"]`,
    );
    if (existing?.dataset.loaded === "true") {
      resolve();
      return;
    }
    const tag = document.createElement("script");
    tag.src = src;
    tag.dataset.buzzTermSrc = src;
    // Execution order holds across the list, even past a script that failed:
    // the addons need xterm's globals.
    tag.async = false;
    tag.onload = () => {
      tag.dataset.loaded = "true";
      resolve();
    };
    tag.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(tag);
  });
}

function loadStylesheet(href: string) {
  if (document.querySelector(`link[data-buzz-term-href="${href}"]`)) {
    return;
  }
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.buzzTermHref = href;
  document.head.appendChild(link);
}

let assetsPromise: Promise<void> | null = null;

/** Memoized: every caller (and a remount) shares one load. */
export function loadXtermAssets(): Promise<void> {
  if (!assetsPromise) {
    loadStylesheet(`${XTERM_DIR}/xterm.css`);
    // Every tag is created in THIS tick, in this order, which is what
    // `async = false` keys its ordering guarantee off.
    assetsPromise = Promise.all([
      ...REQUIRED_SCRIPTS.map(loadScript),
      ...OPTIONAL_SCRIPTS.map((src) =>
        loadScript(src).catch((error) => {
          console.warn(
            "[term] renderer bundle unavailable — degrading to the next renderer.",
            error,
          );
        }),
      ),
    ]).then(() => undefined);
    // A failed REQUIRED load must be retryable on the next mount.
    assetsPromise.catch(() => {
      assetsPromise = null;
    });
  }
  return assetsPromise;
}

let fontPromise: Promise<void> | null = null;

/**
 * xterm measures ONE character cell at construction and derives every
 * geometry from it, forever. A webfont still in flight gets the FALLBACK
 * measured and every column ends up a fraction off. So: register both
 * weights with `display: block`, await them, and only then construct. A font
 * that fails to load must not take the terminal down — it falls back to the
 * rest of the stack, exactly as CSS would.
 */
export function loadTermFont(sizePx: number): Promise<void> {
  if (fontPromise) {
    return fontPromise;
  }
  const fonts = document.fonts;
  if (!fonts || typeof FontFace !== "function") {
    fontPromise = Promise.resolve();
    return fontPromise;
  }
  const faces = [
    new FontFace(
      TERM_FONT_FAMILY,
      `url("${FONT_DIR}/JetBrainsMonoNerdFontMono-Regular.woff2") format("woff2")`,
      { weight: "400", style: "normal", display: "block" },
    ),
    new FontFace(
      TERM_FONT_FAMILY,
      `url("${FONT_DIR}/JetBrainsMonoNerdFontMono-Bold.woff2") format("woff2")`,
      { weight: "700", style: "normal", display: "block" },
    ),
  ];
  for (const face of faces) {
    fonts.add(face);
  }
  fontPromise = Promise.all(faces.map((face) => face.load()))
    .then(() =>
      Promise.all([
        fonts.load(`${sizePx}px "${TERM_FONT_FAMILY}"`),
        fonts.load(`bold ${sizePx}px "${TERM_FONT_FAMILY}"`),
      ]),
    )
    .then(() => fonts.ready)
    .then(() => undefined)
    .catch(() => undefined);
  return fontPromise;
}
