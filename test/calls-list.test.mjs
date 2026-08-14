// `whissle calls list --limit N` used to be a lie: the CLI sent the parameter
// correctly and the DEFAULT view of GET /api/calls ignores it, so `--limit 3`
// against a real workspace returned all 293 calls with full transcripts — 4.9 MB
// under --json to render a three-row table. The fix is to ask for the view that
// actually paginates. These pin both halves of that.
import { test } from "node:test";
import assert from "node:assert/strict";

import { absolutizeUrl, batchExitCode, isSigned, normalizeCallList, numeric } from "../src/commands/calls.mjs";

test("both list shapes are understood", () => {
  // `view=summary` answers {items,total}; the default view answers a bare array
  // and is frozen that way for its existing callers. A client that assumes
  // either one is broken against half the deployments it will meet.
  assert.deepEqual(normalizeCallList({ items: [{ id: "a" }], total: 293 }), {
    calls: [{ id: "a" }],
    total: 293,
  });
  assert.deepEqual(normalizeCallList([{ id: "a" }]), { calls: [{ id: "a" }], total: null });
});

test("an unexpected body yields an empty list, not a crash", () => {
  assert.deepEqual(normalizeCallList(null), { calls: [], total: null });
  assert.deepEqual(normalizeCallList({ detail: "nope" }), { calls: [], total: null });
});

test("a valueless --limit falls back to the default instead of becoming `true`", () => {
  // `--limit` with nothing after it parses as boolean true; sent as a query
  // param that is `limit=true`, which is a 422.
  assert.equal(numeric(true, 25), 25);
  assert.equal(numeric("3", 25), 3);
  assert.equal(numeric("0", 25), 25);
  assert.equal(numeric("abc", 25), 25);
  assert.equal(numeric(undefined, 25), 25);
});

test("a signed cloud URL is passed through untouched", () => {
  const u = "https://bucket.s3.amazonaws.com/a.wav?X-Amz-Signature=abc";
  assert.equal(absolutizeUrl(u, "https://api.example/bot"), u);
  assert.equal(isSigned(u), true);
});

test("a local-storage relative path is made fetchable", () => {
  // The backend returns `/api/calls/{id}/audio/file` on a local-storage install.
  // Printed on its own that is not fetchable by anything.
  assert.equal(
    absolutizeUrl("/api/calls/c1/audio/file", "https://api.example/bot/"),
    "https://api.example/bot/api/calls/c1/audio/file",
  );
  assert.equal(isSigned("https://api.example/bot/api/calls/c1/audio/file"), false);
});

test("no recording is null, not the string 'undefined'", () => {
  assert.equal(absolutizeUrl(undefined, "https://api.example"), null);
  assert.equal(absolutizeUrl(null, "https://api.example"), null);
});

// ── batch outcomes: a failed batch must not exit 0 ────────────────────────────

test("a batch where nothing failed exits 0", () => {
  assert.equal(batchExitCode([{ ok: true }, { ok: true }]), 0);
  assert.equal(batchExitCode([]), 0);
});

test("a batch refused for credit exits 4, not 0", () => {
  // The failure this exists for: 500 rows, every one 402, "✓ Campaign done —
  // 0/500 placed", exit 0, and a cron job that never alerted.
  assert.equal(
    batchExitCode([{ ok: false, status: 402 }, { ok: false, status: 402 }]),
    4,
  );
});

test("one failure among successes still fails the batch", () => {
  assert.equal(batchExitCode([{ ok: true }, { ok: false, status: 404 }]), 3);
});

test("failures that disagree report generic rather than picking one", () => {
  // "some 402s and some 404s" is not one condition; claiming it is would be
  // worse than saying "something went wrong".
  assert.equal(batchExitCode([{ ok: false, status: 402 }, { ok: false, status: 404 }]), 1);
});

test("a failure with no HTTP status (a socket that never opened) is generic", () => {
  assert.equal(batchExitCode([{ ok: false, status: null }]), 1);
});
