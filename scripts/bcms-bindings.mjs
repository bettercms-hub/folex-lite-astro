// BetterCMS click-to-edit bindings for the built HTML.
//
// This theme renders all copy from Markdown/YAML content collections, so the binding attributes
// (data-bcms-field & co.) cannot be written in the templates by the BetterCMS codemod. Instead
// they are pinned in bcms-bindings.json and stamped onto dist/ after every build.
//
//   node scripts/bcms-bindings.mjs            stamp dist/ from bcms-bindings.json (runs in build:bcms)
//   node scripts/bcms-bindings.mjs pin <url>  rebuild bcms-bindings.json from a live text-match release
//
// ponytail: a pin is the element's tag, attributes and text (hashed) + its occurrence on the page.
// Change that element's copy or classes in the repo and its pin is dropped (reported below), never
// misapplied. Re-pin, or add the entry to bcms-bindings.json by hand, when that happens.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse } from "parse5";

const DIST = "dist";
const MAP = "bcms-bindings.json";
// data-bcms-from / -release mark a text-match guess and a release; a declared binding carries neither.
// data-variant / data-size are part of a button field's declaration (see BcmsButton).
const REPLAY = /^data-(bcms-(?!from$|release$)|variant$|size$)/;

const elements = (html) => {
  const out = [];
  const walk = (node) => {
    if (node.tagName && node.sourceCodeLocation?.startTag) out.push(node);
    for (const child of node.childNodes ?? []) walk(child);
    if (node.content) walk(node.content);
  };
  walk(parse(html, { sourceCodeLocationInfo: true }));
  return out;
};

const fullText = (node) =>
  node.nodeName === "#text"
    ? node.value
    : (node.childNodes ?? []).map(fullText).join("");
const attr = (el, name) => el.attrs.find((a) => a.name === name)?.value ?? "";
const squash = (el) => fullText(el).replace(/\s+/g, "");
const alignKey = (el) =>
  `${el.tagName}|${attr(el, "class")}|${createHash("sha1").update(squash(el)).digest("hex")}`;

/** Longest common subsequence of two key lists, as [indexA, indexB] pairs. */
const align = (a, b) => {
  const lcs = Array.from(
    { length: a.length + 1 },
    () => new Uint16Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const pairs = [];
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) pairs.push([i++, j++]);
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  return pairs;
};

// Ids the theme regenerates on every build (accordion and dropdown wiring) are not identity.
const VOLATILE = /^(id|for|aria-controls|aria-labelledby|data-bcms-.*)$/;

/** Each element's pin id: hash of its tag, attributes and text + how many identical ones precede it. */
const pinIds = (html, els) => {
  const seen = new Map();
  return els.map((el) => {
    const attrs = el.attrs
      .filter((a) => !VOLATILE.test(a.name))
      .map((a) => `${a.name}=${a.value}`);
    const { startTag, endTag } = el.sourceCodeLocation;
    // An icon has no text: its drawing is what tells one from the next.
    const drawing =
      el.tagName === "svg" && endTag
        ? html.slice(startTag.endOffset, endTag.startOffset)
        : "";
    const identity = [
      el.tagName,
      ...attrs,
      fullText(el).replace(/\s+/g, " ").trim(),
      drawing,
    ].join("\n");
    const sig = createHash("sha1").update(identity).digest("hex").slice(0, 12);
    const n = seen.get(sig) ?? 0;
    seen.set(sig, n + 1);
    return `${sig}#${n}`;
  });
};

const pages = () =>
  fs
    .readdirSync(DIST, { recursive: true })
    .filter((f) => f.endsWith(".html"))
    .map((f) => ({
      file: path.join(DIST, f),
      route: "/" + f.replace(/\\/g, "/").replace(/(^|\/)index\.html$/, ""),
    }));

async function pin(base) {
  const map = {};
  for (const { file, route } of pages()) {
    const res = await fetch(
      base.replace(/\/$/, "") +
        route +
        (route.endsWith("/") || route.endsWith(".html") ? "" : "/"),
    );
    if (!res.ok) {
      console.warn(`skip ${route}: live answered ${res.status}`);
      continue;
    }
    const html = fs.readFileSync(file, "utf8");
    const local = elements(html);
    const ids = pinIds(html, local);
    const live = elements(await res.text());
    // The live page is this build plus what the release added or rewrote: pair what both hold.
    const bound = (el) =>
      Object.fromEntries(
        el.attrs
          .filter((a) => REPLAY.test(a.name))
          .map((a) => [a.name, a.value]),
      );
    const pins = {};
    const pairs = align(live.map(alignKey), local.map(alignKey));
    for (const [i, j] of pairs) {
      const attrs = bound(live[i]);
      if (!Object.keys(attrs).length) continue;
      // Bind the leaf: a label that sits in its own span beside other markup (a button's hover
      // layer) takes the text binding, so a publish never overwrites its siblings.
      const el = local[j];
      const leaf = (el.childNodes ?? []).find(
        (c) => c.tagName === "span" && squash(c) && squash(c) === squash(el),
      );
      if (
        leaf &&
        el.childNodes.filter((c) => c.tagName).length > 1 &&
        attrs["data-bcms-kind"]
      ) {
        const {
          "data-bcms-field": field,
          "data-bcms-layout-field": layoutField,
          "data-bcms-kind": kind,
          ...rest
        } = attrs;
        pins[ids[local.indexOf(leaf)]] = {
          ...(field && { "data-bcms-field": field }),
          ...(layoutField && { "data-bcms-layout-field": layoutField }),
          "data-bcms-kind": kind,
        };
        if (Object.keys(rest).length) pins[ids[j]] = rest;
      } else pins[ids[j]] = attrs;
    }
    const paired = new Set(pairs.map(([i]) => i));
    const lost = live.filter(
      (el, i) => Object.keys(bound(el)).length && !paired.has(i),
    ).length;
    if (lost)
      console.warn(
        `${route}: ${lost} live bindings have no counterpart in this build`,
      );
    map[route] = pins;
    console.log(`${route}: ${Object.keys(pins).length} pins`);
  }
  fs.writeFileSync(MAP, JSON.stringify(map, null, 1) + "\n");
}

function stamp() {
  const map = JSON.parse(fs.readFileSync(MAP, "utf8"));
  let stamped = 0;
  const dropped = [];
  for (const { file, route } of pages()) {
    const pins = map[route];
    if (!pins) continue;
    const html = fs.readFileSync(file, "utf8");
    const els = elements(html);
    const ids = pinIds(html, els);
    const left = new Set(Object.keys(pins));
    const inserts = [];
    els.forEach((el, i) => {
      const attrs = pins[ids[i]];
      if (!attrs) return;
      left.delete(ids[i]);
      const add = Object.entries(attrs)
        .filter(([name]) => !el.attrs.some((a) => a.name === name))
        .map(
          ([name, value]) =>
            ` ${name}="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`,
        )
        .join("");
      const tagEnd = el.sourceCodeLocation.startTag.endOffset;
      inserts.push([html[tagEnd - 2] === "/" ? tagEnd - 2 : tagEnd - 1, add]);
    });
    let out = html;
    for (const [at, add] of inserts.sort((a, b) => b[0] - a[0]))
      out = out.slice(0, at) + add + out.slice(at);
    fs.writeFileSync(file, out);
    stamped += inserts.length;
    for (const id of left) dropped.push(`${route} ${JSON.stringify(pins[id])}`);
  }
  console.log(
    `bcms-bindings: stamped ${stamped} elements, ${dropped.length} pins no longer match the build`,
  );
  for (const line of dropped) console.warn(`  dropped ${line}`);
}

if (process.argv[2] === "pin") await pin(process.argv[3]);
else stamp();
