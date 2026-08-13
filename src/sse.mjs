// Server-Sent Events, parsed the way the gateway actually emits them.
//
// The CLI needs this for exactly one thing today — `POST /api/chat/stream`, the
// companion's narrated turn (`open` → (`delta` | `tool`)* → `done`). But a
// terminal is the surface streaming was invented for, so the parser lives on its
// own here rather than inline in a command: it is pure, it is testable without a
// socket, and the next streamed endpoint gets it for free.
//
// Two properties matter more than they look:
//
//   * A frame can be split across ANY number of network chunks. `data:` lines
//     routinely arrive cut in half; a parser that assumes chunk == frame drops
//     tokens silently, which reads as the model swallowing words.
//   * A line starting with `:` is a COMMENT, not a frame. The gateway sends
//     `: ping` every ~15s so an idle proxy between us and the model does not
//     close a `deep_research` turn that is legitimately silent for 100 seconds.
//     Treating it as a frame yields a phantom event with no type.

/**
 * Parse ONE frame block (the text between blank lines) into `{event, data}`.
 *
 * `data` is the JSON payload when it parses, and the raw string when it does
 * not — a malformed payload must not take the stream down, because by the time
 * we see it the bytes are already gone and there is nothing to retry.
 * Returns `null` for a block that carries no data lines (a bare comment).
 *
 * Pure — exported for tests.
 */
export function parseFrame(block) {
  let event = "message";
  const data = [];
  for (const raw of block.split("\n")) {
    // A CRLF stream splits on "\n" and leaves the "\r" glued to the value — so
    // the event type becomes "delta\r", which matches nothing and makes every
    // frame look unrecognised.
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line || line.startsWith(":")) continue; // keep-alive comment
    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    // Exactly one optional leading space is stripped, per the EventSource spec.
    let value = idx === -1 ? "" : line.slice(idx + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (!data.length) return null;
  const raw = data.join("\n");
  let parsed = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* a non-JSON payload is handed through verbatim */
  }
  return { event, data: parsed, raw };
}

/**
 * Turn a stream of byte/string chunks into frames.
 *
 * Buffers across chunk boundaries and accepts both `\n\n` and `\r\n\r\n` as the
 * separator (an intermediary can rewrite line endings; ours does not, but the
 * cost of tolerating it is one regex).
 *
 * Exported for tests — feed it any async iterable of strings.
 */
export async function* sseFrames(chunks) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of chunks) {
    buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let sep;
    while ((sep = buf.search(/\r?\n\r?\n/)) !== -1) {
      const end = sep + buf.slice(sep).match(/^\r?\n\r?\n/)[0].length;
      const frame = parseFrame(buf.slice(0, sep));
      buf = buf.slice(end);
      if (frame) yield frame;
    }
  }
  // A stream that ended without its final blank line still has one frame in it.
  const tail = buf.trim() ? parseFrame(buf) : null;
  if (tail) yield tail;
}
