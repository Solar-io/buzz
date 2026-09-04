/**
 * A YAML-subset reader for workflow definitions.
 *
 * A kind:30620 event carries its workflow definition as raw YAML in the event
 * content (`crates/buzz-sdk/src/builders.rs`, `build_workflow_def`), and the
 * relay parses it with `serde_yaml`. Buzz Desktop reads the same body in its
 * Tauri backend (`serde_yaml`) and in its frontend via the `yaml` npm package.
 * The web client has neither: it is a browser, and adding a dependency is a
 * decision this feature is not entitled to make on its own. So this module
 * reads the subset the workflow schema can actually express.
 *
 * What the schema can express (`crates/buzz-workflow/src/schema.rs`): a
 * top-level mapping of scalars (`name`, `description`, `enabled`), one nested
 * mapping (`trigger`), and one sequence of mappings of scalars (`steps`). The
 * only genuinely open-ended values are step text templates, which the `yaml`
 * writer emits as quoted, block (`|`) or folded (`>`) scalars.
 *
 * Deliberately NOT supported — none of it can appear in a workflow definition,
 * and silently half-supporting it would be worse than reporting a parse error:
 * anchors and aliases, tags, multiple documents, complex keys, nested flow
 * collections, and merge keys. Anything unrecognised surfaces as an `error`
 * rather than a plausible-looking wrong value.
 */

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };

export type YamlParseResult = {
  /** The parsed document, or `null` when `error` is set. */
  value: YamlValue;
  /** Human-readable reason the document could not be read, else `null`. */
  error: string | null;
};

type Line = {
  indent: number;
  content: string;
  /** 1-based source line, for error messages. */
  number: number;
};

class YamlError extends Error {}

const DOCUMENT_MARKER = /^(-{3}|\.{3})\s*$/;

/** Strip an unquoted trailing `# comment` from a line of YAML. */
export function stripComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote === '"') {
      if (char === "\\") {
        index += 1;
      } else if (char === '"') {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (char === "'" && line[index + 1] === "'") {
        index += 1;
      } else if (char === "'") {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(line[index - 1] ?? ""))) {
      return line.slice(0, index);
    }
  }
  return line;
}

/**
 * Index of the `:` that separates a mapping key from its value, or -1.
 *
 * The separator is a colon followed by whitespace or end of line, outside any
 * quoted run — so `filter: 'a == "b:c"'` splits once, at the first colon.
 */
export function findKeySeparator(content: string): number {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quote === '"') {
      if (char === "\\") {
        index += 1;
      } else if (char === '"') {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (char === "'" && content[index + 1] === "'") {
        index += 1;
      } else if (char === "'") {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ":") {
      const next = content[index + 1];
      if (next === undefined || next === " " || next === "\t") {
        return index;
      }
    }
  }
  return -1;
}

/** Decode a double-quoted scalar body (the text between the quotes). */
function decodeDoubleQuoted(body: string): string {
  let out = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== "\\") {
      out += char;
      continue;
    }
    const escaped = body[index + 1];
    index += 1;
    switch (escaped) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case "0":
        out += "\0";
        break;
      case "u": {
        const hex = body.slice(index + 1, index + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new YamlError("bad \\u escape in a double-quoted string");
        }
        out += String.fromCharCode(Number.parseInt(hex, 16));
        index += 4;
        break;
      }
      case undefined:
        throw new YamlError("string ends with a dangling backslash");
      default:
        out += escaped;
    }
  }
  return out;
}

const INTEGER = /^[-+]?\d+$/;
const FLOAT = /^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/;

/** Resolve an unquoted plain scalar to its YAML type. */
export function resolvePlainScalar(raw: string): YamlValue {
  const text = raw.trim();
  if (text === "" || text === "~" || text === "null" || text === "Null") {
    return null;
  }
  if (text === "true" || text === "True") return true;
  if (text === "false" || text === "False") return false;
  // A leading zero is how zero-padded identifiers are written (cron fields,
  // step ids); coercing those to numbers would corrupt them.
  if (INTEGER.test(text) && !/^[-+]?0\d/.test(text)) {
    return Number.parseInt(text, 10);
  }
  if (FLOAT.test(text) && !/^[-+]?0\d/.test(text)) {
    return Number.parseFloat(text);
  }
  return text;
}

/** Parse a flow collection that is empty or a flat list of scalars. */
function parseFlow(text: string): YamlValue {
  if (text === "[]") return [];
  if (text === "{}") return {};
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (inner === "") return [];
    if (inner.includes("[") || inner.includes("{")) {
      throw new YamlError("nested flow collections are not supported");
    }
    return inner.split(",").map((part) => parseScalarText(part.trim()));
  }
  throw new YamlError("flow mappings with entries are not supported");
}

/** Parse a scalar that is fully contained on one line. */
function parseScalarText(text: string): YamlValue {
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return decodeDoubleQuoted(text.slice(1, -1));
  }
  if (text.startsWith("[") || text.startsWith("{")) {
    return parseFlow(text);
  }
  if (text.startsWith("&") || text.startsWith("*") || text.startsWith("!")) {
    throw new YamlError("anchors, aliases and tags are not supported");
  }
  return resolvePlainScalar(text);
}

type Reader = {
  lines: Line[];
  index: number;
  /** Raw source lines, needed verbatim for block scalars. */
  raw: string[];
};

function indentOf(line: string): number {
  let count = 0;
  while (line[count] === " ") count += 1;
  return count;
}

/** True when a raw source line is blank or a whole-line comment. */
function isIgnorable(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

/**
 * Consume a block scalar (`|`, `>`, with optional chomping and explicit
 * indentation) whose header sat on the line at `headerIndex`.
 */
function readBlockScalar(
  reader: Reader,
  header: string,
  parentIndent: number,
  headerRawIndex: number,
): string {
  const match = /^([|>])([+-]?)(\d?)([+-]?)\s*$/.exec(header.trim());
  if (!match) {
    throw new YamlError(`unsupported block scalar header "${header.trim()}"`);
  }
  const folded = match[1] === ">";
  const chomp = match[2] || match[4] || "";
  const explicitIndent = match[3] ? Number.parseInt(match[3], 10) : 0;

  const body: string[] = [];
  let cursor = headerRawIndex + 1;
  let contentIndent = explicitIndent > 0 ? parentIndent + explicitIndent : 0;
  while (cursor < reader.raw.length) {
    const line = reader.raw[cursor];
    if (line.trim() === "") {
      body.push("");
      cursor += 1;
      continue;
    }
    const lineIndent = indentOf(line);
    if (lineIndent <= parentIndent) break;
    if (contentIndent === 0) contentIndent = lineIndent;
    if (lineIndent < contentIndent) break;
    body.push(line.slice(contentIndent));
    cursor += 1;
  }
  // Trailing blank lines belong to the chomping rule, not to the body.
  while (body.length > 0 && body[body.length - 1] === "") body.pop();

  // Re-point the logical line cursor past everything the block consumed.
  while (
    reader.index < reader.lines.length &&
    reader.lines[reader.index].number - 1 < cursor
  ) {
    reader.index += 1;
  }

  let text: string;
  if (folded) {
    text = "";
    for (let i = 0; i < body.length; i += 1) {
      const line = body[i];
      if (i === 0) {
        text = line;
        continue;
      }
      const previous = body[i - 1];
      if (line === "") {
        text += "\n";
      } else if (previous === "") {
        text += line;
      } else if (line.startsWith(" ") || previous.startsWith(" ")) {
        // More-indented lines are kept literally by the folding rules.
        text += `\n${line}`;
      } else {
        text += ` ${line}`;
      }
    }
  } else {
    text = body.join("\n");
  }

  if (chomp === "-") return text;
  if (chomp === "+") return text === "" ? "" : `${text}\n`;
  return text === "" ? "" : `${text}\n`;
}

/**
 * Read a scalar that begins at `first` and may continue onto following,
 * more-indented lines (a folded plain scalar, or a quoted scalar whose closing
 * quote is on a later line). Both are what the `yaml` writer emits when a value
 * exceeds its line width.
 */
function readMultilineScalar(
  reader: Reader,
  first: string,
  parentIndent: number,
): YamlValue {
  const quote = first.startsWith('"')
    ? '"'
    : first.startsWith("'")
      ? "'"
      : null;
  const parts = [first];
  const closed = (text: string): boolean => {
    if (quote === null) return false;
    const body = text.slice(1);
    if (quote === "'") {
      for (let i = 0; i < body.length; i += 1) {
        if (body[i] !== "'") continue;
        if (body[i + 1] === "'") {
          i += 1;
          continue;
        }
        return i === body.length - 1;
      }
      return false;
    }
    for (let i = 0; i < body.length; i += 1) {
      if (body[i] === "\\") {
        i += 1;
        continue;
      }
      if (body[i] === '"') return i === body.length - 1;
    }
    return false;
  };

  if (quote !== null && closed(first)) {
    return parseScalarText(first);
  }
  if (quote === null && !continuesPlainScalar(reader, parentIndent)) {
    return parseScalarText(first);
  }

  while (reader.index < reader.lines.length) {
    const line = reader.lines[reader.index];
    if (line.indent <= parentIndent) break;
    if (quote === null && !isPlainContinuation(line.content)) break;
    reader.index += 1;
    parts.push(line.content);
    if (quote !== null && closed(`${quote}${line.content}`)) break;
  }

  // Flow folding: a line break becomes a space, a blank line a newline.
  let text = parts[0];
  for (let i = 1; i < parts.length; i += 1) {
    if (parts[i] === "") {
      text += "\n";
    } else if (text.endsWith("\n")) {
      text += parts[i];
    } else {
      text += ` ${parts[i]}`;
    }
  }
  if (quote !== null && !closed(text)) {
    throw new YamlError("unterminated quoted string");
  }
  return parseScalarText(text);
}

function isPlainContinuation(content: string): boolean {
  return (
    !content.startsWith("- ") &&
    content !== "-" &&
    findKeySeparator(content) === -1
  );
}

function continuesPlainScalar(reader: Reader, parentIndent: number): boolean {
  const next = reader.lines[reader.index];
  return (
    next !== undefined &&
    next.indent > parentIndent &&
    isPlainContinuation(next.content)
  );
}

function parseValueAfterKey(
  reader: Reader,
  rest: string,
  keyIndent: number,
  rawIndex: number,
): YamlValue {
  if (rest.startsWith("|") || rest.startsWith(">")) {
    return readBlockScalar(reader, rest, keyIndent, rawIndex);
  }
  if (rest !== "") {
    return readMultilineScalar(reader, rest, keyIndent);
  }
  const next = reader.lines[reader.index];
  if (next === undefined) return null;
  if (next.indent > keyIndent) return parseNode(reader, next.indent);
  // A sequence may sit at its key's own indentation.
  if (
    next.indent === keyIndent &&
    (next.content.startsWith("- ") || next.content === "-")
  ) {
    return parseNode(reader, next.indent);
  }
  return null;
}

function parseMapping(reader: Reader, indent: number): YamlValue {
  const map: { [key: string]: YamlValue } = {};
  while (reader.index < reader.lines.length) {
    const line = reader.lines[reader.index];
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new YamlError(`unexpected indentation on line ${line.number}`);
    }
    if (line.content.startsWith("- ") || line.content === "-") break;
    const separator = findKeySeparator(line.content);
    if (separator === -1) {
      throw new YamlError(`line ${line.number} is not a "key: value" pair`);
    }
    const key = parseScalarText(line.content.slice(0, separator).trim());
    if (typeof key !== "string" && typeof key !== "number") {
      throw new YamlError(`unsupported mapping key on line ${line.number}`);
    }
    const rest = line.content.slice(separator + 1).trim();
    const rawIndex = line.number - 1;
    reader.index += 1;
    map[String(key)] = parseValueAfterKey(reader, rest, indent, rawIndex);
  }
  return map;
}

function parseSequence(reader: Reader, indent: number): YamlValue {
  const items: YamlValue[] = [];
  while (reader.index < reader.lines.length) {
    const line = reader.lines[reader.index];
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new YamlError(`unexpected indentation on line ${line.number}`);
    }
    if (!line.content.startsWith("- ") && line.content !== "-") break;
    const rest = line.content === "-" ? "" : line.content.slice(2).trim();
    const rawIndex = line.number - 1;
    if (rest === "") {
      reader.index += 1;
      const next = reader.lines[reader.index];
      items.push(
        next !== undefined && next.indent > indent
          ? parseNode(reader, next.indent)
          : null,
      );
      continue;
    }
    // `- key: value` opens a mapping whose indentation is the column the
    // content starts at, so its sibling keys line up under it.
    const itemIndent = line.indent + (line.content.length - rest.length);
    if (findKeySeparator(rest) !== -1) {
      reader.lines[reader.index] = {
        indent: itemIndent,
        content: rest,
        number: line.number,
      };
      items.push(parseMapping(reader, itemIndent));
      continue;
    }
    reader.index += 1;
    if (rest.startsWith("|") || rest.startsWith(">")) {
      items.push(readBlockScalar(reader, rest, line.indent, rawIndex));
      continue;
    }
    items.push(readMultilineScalar(reader, rest, line.indent));
  }
  return items;
}

function parseNode(reader: Reader, indent: number): YamlValue {
  const line = reader.lines[reader.index];
  if (line === undefined) return null;
  if (line.content.startsWith("- ") || line.content === "-") {
    return parseSequence(reader, indent);
  }
  return parseMapping(reader, indent);
}

/**
 * Read a workflow-definition YAML document.
 *
 * Never throws: an unreadable document resolves to `{ value: null, error }` so
 * one malformed workflow cannot blank the whole list — the same failure posture
 * as the desktop's `parse_definition`, which falls back to an empty object.
 */
export function parseYamlDocument(source: string): YamlParseResult {
  const raw = source.replace(/\r\n?/g, "\n").split("\n");
  const lines: Line[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const text = raw[index];
    if (isIgnorable(text)) continue;
    if (DOCUMENT_MARKER.test(text)) continue;
    if (text.includes("\t") && indentOf(text) === 0 && text.startsWith("\t")) {
      return { value: null, error: "tabs cannot be used for indentation" };
    }
    const stripped = stripComment(text).replace(/\s+$/, "");
    if (stripped.trim() === "") continue;
    lines.push({
      indent: indentOf(stripped),
      content: stripped.trim(),
      number: index + 1,
    });
  }
  if (lines.length === 0) return { value: null, error: null };

  const reader: Reader = { lines, index: 0, raw };
  try {
    const value = parseNode(reader, lines[0].indent);
    if (reader.index < reader.lines.length) {
      const line = reader.lines[reader.index];
      throw new YamlError(`unexpected content on line ${line.number}`);
    }
    return { value, error: null };
  } catch (error) {
    return {
      value: null,
      error: error instanceof Error ? error.message : "could not read YAML",
    };
  }
}

/** The document as a plain object, or `null` when it is not a mapping. */
export function parseYamlMapping(
  source: string,
): { [key: string]: YamlValue } | null {
  const { value } = parseYamlDocument(source);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}
