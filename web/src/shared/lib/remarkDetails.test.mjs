import assert from "node:assert/strict";
import test from "node:test";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import remarkDetails from "./remarkDetails.ts";

function runPlugin(content) {
  let result;
  ReactMarkdown({
    children: content,
    remarkPlugins: [
      remarkGfm,
      remarkDetails,
      () => (tree) => {
        result = JSON.parse(
          JSON.stringify(tree, (key, value) =>
            key === "position" ? undefined : value,
          ),
        );
      },
    ],
  });
  return result;
}

const text = (value) => ({ type: "text", value });
const paragraph = (value) => ({ type: "paragraph", children: [text(value)] });
const details = (label, children, open = false) => ({
  type: "details",
  data: { hName: "details", ...(open ? { hProperties: { open: true } } : {}) },
  children: [
    { type: "summary", data: { hName: "summary" }, children: [text(label)] },
    ...children,
  ],
});
const root = (...children) => ({ type: "root", children });
const list = (...items) => ({
  type: "list",
  ordered: false,
  start: null,
  spread: false,
  children: items.map((value) => ({
    type: "listItem",
    spread: false,
    checked: null,
    children: [paragraph(value)],
  })),
});

test("remarkDetails: blank-line body is a closed details with a markdown list", () => {
  assert.deepEqual(
    runPlugin(
      "before\n\n<details><summary>🌌 Everything else</summary>\n\n- a\n- b\n\n</details>\n\nafter",
    ),
    root(
      paragraph("before"),
      details("🌌 Everything else", [list("a", "b")]),
      paragraph("after"),
    ),
  );
});

test("remarkDetails: single HTML node body is re-parsed as a markdown list", () => {
  assert.deepEqual(
    runPlugin("<details><summary>X</summary>\n- a\n- b\n</details>"),
    root(details("X", [list("a", "b")])),
  );
});

test("remarkDetails: summary on its own line supplies the label", () => {
  assert.deepEqual(
    runPlugin("<details>\n<summary>X</summary>\n- a\n</details>"),
    root(details("X", [list("a")])),
  );
});

test("remarkDetails: summary in the next HTML block supplies the label", () => {
  assert.deepEqual(
    runPlugin("<details>\n\n<summary>X</summary>\n- a\n</details>"),
    root(details("X", [list("a")])),
  );
});

test("remarkDetails: open is the only forwarded HTML attribute", () => {
  assert.deepEqual(
    runPlugin("<details open><summary>X</summary>\n- a\n</details>"),
    root(details("X", [list("a")], true)),
  );
});

test("remarkDetails: a missing closing tag consumes the rest of its parent only", () => {
  assert.deepEqual(
    runPlugin("> <details><summary>X</summary>\n>\n> - a\n>\n> end\n\nafter"),
    root(
      {
        type: "blockquote",
        children: [details("X", [list("a"), paragraph("end")])],
      },
      paragraph("after"),
    ),
  );
});

test("remarkDetails: nests single-node details and closes each level separately", () => {
  assert.deepEqual(
    runPlugin(
      "<details><summary>Outer</summary>\n<details open><summary>Inner</summary>\n- a\n</details>\n</details>\nafter",
    ),
    root(
      details("Outer", [details("Inner", [list("a")], true)]),
      paragraph("after"),
    ),
  );
});

test("remarkDetails: nests details across separate HTML and markdown blocks", () => {
  assert.deepEqual(
    runPlugin(
      "<details><summary>Outer</summary>\n\nbefore\n\n<details><summary>Inner</summary>\n\n- a\n\n</details>\n\nafter\n\n</details>",
    ),
    root(
      details("Outer", [
        paragraph("before"),
        details("Inner", [list("a")]),
        paragraph("after"),
      ]),
    ),
  );
});

test("remarkDetails: fenced and inline code remain literal", () => {
  assert.deepEqual(
    runPlugin(
      "```html\n<details><summary>X</summary>\n- a\n</details>\n```\n\n`<details><summary>X</summary></details>`",
    ),
    root(
      {
        type: "code",
        lang: "html",
        meta: null,
        value: "<details><summary>X</summary>\n- a\n</details>",
      },
      {
        type: "paragraph",
        children: [
          {
            type: "inlineCode",
            value: "<details><summary>X</summary></details>",
          },
        ],
      },
    ),
  );
});

test("remarkDetails: closing tags inside a body fence cannot end the details", () => {
  assert.deepEqual(
    runPlugin(
      "<details><summary>X</summary>\n```html\n</details>\n<details><summary>literal</summary>\n```\n\nend\n\n</details>",
    ),
    root(
      details("X", [
        {
          type: "code",
          lang: "html",
          meta: null,
          value: "</details>\n<details><summary>literal</summary>",
        },
        paragraph("end"),
      ]),
    ),
  );
});

test("remarkDetails: summary emoji and inline markdown are parsed", () => {
  assert.deepEqual(
    runPlugin(
      "<details><summary>🌌 **bold** and `code`</summary>\n\nbody\n\n</details>",
    ),
    root({
      type: "details",
      data: { hName: "details" },
      children: [
        {
          type: "summary",
          data: { hName: "summary" },
          children: [
            text("🌌 "),
            { type: "strong", children: [text("bold")] },
            text(" and "),
            { type: "inlineCode", value: "code" },
          ],
        },
        paragraph("body"),
      ],
    }),
  );
});

test("remarkDetails: unrelated HTML is untouched", () => {
  assert.deepEqual(
    runPlugin("<div>hi</div>\n\n<summary>orphan</summary>"),
    root(
      { type: "html", value: "<div>hi</div>" },
      { type: "html", value: "<summary>orphan</summary>" },
    ),
  );
});

test("remarkDetails: an incomplete separate summary preserves both HTML nodes", () => {
  assert.deepEqual(
    runPlugin("<details>\n\n<summary>unfinished"),
    root(
      { type: "html", value: "<details>" },
      { type: "html", value: "<summary>unfinished" },
    ),
  );
});

test("remarkDetails: arbitrary details and summary attributes stay escaped", () => {
  assert.deepEqual(
    runPlugin(
      '<details onclick="alert(1)"><summary>X</summary>\n- a\n</details>',
    ),
    root({
      type: "html",
      value:
        '<details onclick="alert(1)"><summary>X</summary>\n- a\n</details>',
    }),
  );
  assert.deepEqual(
    runPlugin(
      '<details><summary style="color:red">X</summary>\n- a\n</details>',
    ),
    root({
      type: "html",
      value: '<details><summary style="color:red">X</summary>\n- a\n</details>',
    }),
  );
});

test("remarkDetails: single-node bodies retain GFM tables and inline links", () => {
  assert.deepEqual(
    runPlugin(
      "<details><summary>X</summary>\n| Name | Link |\n| --- | --- |\n| ~~a~~ | [docs](https://docs.test/) |\n</details>",
    ),
    root(
      details("X", [
        {
          type: "table",
          align: [null, null],
          children: [
            {
              type: "tableRow",
              children: [
                { type: "tableCell", children: [text("Name")] },
                { type: "tableCell", children: [text("Link")] },
              ],
            },
            {
              type: "tableRow",
              children: [
                {
                  type: "tableCell",
                  children: [{ type: "delete", children: [text("a")] }],
                },
                {
                  type: "tableCell",
                  children: [
                    {
                      type: "link",
                      title: null,
                      url: "https://docs.test/",
                      children: [text("docs")],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ]),
    ),
  );
});

test("remarkDetails: HTML inside a details body remains an escaped HTML node", () => {
  assert.deepEqual(
    runPlugin("<details><summary>X</summary>\n<div>hi</div>\n\n</details>"),
    root(details("X", [{ type: "html", value: "<div>hi</div>" }])),
  );
});
