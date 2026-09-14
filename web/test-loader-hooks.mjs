// Node test-loader hooks for the web client — the same shape as desktop's
// test-loader-hooks.mjs, trimmed to what web's sources need. The plain
// `node --experimental-strip-types` runner only handles relative `.ts`
// imports with explicit extensions: it cannot resolve the app's `@/` alias,
// transpile `.tsx` (strip-types refuses JSX), or ignore CSS imports.
// Component and hook tests need all three, so the web `test` script boots
// this loader.
//
// The hooks are SYNCHRONOUS on purpose: test-loader.mjs prefers node's
// in-thread registerHooks(), where an async hook's Promise return is read as
// the result object itself (source: undefined → ERR_INVALID_RETURN_PROPERTY_
// VALUE). Everything here is sync anyway (readFileSync, transpileModule).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const srcRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "src",
);

function toFileSpecifier(candidatePath) {
  return path.isAbsolute(candidatePath)
    ? pathToFileURL(candidatePath).href
    : candidatePath;
}

function resolveSourcePath(basePath) {
  // Existence decides, not path.extname — a dotted basename (e.g.
  // `foo.utils`) looks like an extension but still needs resolving.
  if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
    return basePath;
  }
  for (const extension of [".ts", ".tsx", ".js", ".jsx", ".mjs"]) {
    const candidate = `${basePath}${extension}`;
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  for (const extension of [".ts", ".tsx", ".js", ".jsx", ".mjs"]) {
    const candidate = path.join(basePath, `index${extension}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

// A test can install `globalThis.__BUZZ_TEST_MODULE_STUBS__ = { specifier:
// "export ..." }` BEFORE dynamically importing the module under test; every
// import of that exact specifier then resolves to the stub source instead of
// the real module (desktop's static stubModules mechanism, opened up so a
// test can fake a boundary like the relay session provider without a
// mocking framework). Requires the in-thread registerHooks path — on the
// register() fallback the loader thread has its own globalThis and cannot
// see the map, so stubs silently do not apply there.
const STUB_URL_PREFIX = "buzz-web-test-stub:";

// Vite resolves asset imports (`./logo.png`) to a URL at bundle time; node's
// ESM resolver has no such loader. Serve an inert string.
const ASSET_SPECIFIER = /\.(?:png|jpe?g|gif|svg|webp|avif|ico)(?:\?[^/]*)?$/;
const ASSET_URL_PREFIX = "buzz-web-test-asset:";

export function resolve(specifier, context, nextResolve) {
  if (ASSET_SPECIFIER.test(specifier)) {
    return {
      shortCircuit: true,
      url: `${ASSET_URL_PREFIX}${specifier}`,
    };
  }
  const stubs = globalThis.__BUZZ_TEST_MODULE_STUBS__;
  if (stubs && Object.hasOwn(stubs, specifier)) {
    return {
      shortCircuit: true,
      url: `${STUB_URL_PREFIX}${specifier}`,
    };
  }
  if (specifier.startsWith("@/")) {
    const stripped = specifier.slice(2);
    // Preserve explicit extensions; probe the ones the app sources use for
    // extensionless `@/` imports (the bundler tolerates them, node does not).
    const resolved = resolveSourcePath(`${srcRoot}/${stripped}`);
    return nextResolve(
      toFileSpecifier(resolved ?? `${srcRoot}/${stripped}`),
      context,
    );
  }
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    context.parentURL?.startsWith("file:")
  ) {
    // Plain resolution first: explicit extensions and every CJS require
    // (in-thread hooks intercept require() too, and rewriting a CJS
    // specifier to a file:// URL breaks Module._resolveFilename).
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      // Extensionless TS app imports fail plain resolution — the bundler
      // adds the extension, node does not. Probe the extensions ourselves.
      const parentPath = fileURLToPath(context.parentURL);
      const resolved = resolveSourcePath(
        path.resolve(path.dirname(parentPath), specifier),
      );
      if (resolved) {
        return nextResolve(toFileSpecifier(resolved), context);
      }
      throw error;
    }
  }
  return nextResolve(specifier, context);
}

export function load(url, context, nextLoad) {
  if (url.startsWith(ASSET_URL_PREFIX)) {
    return {
      format: "module",
      shortCircuit: true,
      source: 'export default "test-asset";\n',
    };
  }
  if (url.startsWith(STUB_URL_PREFIX)) {
    const specifier = url.slice(STUB_URL_PREFIX.length);
    return {
      format: "module",
      shortCircuit: true,
      source: globalThis.__BUZZ_TEST_MODULE_STUBS__?.[specifier] ?? "",
    };
  }

  // Vite handles side-effect CSS imports at bundle time; node's ESM loader
  // has no CSS support. Serve them as empty modules so components with style
  // imports stay unit-testable.
  if (url.endsWith(".css")) {
    return {
      format: "module",
      shortCircuit: true,
      source: "",
    };
  }

  if (url.endsWith(".tsx")) {
    const source = fs.readFileSync(fileURLToPath(url), "utf8");
    const transpiled = ts.transpileModule(source, {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
      },
      fileName: fileURLToPath(url),
    });
    return {
      format: "module",
      shortCircuit: true,
      source: transpiled.outputText,
    };
  }

  const result = nextLoad(url, context);
  if (result.source != null || result.format === "builtin") {
    return result;
  }
  // The default loader can hand back no bytes for formats it loads natively;
  // in-thread hooks must return the source themselves.
  return {
    format: result.format,
    source: fs.readFileSync(fileURLToPath(url), "utf8"),
    shortCircuit: true,
  };
}
