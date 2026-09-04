/**
 * JSON parsing that REJECTS duplicate object member names at any nesting
 * depth.
 *
 * NIP-AE *Head selection* rule (3) requires this: `{"slug":"core","slug":"x"}`
 * must fail rather than resolve, because a first-wins reader and a last-wins
 * reader would otherwise pick different heads for the same slug and diverge
 * silently. `crates/buzz-core/src/engram.rs` enforces it with a custom serde
 * visitor (`parse_strict_json`).
 *
 * `JSON.parse` cannot do this: it collapses duplicates (last wins) while
 * BUILDING the object, then walks the finished tree with the reviver — so by
 * the time a reviver runs the duplicate is already gone. (Verified: the
 * reviver for `{"a":1,"a":2}` sees the key `a` exactly once.) Hence this
 * hand-rolled recursive-descent parser, which sees every member occurrence.
 *
 * Numbers are grammar-checked before `Number()`. Engram bodies contain no
 * numbers, but a permissive parser here would undercut the strictness this
 * module exists to provide.
 */

export class StrictJsonError extends Error {}

/** Parse `text` as JSON, throwing {@link StrictJsonError} on any violation. */
export function parseStrictJson(text: string): unknown {
  const parser = createParser(text);
  parser.skipWhitespace();
  const value = parser.parseValue();
  parser.skipWhitespace();
  if (!parser.atEnd()) {
    throw new StrictJsonError("trailing data after JSON value");
  }
  return value;
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

/**
 * Recursive-descent parser over `text`.
 *
 * A closure rather than a class: `node --experimental-strip-types` (which
 * runs this repo's `.test.mjs` suite) rejects TypeScript parameter properties
 * in strip-only mode, and a closure sidesteps the question entirely.
 */
function createParser(text: string) {
  let index = 0;

  const atEnd = (): boolean => index >= text.length;

  const skipWhitespace = (): void => {
    while (index < text.length && WHITESPACE.has(text[index])) index += 1;
  };

  const fail = (what: string): never => {
    throw new StrictJsonError(`${what} at position ${index}`);
  };

  const expect = (char: string): void => {
    if (text[index] !== char) fail(`expected ${char}`);
    index += 1;
  };

  const parseEscape = (): string => {
    if (atEnd()) fail("unterminated escape");
    const char = text[index];
    index += 1;
    switch (char) {
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "/":
        return "/";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "u": {
        const hex = text.slice(index, index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("bad \\u escape");
        index += 4;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      default:
        return fail("unknown escape");
    }
  };

  const parseString = (): string => {
    expect('"');
    let out = "";
    for (;;) {
      if (atEnd()) fail("unterminated string");
      const char = text[index];
      if (char === '"') {
        index += 1;
        return out;
      }
      if (char === "\\") {
        index += 1;
        out += parseEscape();
        continue;
      }
      if (char < " ") fail("unescaped control character");
      out += char;
      index += 1;
    }
  };

  const parseNumber = (): number => {
    const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(
      text.slice(index),
    );
    // Thrown inline rather than via `fail`: TypeScript only narrows on a
    // `never`-returning callee when it is a declared function or an
    // explicitly typed const, and an arrow assigned to `const fail` does not
    // qualify — `match` would stay `RegExpExecArray | null` below.
    if (!match) throw new StrictJsonError(`invalid value at position ${index}`);
    index += match[0].length;
    return Number(match[0]);
  };

  const parseObject = (): Record<string, unknown> => {
    expect("{");
    const out: Record<string, unknown> = {};
    const seen = new Set<string>();
    skipWhitespace();
    if (text[index] === "}") {
      index += 1;
      return out;
    }
    for (;;) {
      skipWhitespace();
      const key = parseString();
      if (seen.has(key)) {
        throw new StrictJsonError(`duplicate object member name: ${key}`);
      }
      seen.add(key);
      skipWhitespace();
      expect(":");
      skipWhitespace();
      // defineProperty, not assignment: a literal `__proto__` member must
      // become an own property rather than reassigning the prototype.
      Object.defineProperty(out, key, {
        configurable: true,
        enumerable: true,
        value: parseValue(),
        writable: true,
      });
      skipWhitespace();
      if (text[index] === ",") {
        index += 1;
        continue;
      }
      expect("}");
      return out;
    }
  };

  const parseArray = (): unknown[] => {
    expect("[");
    const out: unknown[] = [];
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return out;
    }
    for (;;) {
      skipWhitespace();
      out.push(parseValue());
      skipWhitespace();
      if (text[index] === ",") {
        index += 1;
        continue;
      }
      expect("]");
      return out;
    }
  };

  function parseValue(): unknown {
    if (atEnd()) fail("unexpected end of input");
    const char = text[index];
    if (char === "{") return parseObject();
    if (char === "[") return parseArray();
    if (char === '"') return parseString();
    if (text.startsWith("true", index)) {
      index += 4;
      return true;
    }
    if (text.startsWith("false", index)) {
      index += 5;
      return false;
    }
    if (text.startsWith("null", index)) {
      index += 4;
      return null;
    }
    return parseNumber();
  }

  return { atEnd, parseValue, skipWhitespace };
}
