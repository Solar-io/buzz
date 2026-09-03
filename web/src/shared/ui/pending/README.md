# Pending primitives — blocked on Radix packages

Every file in this directory is a finished port of a `desktop/src/shared/ui/`
primitive that **cannot compile until its `@radix-ui` dependency is installed**.

They carry a `.tsx.pending-dep` extension on purpose. TypeScript only pulls
`.ts`/`.tsx`/`.d.ts` out of `include: ["src"]`, Vite never resolves a module
nothing imports, and Biome skips extensions it does not recognise — so the tree
typechecks, builds and lints clean while these sit here, and nothing can
accidentally import a file that would not compile.

They are written for their **final** location, `web/src/shared/ui/`, not for this
directory: their relative imports (`./avatar.css`, `./checkbox.css`) and their
`@/shared/ui/...` imports assume they have been moved up one level.

## Activating them

1. Install the packages (versions match `desktop/package.json`, so pnpm resolves
   a single copy across the workspace):

   ```sh
   pnpm --filter buzz-web add \
     @radix-ui/react-avatar@^1.1.11 \
     @radix-ui/react-checkbox@^1.3.3 \
     @radix-ui/react-context-menu@^2.2.16 \
     @radix-ui/react-dialog@^1.1.15 \
     @radix-ui/react-dropdown-menu@^2.1.16 \
     @radix-ui/react-popover@^1.1.15 \
     @radix-ui/react-switch@^1.2.6 \
     @radix-ui/react-tabs@^1.1.13
   ```

2. Move the files into place and drop this directory:

   ```sh
   cd web/src/shared/ui
   for f in pending/*.tsx.pending-dep; do
     git mv "$f" "$(basename "$f" .pending-dep)"
   done
   git rm pending/README.md
   ```

3. `pnpm -C web typecheck && pnpm -C web build`

## The dismissable-layer constraint

`pnpm-workspace.yaml` pins `@radix-ui/react-dismissable-layer` to `1.1.19` via
`overrides`, because multiple resolved copies each kept their own module-level
saved `<body>` pointer-events style — a modal menu opening a modal dialog left
`pointer-events: none` stuck on `<body>` and froze the app (#1482).

That override is repo-wide, so it already covers `web`. The versions above are
the ones desktop resolves against today, which is what keeps a single copy in the
store. **After installing, verify the pin held:**

```sh
pnpm why @radix-ui/react-dismissable-layer   # expect 1.1.19, one version only
```

If more than one version appears, do not ship it — a dialog opened from a
dropdown will freeze the page.

## Deliberate divergences from the desktop originals

- **No textured surface.** `dialog.tsx` and `popover.tsx` drop desktop's
  `surface="textured"` variant, its `card-texture.css`, and the baked PNG
  assets. Web ships the `default` (and, for dialog, `none`) surfaces only.
- **`checkbox.tsx` has no `motion/react` dependency.** The tick draw is the same
  curve and duration expressed in CSS — see the colocated `../checkbox.css`.
- **`separator.tsx` is already shipped** in `web/src/shared/ui/`, implemented
  without `@radix-ui/react-separator` (the DOM contract is reproduced directly).
  Add `@radix-ui/react-separator@^1.1.8` and swap in desktop's file only if you
  want the wrapper for its own sake; nothing needs it.
