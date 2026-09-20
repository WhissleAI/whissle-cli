// The self-serve speech engine: `models transcribe --engine` and the `asr`
// group (node:test, no network). Pure helpers only — the socket itself is not
// under test here, its inputs and its rendering are.
import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "../bin/whissle.mjs";
import { gatewayRoot, asrStreamUrl } from "../src/config.mjs";
import { ENGINES, engineField, transcribeFooter } from "../src/commands/models.mjs";
import { METADATA_TAGS, configFrame, pcmLayout, eventLine, frames } from "../src/commands/asr.mjs";

// ── the gateway origin: /asr/* lives ABOVE the /bot platform prefix ──────────

test("gatewayRoot strips the /bot platform prefix and nothing else", () => {
  assert.equal(gatewayRoot("https://aws-gateway-backend.whissle.ai/bot"), "https://aws-gateway-backend.whissle.ai");
  assert.equal(gatewayRoot("https://aws-gateway-backend.whissle.ai/bot/"), "https://aws-gateway-backend.whissle.ai");
  // A self-hosted install points --base-url somewhere else; speech must follow.
  assert.equal(gatewayRoot("https://gw.acme.example.com/bot"), "https://gw.acme.example.com");
  // No prefix to strip, and a host whose NAME contains "bot" keeps its path.
  assert.equal(gatewayRoot("http://localhost:9000"), "http://localhost:9000");
  assert.equal(gatewayRoot("https://bot.example.com/bot"), "https://bot.example.com");
});

test("asrStreamUrl carries the key as a query param, over wss", () => {
  const url = asrStreamUrl("wsk_abc", { baseUrl: "https://aws-gateway-backend.whissle.ai/bot" });
  assert.equal(url, "wss://aws-gateway-backend.whissle.ai/asr/stream?token=wsk_abc");
  // A browser cannot set a header on a WebSocket, so the gateway reads ?token=
  // — which is why the URL is a credential and never printed.
  assert.match(url, /\?token=wsk_abc$/);
  // http:// (a local gateway) downgrades to ws://, not wss://.
  assert.match(asrStreamUrl("wsk_x", { baseUrl: "http://localhost:9000" }), /^ws:\/\/localhost:9000\/asr\/stream\?/);
  // /listen relays to the same upstream; it is a label, not a second protocol.
  assert.match(
    asrStreamUrl("wsk_x", { baseUrl: "https://h.example.com/bot", path: "/listen" }),
    /^wss:\/\/h\.example\.com\/listen\?token=wsk_x$/,
  );
});

// ── models transcribe --engine ───────────────────────────────────────────────

test("engineField accepts the three engines, case- and space-insensitively", () => {
  assert.deepEqual(ENGINES, ["deepgram", "sarvam", "whissle"]);
  for (const e of ENGINES) assert.equal(engineField({ engine: e }), e);
  assert.equal(engineField({ engine: " Whissle " }), "whissle");
});

test("omitting --engine sends no engine field at all", () => {
  // The pre-1.6 behaviour: the platform picks from --language. A caller who
  // never passes --engine must send byte-identical bytes to what they sent
  // before, so this has to be undefined and not "" or a default.
  assert.equal(engineField({}), undefined);
  assert.equal(engineField({ language: "hi" }), undefined);
});

test("--engine parses off the command line into the field", () => {
  const { positionals, flags } = parse(["transcribe", "call.wav", "--engine", "whissle", "--language", "en"]);
  assert.deepEqual(positionals, ["transcribe", "call.wav"]);
  assert.equal(engineField(flags), "whissle");
});

test("the footer reports the engine that RAN and the metadata that came back", () => {
  // `engine` is only in the response when the caller named one, and it is the
  // engine that actually ran — the platform degrades rather than failing, so
  // asking for whissle and being answered by deepgram is a normal outcome.
  const footer = transcribeFooter({
    duration_seconds: 12.5,
    cost_usd: "0.0031",
    segments: [{}, {}],
    engine: "deepgram",
    metadata: { emotion: "neutral", emotion_confidence: 0.81, intent: "inform" },
  });
  assert.match(footer, /12\.5s/);
  assert.match(footer, /\$0\.0031/);
  assert.match(footer, /2 segment\(s\)/);
  assert.match(footer, /engine: deepgram/);
  // Confidence pairs are noise in a one-line footer; the tag names are not.
  assert.match(footer, /metadata: emotion, intent/);
  assert.doesNotMatch(footer, /emotion_confidence/);
});

test("a response with no engine and no metadata says neither", () => {
  const footer = transcribeFooter({ duration_seconds: 3, cost_usd: "0.001" });
  assert.equal(footer, "3s · $0.001");
});

test("the command surfaces warnings before the transcript, on stderr", async () => {
  // The platform degrades WITH A WARNING rather than substituting silently, so
  // the transcript looks perfectly fine either way. A warning printed after the
  // text — or not at all — is how someone ends up believing a third-party
  // transcript carries Whissle metadata.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/commands/models.mjs", import.meta.url), "utf8");
  const body = src.slice(src.indexOf('if (sub === "transcribe")'));
  const warnAt = body.indexOf("warn(w)");
  const textAt = body.indexOf("out(md(r.text))");
  assert.ok(warnAt > 0, "transcribe never prints r.warnings");
  assert.ok(warnAt < textAt, "warnings must print before the transcript");
});

// ── the streaming config frame ───────────────────────────────────────────────

test("configFrame asks for metadata by default, and types the frame", () => {
  const f = configFrame({});
  assert.equal(f.type, "config");
  assert.equal(f.sample_rate, 16000);
  assert.deepEqual(f.metadata_tags, ["emotion", "intent", "entity"]);
  assert.equal(f.metadata_prob, true);
  // No --language means the engine decides; sending "" would pin it to nothing.
  assert.ok(!("language" in f));
});

test("--metadata names the tags, --metadata none asks for no head at all", () => {
  assert.deepEqual(configFrame({ metadata: "emotion,age" }).metadata_tags, ["emotion", "age"]);
  const none = configFrame({ metadata: "none" });
  assert.ok(!("metadata_tags" in none) && !("metadata_prob" in none));
  assert.ok(!("metadata_tags" in configFrame({ metadata: false })));
});

test("every tag the engine has a head for is accepted", () => {
  assert.deepEqual(METADATA_TAGS, ["emotion", "intent", "entity", "age", "gender", "dialect", "behavior", "eval", "role"]);
  assert.deepEqual(configFrame({ metadata: METADATA_TAGS.join(",") }).metadata_tags, METADATA_TAGS);
});

test("language, hotwords and word timestamps reach the frame in the socket's dialect", () => {
  const f = configFrame({ language: "hi", hotwords: "Acme Corp, SKU-42", "word-timestamps": true, "sample-rate": "8000" });
  assert.equal(f.language, "hi");
  // On the SOCKET hotwords is a JSON array — the HTTP form field of the same
  // name is a comma-separated string. Getting this backwards sends one hotword
  // called "Acme Corp, SKU-42".
  assert.deepEqual(f.hotwords, ["Acme Corp", "SKU-42"]);
  assert.equal(f.word_timestamps, true);
  assert.equal(f.sample_rate, 8000);
});

// ── audio layout ─────────────────────────────────────────────────────────────

/** A minimal RIFF/WAVE header for `bytes` of data. */
function wav({ channels = 1, bitDepth = 16, sampleRate = 16000, format = 1, bytes = 8, extraChunk = false } = {}) {
  const extra = extraChunk ? Buffer.concat([Buffer.from("LIST"), u32(4), Buffer.from("INFO")]) : Buffer.alloc(0);
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(format, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * channels * (bitDepth / 8), 16);
  fmt.writeUInt16LE(channels * (bitDepth / 8), 20);
  fmt.writeUInt16LE(bitDepth, 22);
  const data = Buffer.concat([Buffer.from("data"), u32(bytes), Buffer.alloc(bytes, 7)]);
  const body = Buffer.concat([Buffer.from("WAVE"), extra, fmt, data]);
  return Buffer.concat([Buffer.from("RIFF"), u32(body.length), body]);
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

test("a headerless buffer is taken as raw PCM", () => {
  assert.deepEqual(pcmLayout(Buffer.alloc(64)), { offset: 0, sampleRate: null, channels: null, bitDepth: null });
});

test("a mono 16-bit WAV is read directly, past its header", () => {
  const l = pcmLayout(wav({ sampleRate: 16000, bytes: 8 }));
  assert.equal(l.sampleRate, 16000);
  assert.equal(l.channels, 1);
  assert.equal(l.bitDepth, 16);
  // The samples, not the RIFF bytes.
  assert.equal(wav({ bytes: 8 }).subarray(l.offset).length, 8);
});

test("a WAV whose chunks are not in the obvious order still parses", () => {
  // Real files carry LIST/INFO chunks between WAVE and fmt. Walking chunks
  // rather than assuming the 44-byte layout is the whole reason for the loop.
  const l = pcmLayout(wav({ extraChunk: true, sampleRate: 8000 }));
  assert.equal(l.sampleRate, 8000);
});

test("a WAV the socket cannot read is refused, not reinterpreted", () => {
  // s16le@16k is positional: hand a stereo or 24-bit body to a socket expecting
  // mono 16-bit and it transcribes confident garbage. Refusing names the fix.
  for (const bad of [{ channels: 2 }, { bitDepth: 24 }, { format: 3 }]) {
    assert.throws(() => pcmLayout(wav(bad)), /mono 16-bit PCM/);
  }
  // …and the refusal names the conversion rather than just saying no.
  assert.throws(() => pcmLayout(wav({ channels: 2 })), /ffmpeg -i <file> -f s16le -ar 16000 -ac 1 -/);
});

test("frames splits the samples and loses none of them", () => {
  const buf = Buffer.alloc(3200, 1);
  const got = [...frames(buf, 1024)];
  assert.deepEqual(got.map((f) => f.length), [1024, 1024, 1024, 128]);
  assert.equal(Buffer.concat(got).length, buf.length);
  // A buffer shorter than one frame is still one frame, never zero.
  assert.equal([...frames(Buffer.alloc(10), 1024)].length, 1);
});

// ── event rendering ──────────────────────────────────────────────────────────

test("a final transcript renders its text and the tags that came back", () => {
  assert.equal(
    eventLine({ type: "transcript", text: "book me a table", is_final: true, metadata: { emotion: "happy", emotion_confidence: 0.9, intent: "booking" } }),
    "book me a table  [emotion=happy intent=booking]",
  );
});

test("a transcript with no metadata renders only its text", () => {
  // The smallest English model has no metadata head at all. An empty bracket
  // would read as "we asked and got nothing"; nothing reads as what it is.
  assert.equal(eventLine({ type: "transcript", text: "hello", is_final: true }), "hello");
  assert.equal(eventLine({ type: "transcript", text: "hello", is_final: true, metadata: {} }), "hello");
});

test("the engine's control events each render as themselves", () => {
  assert.equal(eventLine({ type: "flush_done" }), "(flushed)");
  assert.equal(eventLine({ type: "end" }), "(end)");
  assert.equal(eventLine({ type: "error", message: "model not loaded" }), "error: model not loaded");
  // An event kind we have never seen renders instead of vanishing.
  assert.equal(eventLine({ type: "speaker_change" }), "speaker_change");
});
