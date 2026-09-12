// `agents create --file` can declare web embedding in the package (applyEmbed),
// mirroring `whissle embed enable`. These pin the mapping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEmbed } from "../src/commands/agents.mjs";

test("an embed block with origins enables + carries allowed_origins", () => {
  const r = applyEmbed({ allowed_origins: ["https://site.com", " http://localhost:3000 "] });
  assert.equal(r.error, undefined);
  assert.equal(r.body.embed_enabled, true);
  assert.deepEqual(r.body.allowed_origins, ["https://site.com", "http://localhost:3000"]);
  assert.equal("text_enabled" in r.body, false);
});

test("comma-separated origins split, `text:true` enables the text widget", () => {
  const r = applyEmbed({ origins: "https://a.com, https://b.com", text: true });
  assert.deepEqual(r.body.allowed_origins, ["https://a.com", "https://b.com"]);
  assert.equal(r.body.text_enabled, true);
});

test("enabling without an origin is an error (matches `embed enable`)", () => {
  assert.match(applyEmbed({}).error, /allowed_origins/);
});

test("`enabled:false` disables without needing an origin", () => {
  const r = applyEmbed({ enabled: false });
  assert.equal(r.error, undefined);
  assert.equal(r.body.embed_enabled, false);
  assert.equal("allowed_origins" in r.body, false);
});
