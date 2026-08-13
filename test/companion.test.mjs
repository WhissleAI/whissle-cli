// `whissle companion` — the field name that decides whether a turn happens at
// all, the thread key that decides whether it is a conversation, and the hop
// rule that decides whether the transcript is the reply.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  drainStream,
  imageDataUrl,
  newSessionId,
  refreshedCount,
  turnBody,
} from "../src/commands/companion.mjs";
import { EP } from "../src/endpoints.mjs";

/** An async iterable of frames, as `postStream` would yield them. */
async function* frames(...list) {
  for (const f of list) yield f;
}
const delta = (text, hop = 0, extra = {}) => ({ event: "delta", data: { hop, text, ...extra } });
const done = (payload) => ({ event: "done", data: payload });

test("the body field is `text` — `message` is the other route's, and is a 422 here", () => {
  const b = turnBody({ text: "hi" });
  assert.equal(b.text, "hi");
  assert.equal("message" in b, false);
});

test("the thread handle is session_id (the agent route threads on conversation_id)", () => {
  assert.equal(turnBody({ text: "hi", sessionId: "s1" }).session_id, "s1");
  assert.equal("conversation_id" in turnBody({ text: "hi", sessionId: "s1" }), false);
});

test("optional fields are omitted rather than sent null", () => {
  // A null `prompt` is not the same as no prompt: it would override the
  // companion's assembled system prompt with nothing.
  assert.deepEqual(Object.keys(turnBody({ text: "hi" })), ["text"]);
});

test("language, prompt and images ride along when given", () => {
  const b = turnBody({ text: "hi", sessionId: "s", language: "hi", prompt: "p", images: ["data:…"] });
  assert.deepEqual(Object.keys(b).sort(), ["images", "language", "prompt", "session_id", "text"]);
});

test("an empty image list is not sent", () => {
  assert.equal("images" in turnBody({ text: "hi", images: [] }), false);
});

test("each run gets a distinct, self-labelling thread key", () => {
  assert.notEqual(newSessionId(), newSessionId());
  assert.match(newSessionId(), /^cli-/);
});

test("it drives the companion's own routes, not a fake agent id", () => {
  // The companion has no agents row; addressing it through /api/agents/companion
  // is a 404 or, worse, a real agent someone happened to name that.
  assert.equal(EP.companion.turn, "/api/chat");
  assert.equal(EP.companion.stream, "/api/chat/stream");
  assert.equal(EP.companion.get, "/api/companion");
});

test("only .png/.jpg/.webp are offered to the API", () => {
  const read = () => Buffer.from("bytes");
  assert.match(imageDataUrl("a.png", read), /^data:image\/png;base64,/);
  assert.match(imageDataUrl("a.JPG", read), /^data:image\/jpeg;base64,/);
  assert.match(imageDataUrl("a.webp", read), /^data:image\/webp;base64,/);
});

test("a streamed turn's transcript comes from `done`, not from concatenated deltas", async () => {
  // The hop rule. Hop 0 is narration ("let me look that up"), hop 1 is the
  // answer — exactly as voice speaks the narration and then speaks the answer.
  // A client that concatenates every delta reports the narration as the reply.
  let written = "";
  const payload = await drainStream(
    frames(
      { event: "open", data: { conversation_id: "c1" } },
      delta("Let me look that up.", 0),
      { event: "tool", data: { phase: "started", function_name: "search_web" } },
      delta("Oslo.", 1),
      done({ reply: "Oslo.", conversation_id: "c1", tools_used: ["search_web"] }),
    ),
    { write: (s) => (written += s) },
  );
  assert.equal(payload.reply, "Oslo.");
  assert.notEqual(payload.reply, "Let me look that up.Oslo.");
  assert.match(written, /Let me look that up\./);
  assert.match(written, /search_web/);
});

test("a hop change breaks the line instead of running two answers together", async () => {
  let written = "";
  await drainStream(frames(delta("a", 0), delta("b", 1), done({ reply: "b" })), {
    write: (s) => (written += s),
  });
  assert.equal(written, "a\nb\n");
});

test("a reset says the text was retracted rather than leaving it on screen", async () => {
  // `{reset:true}` means a provider died mid-hop and the other restarted it.
  // Silently continuing leaves a dead provider's half-sentence looking like part
  // of the answer.
  let written = "";
  await drainStream(frames(delta("wrong", 0), delta("", 0, { reset: true }), delta("right", 0), done({ reply: "right" })), {
    write: (s) => (written += s),
  });
  assert.match(written, /restarting/);
});

test("a terminal `error` frame throws rather than returning a half turn", async () => {
  await assert.rejects(
    () => drainStream(frames({ event: "error", data: { message: "overloaded" } })),
    /overloaded/,
  );
});

test("a stream that stops with no `done` is reported as a dropped connection", async () => {
  // The turn still completed server-side (it does not belong to the connection),
  // so the message has to say where to go and read it.
  await assert.rejects(() => drainStream(frames(delta("half", 0))), /sessions list --agent companion/);
});

test("an unknown frame type is ignored, not fatal", async () => {
  const payload = await drainStream(
    frames({ event: "something_new", data: {} }, done({ reply: "ok" })),
    { write: () => {} },
  );
  assert.equal(payload.reply, "ok");
});

test("an empty refresh list does not print a blank count", () => {
  // `[]` is truthy in JS, which is how "· live session(s)" with no number got
  // printed on every single refresh.
  assert.equal(refreshedCount([]), 0);
  assert.equal(refreshedCount(["pc1", "pc2"]), 2);
  assert.equal(refreshedCount(3), 3);
  assert.equal(refreshedCount(undefined), 0);
});
