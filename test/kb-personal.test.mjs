// `whissle kb me` — the caller's OWN documents (/api/me/kb, migration 157).
import { test } from "node:test";
import assert from "node:assert/strict";

import { downloadName } from "../src/commands/kb.mjs";
import { EP } from "../src/endpoints.mjs";

test("no route under it names a user — that IS the tenancy control", () => {
  // A wsk_ key resolves to one person, and every handler feeds THAT user id into
  // the query. A `--user` flag here would be asking for something the API has no
  // way to honour and no intention of honouring.
  assert.equal(EP.me.kb.base, "/api/me/kb");
  assert.equal(EP.me.kb.file("d1"), "/api/me/kb/d1/file");
  assert.equal(EP.me.kb.doc("d1"), "/api/me/kb/d1");
  for (const p of [EP.me.kb.base, EP.me.kb.file("d1"), EP.me.kb.doc("d1")]) {
    assert.doesNotMatch(p, /user/i);
  }
});

test("a download uses the name the file was uploaded under", () => {
  assert.equal(
    downloadName({ disposition: 'attachment; filename="Refund Policy.pdf"', docId: "d1" }),
    "Refund Policy.pdf",
  );
});

test("--out wins over whatever the server suggests", () => {
  assert.equal(downloadName({ out: "mine.pdf", disposition: 'attachment; filename="x.pdf"', docId: "d1" }), "mine.pdf");
});

test("a path in the server's filename cannot steer the write", () => {
  // The filename is data that came from an upload. A downloader that honours
  // `../` in it writes wherever that says.
  assert.equal(
    downloadName({ disposition: 'attachment; filename="../../.ssh/authorized_keys"', docId: "d1" }),
    "authorized_keys",
  );
  assert.equal(downloadName({ disposition: 'attachment; filename=".."', docId: "d1" }), "d1.bin");
});

test("no usable name falls back to the doc id, never to an empty path", () => {
  assert.equal(downloadName({ disposition: null, docId: "d1" }), "d1.bin");
  assert.equal(downloadName({ disposition: "attachment", docId: "d1" }), "d1.bin");
});

test("a percent-encoded filename is decoded", () => {
  assert.equal(
    downloadName({ disposition: "attachment; filename*=UTF-8''Q3%20report.pdf", docId: "d1" }),
    "Q3 report.pdf",
  );
});
