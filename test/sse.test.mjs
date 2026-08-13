// The SSE parser. Every one of these is a bug that would present as "the model
// swallowed a word" or "the CLI hung", which is the worst class of bug to debug
// from a terminal — so they are pinned here, off the network.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseFrame, sseFrames } from "../src/sse.mjs";

/** Feed a string to the parser one arbitrary slice at a time. */
async function framesOf(text, chunkSize = Infinity) {
  const chunks = (async function* () {
    for (let i = 0; i < text.length; i += chunkSize) yield text.slice(i, i + chunkSize);
  })();
  const got = [];
  for await (const f of sseFrames(chunks)) got.push(f);
  return got;
}

test("a frame carries its event name and parsed payload", () => {
  const f = parseFrame('event: delta\ndata: {"hop":0,"text":"hi"}');
  assert.equal(f.event, "delta");
  assert.deepEqual(f.data, { hop: 0, text: "hi" });
});

test("a keep-alive comment is not a frame", () => {
  // The gateway pings every ~15s so an idle proxy doesn't kill a 100-second
  // deep_research turn. Treating it as a frame yields a phantom typeless event.
  assert.equal(parseFrame(": ping"), null);
});

test("a data line without an event defaults to `message`", () => {
  assert.equal(parseFrame("data: hello").event, "message");
});

test("a non-JSON payload survives verbatim instead of killing the stream", () => {
  // By the time we see it the bytes are gone; there is nothing to retry.
  const f = parseFrame("event: delta\ndata: not json");
  assert.equal(f.data, "not json");
  assert.equal(f.raw, "not json");
});

test("multi-line data is rejoined with newlines", () => {
  assert.equal(parseFrame("data: a\ndata: b").data, "a\nb");
});

test("exactly one leading space is stripped, per the spec", () => {
  assert.equal(parseFrame("data:  two spaces").data, " two spaces");
});

test("a frame split across chunk boundaries is not lost", async () => {
  // The real failure this prevents: `data: {"text":"hel` / `lo"}` arriving as
  // two TCP reads, and a chunk==frame parser dropping the token silently.
  const wire =
    'event: open\ndata: {"conversation_id":"c1"}\n\n' +
    'event: delta\ndata: {"hop":0,"text":"hello"}\n\n' +
    'event: done\ndata: {"reply":"hello"}\n\n';
  for (const size of [1, 3, 7, 64]) {
    const got = await framesOf(wire, size);
    assert.deepEqual(
      got.map((f) => f.event),
      ["open", "delta", "done"],
      `chunk size ${size}`,
    );
    assert.equal(got[1].data.text, "hello", `chunk size ${size}`);
  }
});

test("keep-alives interleaved with frames are skipped, not counted", async () => {
  const wire = 'event: open\ndata: {}\n\n: ping\n\n: ping\n\nevent: done\ndata: {}\n\n';
  const got = await framesOf(wire, 5);
  assert.deepEqual(got.map((f) => f.event), ["open", "done"]);
});

test("CRLF line endings parse the same as LF", async () => {
  const got = await framesOf('event: delta\r\ndata: {"text":"x"}\r\n\r\n');
  assert.deepEqual(got.map((f) => f.event), ["delta"]);
});

test("a stream that ends without its final blank line still yields its last frame", async () => {
  const got = await framesOf('event: done\ndata: {"reply":"bye"}');
  assert.equal(got.length, 1);
  assert.equal(got[0].data.reply, "bye");
});
