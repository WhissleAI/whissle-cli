// The entry-point guard: does the CLI actually RUN when it is invoked the way
// npm installs it?
//
// `npm i -g @whissle/cli` does not copy the binary — it symlinks it
// (node_modules/.bin/whissle → ../@whissle/cli/bin/whissle.mjs). Node resolves
// symlinks for `import.meta.url` but leaves `process.argv[1]` as the symlink,
// so the two are NEVER equal for an installed package. The old guard compared
// them raw, which meant every installed copy was a silent no-op: `whissle help`
// printed nothing and exited 0. Running from a source checkout hid it, so the
// whole suite passed against a binary that did nothing for real users.
//
// These tests exercise the symlink path directly, which is the only way this
// class of bug is visible.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { isDirectInvocation } from "../bin/whissle.mjs";

const BIN = resolve(fileURLToPath(new URL("../bin/whissle.mjs", import.meta.url)));

test("a symlinked argv[1] still counts as a direct invocation", () => {
  const dir = mkdtempSync(join(tmpdir(), "whissle-bin-"));
  const link = join(dir, "whissle");
  try {
    symlinkSync(BIN, link);
    // This is the exact comparison npm's bin shim produces.
    assert.equal(
      isDirectInvocation(link, pathToFileURL(BIN).href),
      true,
      "symlinked bin must run main() — otherwise the installed CLI is a no-op",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a direct (unsymlinked) path still counts as a direct invocation", () => {
  assert.equal(isDirectInvocation(BIN, pathToFileURL(BIN).href), true);
});

test("importing the module (argv[1] is some other file) does NOT run main()", () => {
  assert.equal(isDirectInvocation("/some/other/test-runner.mjs", pathToFileURL(BIN).href), false);
  assert.equal(isDirectInvocation(undefined, pathToFileURL(BIN).href), false);
});

test("a nonexistent argv[1] falls back instead of throwing", () => {
  assert.doesNotThrow(() => isDirectInvocation("/no/such/path/whissle", pathToFileURL(BIN).href));
  assert.equal(isDirectInvocation("/no/such/path/whissle", pathToFileURL(BIN).href), false);
});

// The end-to-end proof: run the CLI THROUGH a symlink and require real output.
test("`help` through a symlink prints the help text and exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "whissle-bin-"));
  const link = join(dir, "whissle");
  try {
    symlinkSync(BIN, link);
    const out = execFileSync(process.execPath, [link, "help"], { encoding: "utf8" });
    assert.match(out, /whissle/, "help through a symlink printed nothing");
    assert.match(out, /Exit codes:/, "help through a symlink was truncated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
