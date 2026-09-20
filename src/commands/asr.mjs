// whissle asr status|stream — Whissle's own speech engine, direct (models:invoke).
//
// ─── What this group is, and what it is NOT ─────────────────────────────────
//
// `whissle asr stream` opens the gateway's raw speech socket: signed 16-bit
// little-endian PCM in, JSON transcript events out, with Whissle's acoustic
// metadata (emotion, intent, age, gender, entities) on the same events. It is a
// DIFFERENT feature from `whissle listen`, which opens a LiveKit room for an
// AGENT to sit in and listen — same word, different door. See `whissle asr
// --help`, which says so at the prompt too.
//
// ─── It does not open your microphone, deliberately ─────────────────────────
//
// Node has no microphone. Capturing one means a native addon or a hard
// dependency on `sox`/`ffmpeg`/`arecord` being installed — and a control-plane
// CLI that fails at `npm i -g` on a machine without a sound stack is worse than
// one that never claimed to record. So this command owns the PROTOCOL and you
// own the AUDIO: give it a file, or pipe your own capture in on stdin. Live
// mic, with whatever you already have:
//
//   ffmpeg -f avfoundation -i :0 -f s16le -ar 16000 -ac 1 - | whissle asr stream -
//   arecord -f S16_LE -r 16000 -c 1 -t raw          | whissle asr stream -
//
// For a browser microphone, that is the @whissle/agents SDK's job, not this one.
//
// ─── Billing ────────────────────────────────────────────────────────────────
//
// The socket is metered to your workspace per second it is OPEN — wall clock on
// the relay, not the duration of the audio you pushed through it (gateway
// `websocket.py` `_meter_ws_session`, debited via `/api/models/asr/usage`). An
// idle open socket still bills. That is why this command prints the warning it
// does, streams as fast as the socket will take it unless you ask for
// `--realtime`, and closes the moment the input ends.
import { readFileSync } from "node:fs";
import { loadConfig, gatewayRoot, asrStreamUrl } from "../config.mjs";
import { get } from "../api.mjs";
import { out, kv, table, dim, warn, printJson, fatal } from "../ui.mjs";
import { EXIT } from "../exit.mjs";

/** The metadata tags the engine has heads for (pipecat-bot/DEPLOY_CONFIG.md). */
export const METADATA_TAGS = ["emotion", "intent", "entity", "age", "gender", "dialect", "behavior", "eval", "role"];

const DEFAULT_TAGS = ["emotion", "intent", "entity"];

/**
 * The JSON config frame sent before the first audio byte.
 *
 * `metadata_tags` is a REQUEST, never a promise: whether a tag comes back
 * depends on which model this deployment loaded, and the smallest English model
 * has no metadata head at all. A tag the model cannot serve is simply absent
 * from the events — there is no error and, checked against the gateway, no
 * status endpoint that lists them either. Ask, then read what arrives.
 *
 * Pure — exported for tests.
 */
export function configFrame(flags) {
  const tags = flags.metadata === false || flags.metadata === "none"
    ? []
    : typeof flags.metadata === "string"
      ? flags.metadata.split(",").map((s) => s.trim()).filter(Boolean)
      : DEFAULT_TAGS;
  for (const t of tags) {
    if (!METADATA_TAGS.includes(t)) {
      fatal(`--metadata: "${t}" is not a tag. Valid: ${METADATA_TAGS.join(", ")} (or --metadata none).`);
    }
  }
  const frame = {
    type: "config",
    sample_rate: Number(flags["sample-rate"]) || 16000,
    ...(typeof flags.language === "string" && flags.language ? { language: flags.language } : {}),
  };
  if (tags.length) {
    frame.metadata_tags = tags;
    frame.metadata_prob = true;
  }
  if (typeof flags.hotwords === "string" && flags.hotwords) {
    frame.hotwords = flags.hotwords.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (flags["word-timestamps"]) frame.word_timestamps = true;
  return frame;
}

/**
 * Where the PCM samples start in a buffer, and at what rate.
 *
 * A 16 kHz mono 16-bit WAV is raw PCM with a header bolted on, so accepting one
 * costs twenty lines and saves every caller an ffmpeg invocation. Anything else
 * — a different rate, stereo, 24-bit, an mp3 — is NOT silently reinterpreted:
 * feeding a socket that expects s16le@16k some other layout produces confident
 * garbage rather than an error, which is the worst possible failure. So we
 * refuse and name the conversion.
 *
 * Returns `{offset, sampleRate, channels, bitDepth}`. Pure — exported for tests.
 */
export function pcmLayout(buf) {
  const raw = { offset: 0, sampleRate: null, channels: null, bitDepth: null };
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return raw; // headerless — we trust the caller's --sample-rate
  }
  let p = 12, fmt = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString("ascii", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === "fmt ") {
      fmt = {
        format: buf.readUInt16LE(p + 8),
        channels: buf.readUInt16LE(p + 10),
        sampleRate: buf.readUInt32LE(p + 12),
        bitDepth: buf.readUInt16LE(p + 22),
      };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV has a data chunk before its fmt chunk — re-encode it.");
      if (fmt.format !== 1 || fmt.bitDepth !== 16 || fmt.channels !== 1) {
        throw new Error(
          `WAV is ${fmt.channels}ch/${fmt.bitDepth}-bit/format ${fmt.format}; the socket takes mono 16-bit PCM. ` +
            `Convert it:  ffmpeg -i <file> -f s16le -ar 16000 -ac 1 - | whissle asr stream -`,
        );
      }
      return { offset: p + 8, sampleRate: fmt.sampleRate, channels: 1, bitDepth: 16 };
    }
    p += 8 + size + (size % 2); // chunks are word-aligned
  }
  throw new Error("WAV has no data chunk — re-encode it.");
}

/** A transcript/metadata event → one line. Pure — exported for tests. */
export function eventLine(evt) {
  if (!evt || typeof evt !== "object") return String(evt ?? "");
  if (evt.type === "error") return `error: ${evt.message || "(no message)"}`;
  if (evt.type === "flush_done") return "(flushed)";
  if (evt.type === "end") return "(end)";
  if (evt.type !== "transcript") return evt.type || JSON.stringify(evt);
  const bits = [String(evt.text ?? "").trim()];
  const meta = evt.metadata && typeof evt.metadata === "object" ? evt.metadata : null;
  if (meta) {
    const tags = Object.entries(meta)
      .filter(([k, v]) => !k.endsWith("_confidence") && v !== null && v !== "" && typeof v !== "object")
      .map(([k, v]) => `${k}=${v}`);
    if (tags.length) bits.push(`[${tags.join(" ")}]`);
  }
  return bits.filter(Boolean).join("  ");
}

/** Split a buffer into frames of `bytes`. Pure — exported for tests. */
export function* frames(buf, bytes) {
  for (let i = 0; i < buf.length; i += bytes) yield buf.subarray(i, Math.min(i + bytes, buf.length));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Let at most this much audio sit unsent in the socket's buffer (1 MiB ≈ 32s). */
const SEND_HIGH_WATER = 1 << 20;

/** Everything on stdin, as one buffer. */
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks);
}

async function runStream(args, flags) {
  const src = args[0];
  if (!src) {
    fatal(
      "Usage: whissle asr stream <file.wav|-> [--language en] [--metadata emotion,intent|none]\n" +
        "                          [--sample-rate 16000] [--realtime] [--partials] [--json]\n" +
        "  Audio is signed 16-bit little-endian PCM, mono. A mono 16-bit WAV is read directly;\n" +
        "  anything else, convert and pipe:\n" +
        "    ffmpeg -i call.mp3 -f s16le -ar 16000 -ac 1 - | whissle asr stream -\n" +
        "  This command does NOT open your microphone — pipe your own capture in.",
    );
  }
  if (typeof globalThis.WebSocket !== "function") {
    fatal(`Streaming needs a WebSocket, which this Node does not have (${process.version}). Node 22+ has one built in.`);
  }
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    fatal("No API key configured. Run `whissle login` (or set WHISSLE_API_KEY) with a workspace secret key carrying `models:invoke`.", EXIT.AUTH);
  }

  // Validate every flag BEFORE slurping the audio: a typo in --metadata should
  // cost a message, not a pipe that has already drained stdin.
  const frame = configFrame(flags);

  let buf;
  try {
    buf = src === "-" ? await readStdin() : readFileSync(src);
  } catch (e) {
    fatal(`cannot read ${src}: ${e.message}`);
  }
  let layout;
  try {
    layout = pcmLayout(buf);
  } catch (e) {
    fatal(e.message);
  }
  const pcm = buf.subarray(layout.offset);
  if (!pcm.length) fatal("no audio bytes to send.");
  if (layout.sampleRate) frame.sample_rate = layout.sampleRate; // the file's own rate wins
  const rate = frame.sample_rate;
  const seconds = pcm.length / (rate * 2);

  // Said before the socket opens, on stderr, every time — including under
  // --json, where stdout is the caller's data and must stay clean.
  warn(`streaming bills this workspace per second the socket is open (models:invoke). ${seconds.toFixed(1)}s of audio queued.`);

  const url = asrStreamUrl(cfg.apiKey, { baseUrl: cfg.baseUrl });
  const ws = new globalThis.WebSocket(url);
  ws.binaryType = "arraybuffer";
  const chunkMs = Math.max(20, Number(flags["chunk-ms"]) || 100);
  const chunkBytes = Math.floor((rate * 2 * chunkMs) / 1000 / 2) * 2; // whole samples

  let ended = false;
  const done = new Promise((resolve, reject) => {
    ws.addEventListener("error", () => reject(new Error("the speech socket failed to connect or dropped.")));
    ws.addEventListener("close", (e) => {
      // 4001 = not identified / bad token, 4003 = identified but not allowed
      // (a key without models:invoke). Both are key problems, so: exit 2.
      if (e.code === 4001 || e.code === 4003) {
        return reject(
          Object.assign(new Error(`socket refused (${e.code}): ${e.reason || "the key is not valid for streaming speech"}. Needs a wsk_ key with \`models:invoke\`.`), { auth: true }),
        );
      }
      resolve();
    });
    ws.addEventListener("message", (e) => {
      if (typeof e.data !== "string") return; // the engine sends text events only
      let evt;
      try {
        evt = JSON.parse(e.data);
      } catch {
        return out(e.data);
      }
      if (flags.json) return out(JSON.stringify(evt));
      if (evt.type === "transcript" && !evt.is_final && !flags.partials) return;
      const line = eventLine(evt);
      if (!line) return;
      out(evt.type === "transcript" && evt.is_final ? "  " + line : "  " + dim(line));
      if (evt.type === "end") ended = true;
    });
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("close", () => reject(new Error("socket closed before it opened")), { once: true });
    ws.addEventListener("error", () => reject(new Error("socket error before it opened")), { once: true });
  }).catch(() => {}); // the shared `done` promise reports the real reason

  if (ws.readyState === 1) {
    ws.send(JSON.stringify(frame));
    for (const chunk of frames(pcm, chunkBytes)) {
      if (ws.readyState !== 1) break;
      ws.send(chunk);
      if (flags.realtime) await sleep(chunkMs);
      // Backpressure. `send` buffers, so an un-paced send of a long file would
      // queue the whole thing in memory and hand the engine a burst it has to
      // sit on — both of which cost more wall clock on a socket billed by the
      // second than waiting a few milliseconds here does.
      while (ws.bufferedAmount > SEND_HIGH_WATER && ws.readyState === 1) await sleep(5);
    }
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "end" }));
  }

  // The engine flushes after `end`; give it a bounded window to say the last
  // word rather than cutting the transcript off at the last byte we sent.
  const grace = Math.max(1, Number(flags["flush-timeout"]) || 15) * 1000;
  await Promise.race([done, sleep(grace).then(() => { if (ws.readyState <= 1) ws.close(); return done; })])
    .catch((e) => fatal(e.message, e.auth ? EXIT.AUTH : EXIT.GENERIC));
  if (!flags.json && !ended) out(dim("\n  (socket closed)"));
}

export async function run(sub, args, flags) {
  if (!sub || sub === "status") {
    // `/asr/*` is served by the GATEWAY, above the `/bot` platform prefix.
    const cfg = loadConfig();
    const res = await get("/asr/status", { cfg: { ...cfg, baseUrl: gatewayRoot(cfg.baseUrl) } });
    if (flags.json) return printJson(res);
    kv(
      { status: res.status, default_model: res.default_model, device: res.device, ort_version: res.ort_version },
      ["status", "default_model", "device", "ort_version"],
    );
    const models = res.models && typeof res.models === "object" ? Object.entries(res.models) : [];
    if (models.length) {
      out("");
      table(
        ["MODEL", "DECODER", "VOCAB", "LM LANGUAGES"],
        models.map(([id, m]) => [id, m?.decoder ?? "—", m?.vocabulary_size ?? "—", (m?.lm_languages || []).join(", ") || "—"]),
      );
    }
    // Checked against the gateway: /asr/status reports models, decoder and
    // device — it does NOT list which metadata heads are loaded. Saying so is
    // the difference between a caller who reads what comes back and one who
    // promises a customer emotion scores this deployment cannot produce.
    out(dim(`\n  This does not say which metadata tags the loaded model serves — no endpoint does.`));
    out(dim(`  Ask for them on the stream and read what arrives: whissle asr stream <file> --metadata emotion,intent`));
    return;
  }

  if (sub === "stream") return runStream(args, flags);

  fatal(`Unknown: asr ${sub}. Try status | stream <file.wav|->.`);
}
