// Unit tests for the exit-code contract (node:test, no network).
// These codes are API: a CI script branches on them, so a change here is a
// breaking change and should have to break a test to happen.
import test from "node:test";
import assert from "node:assert/strict";
import { EXIT, exitCodeFor } from "../src/exit.mjs";
import { ApiError } from "../src/api.mjs";

test("the codes are the documented ones", () => {
  assert.deepEqual(EXIT, { OK: 0, GENERIC: 1, AUTH: 2, NOT_FOUND: 3, NO_CREDIT: 4 });
});

test("401 and 403 are both auth — the fix is the key, not a retry", () => {
  assert.equal(exitCodeFor(new ApiError(401, "Invalid or revoked API key")), EXIT.AUTH);
  assert.equal(exitCodeFor(new ApiError(403, "missing scope calls:read")), EXIT.AUTH);
});

test("402 is out of credit, distinct from every other failure", () => {
  assert.equal(exitCodeFor(new ApiError(402, "workspace out of credit")), EXIT.NO_CREDIT);
});

test("404 is not-found", () => {
  assert.equal(exitCodeFor(new ApiError(404, "Session not found")), EXIT.NOT_FOUND);
});

test("client-side auth failures carry no status but still exit 2", () => {
  // `whissle sessions list` with no key configured never reaches the network.
  assert.equal(exitCodeFor(new ApiError(0, "No API key configured.", null, { code: "no_key" })), EXIT.AUTH);
  assert.equal(exitCodeFor(new ApiError(0, "Could not resolve a workspace.", null, { code: "no_org" })), EXIT.AUTH);
});

test("anything unclassified is a generic 1", () => {
  assert.equal(exitCodeFor(new ApiError(500, "boom")), EXIT.GENERIC);
  assert.equal(exitCodeFor(new ApiError(400, "bad request")), EXIT.GENERIC);
  assert.equal(exitCodeFor(new TypeError("fetch failed")), EXIT.GENERIC);
  assert.equal(exitCodeFor(undefined), EXIT.GENERIC);
});

test("success is never inferred from an error", () => {
  for (const e of [new ApiError(401, "x"), new ApiError(404, "x"), new Error("x")]) {
    assert.notEqual(exitCodeFor(e), EXIT.OK);
  }
});
