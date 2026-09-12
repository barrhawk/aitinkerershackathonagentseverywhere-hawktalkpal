import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkplaceRecordCard, shortId, toWorkplaceRecord } from "./workplace-record";

test("record card renders a skeleton before any arguments stream in", () => {
  const html = renderToStaticMarkup(createElement(WorkplaceRecordCard, {}));
  assert.match(html, /Workplace record filing…/);
  assert.match(html, /Waiting for the record/);
  assert.doesNotMatch(html, /Open in Ambiguous/);
});

test("record card shows a created doc with a short id and a link", () => {
  const html = renderToStaticMarkup(createElement(WorkplaceRecordCard, {
    kind: "doc", title: "Venue power notes", id: "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b", url: "https://app.ambiguous.ai/documents/0f1e2d3c", ms: 812, ok: true,
  }));
  assert.match(html, /Doc created · 812 ms/);
  assert.match(html, /Venue power notes/);
  assert.match(html, /id 0f1e2d3c…/);
  assert.doesNotMatch(html, /0f1e2d3c-4b5a-6978/);
  assert.match(html, /data-ok="1"/);
  assert.match(html, /href="https:\/\/app\.ambiguous\.ai\/documents\/0f1e2d3c"/);
});

test("record card shows a failed team message without a link", () => {
  const html = renderToStaticMarkup(createElement(WorkplaceRecordCard, { kind: "message", title: "Sound check at 6", id: "HTTP 500", ok: false }));
  assert.match(html, /Team message failed/);
  assert.match(html, /data-ok="0"/);
  assert.doesNotMatch(html, /Open in Ambiguous/);
});

test("shortId keeps short ids intact and truncates uuids", () => {
  assert.equal(shortId("abc"), "abc");
  assert.equal(shortId("0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b"), "0f1e2d3c…");
});

test("toWorkplaceRecord reads flat and nested Ambiguous records", () => {
  const flat = toWorkplaceRecord("note_it", { title: "Draft" }, { ok: true, ms: 640, record: { id: "doc-1", title: "Venue notes", url: "https://app.ambiguous.ai/documents/doc-1" } });
  assert.deepEqual(flat, { kind: "doc", title: "Venue notes", id: "doc-1", url: "https://app.ambiguous.ai/documents/doc-1", ms: 640, ok: true });
  const nested = toWorkplaceRecord("tell_team", { content: "Sound check moved to six, bring the spare mixer" }, { ok: true, ms: 300, record: { message: { id: "msg-9" }, url: "https://app.ambiguous.ai/channels/c-1" } });
  assert.equal(nested.kind, "message");
  assert.equal(nested.id, "msg-9");
  assert.equal(nested.url, "https://app.ambiguous.ai/channels/c-1");
  assert.equal(nested.title, "Sound check moved to six, bring the spare mixer");
});

test("toWorkplaceRecord falls back to the request and the error on failure", () => {
  const declined = toWorkplaceRecord("note_it", { title: "Draft", content: "x" }, { ok: false, record: "declined by user" });
  assert.deepEqual(declined, { kind: "doc", title: "Draft", id: "declined by user", url: undefined, ms: undefined, ok: false });
  const failed = toWorkplaceRecord("tell_team", { content: "hi" }, { ok: false, ms: 90, record: { error: "No channel named general" } });
  assert.equal(failed.id, "No channel named general");
  assert.equal(failed.title, "hi");
  assert.equal(failed.ok, false);
});
