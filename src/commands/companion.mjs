// whissle companion — YOUR assistant, in the terminal.
//
// Every other command in this CLI operates on the workspace: agents you built,
// calls they took, numbers they answer. This one talks to the assistant that is
// yours — the one that knows your org, your persona, your connected accounts and
// your own documents. It had no CLI at all until now, because until gateway PR
// #689 the whole surface was cookie-only: a browser could reach it and a key
// could not. That PR put `companion:invoke` on it, and this is the door.
//
// It is NOT `whissle chat <agent-id>` with a different id. The companion has no
// agents row; it is assembled per request from the type config, the org's tool
// grants, your persona, your integrations and your personal knowledge base. A
// `wsk_` key resolves to ONE PERSON — the member who created it — so this
// reaches that person's companion and nobody else's, which is also why no path
// or body field here names a user.
//
// Streaming is the default, because a terminal is the surface streaming was
// invented for. A `deep_research` turn is up to a minute of work; the buffered
// door returns a receipt after it, and the streamed door narrates it while it
// happens ("Planning the research…", "Reading 12 sources…") using the exact same
// tool-event dicts a voice session receives over RTVI. `--no-stream` takes the
// buffered door for anything that would rather have one JSON body.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { createInterface } from "node:readline";
import { get, post, postStream } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, err, ok, md, dim, brand, bold, kv, table, trunc, spinner, printJson, fatal } from "../ui.mjs";
import { toolEventLine, turnFooterLines } from "../turn.mjs";

/** A new per-run thread key. Exported for tests. */
export function newSessionId() {
  return `cli-${randomUUID()}`;
}

const IMAGE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/**
 * A local image file → the data URL the API takes.
 *
 * Only the three types the backend accepts; anything else is refused HERE with
 * the name of the file, rather than as a 4xx three seconds later that says only
 * "unsupported media type".
 */
export function imageDataUrl(path, read = readFileSync) {
  const mime = IMAGE_MIME[extname(path).toLowerCase()];
  if (!mime) fatal(`${path}: images must be .png, .jpg or .webp.`);
  return `data:${mime};base64,${Buffer.from(read(path)).toString("base64")}`;
}

/**
 * The request body. `text` — NOT `message`, which is the AGENT chat route's
 * field; sending the wrong one is a clean 422 and no reply. Exported for tests.
 *
 * `session_id` IS the thread handle here: the companion opens or resumes a
 * per-user thread keyed on it, so two invocations that pass the same id are one
 * conversation. (The agent route threads on `conversation_id` instead — the two
 * doors genuinely differ, and this is the only place that difference shows.)
 */
export function turnBody({ text, sessionId, language, prompt, images }) {
  return {
    text,
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(language ? { language } : {}),
    ...(prompt ? { prompt } : {}),
    ...(images && images.length ? { images } : {}),
  };
}

/** How many live voice sessions a refresh actually touched. Exported for tests. */
export function refreshedCount(v) {
  if (Array.isArray(v)) return v.length;
  return typeof v === "number" ? v : 0;
}

/**
 * Drain a streamed turn, writing as it arrives, and return the terminal payload.
 *
 * The hop rule is the subtle part and it is load-bearing: a turn is a LOOP, and
 * concatenating every delta is NOT the reply. Hop 0 is often narration ("let me
 * look that up") followed by tool calls; hop 1 is the answer — exactly as voice
 * speaks the narration and then speaks the answer. So deltas are printed live
 * per hop (that is the whole value of streaming), and the transcript of record
 * comes from `done.reply`. `{reset:true}` means a provider died mid-hop and the
 * other one restarted it, so what was printed for that hop is now wrong; we say
 * so rather than leaving retracted text on screen as if it were the answer.
 *
 * Exported for tests — pass any async iterable of frames.
 */
export async function drainStream(frames, { write = (s) => process.stdout.write(s), onTool } = {}) {
  let payload = null;
  let hop = null;
  let wrote = false;
  for await (const f of frames) {
    if (f.event === "delta") {
      const d = f.data || {};
      if (d.reset) {
        write(dim("\n  (that provider dropped — restarting this part)\n"));
        continue;
      }
      if (!d.text) continue;
      if (hop !== null && d.hop !== hop) write("\n");
      hop = d.hop;
      write(d.text);
      wrote = true;
    } else if (f.event === "tool") {
      if (wrote) write("\n");
      wrote = false;
      (onTool || ((ev) => write(toolEventLine(ev) + "\n")))(f.data);
    } else if (f.event === "done") {
      payload = f.data;
    } else if (f.event === "error") {
      const e = f.data || {};
      throw new Error(e.message || "The stream failed.");
    }
  }
  if (wrote) write("\n");
  // A stream that ends with neither `done` nor `error` is a transport failure
  // (a proxy timed out). The turn still completed server-side — say that,
  // because "no output" otherwise reads as the assistant having nothing to say.
  if (!payload) {
    throw new Error(
      "The stream ended without a result — the connection dropped. The turn still ran; " +
        "read it with `whissle sessions list --agent companion`.",
    );
  }
  return payload;
}

/** Print reply + citations for a completed (buffered) turn. */
function renderTurn(payload, { verbose, showTools }) {
  out(md(payload.reply || dim("(no reply)")));
  for (const l of turnFooterLines(payload, { verbose, showTools })) out(l);
}

async function runTurn({ text, sessionId, flags, images }) {
  const body = turnBody({
    text,
    sessionId,
    language: typeof flags.language === "string" ? flags.language : undefined,
    prompt: typeof flags.prompt === "string" ? flags.prompt : undefined,
    images,
  });
  if (flags["no-stream"]) {
    const stop = spinner("thinking…");
    try {
      return await post(EP.companion.turn, body);
    } finally {
      stop();
    }
  }
  return { __stream: await postStream(EP.companion.stream, body) };
}

export async function run(sub, args, flags) {
  // ── read-only sub-surfaces ────────────────────────────────────────────────
  if (sub === "info") {
    const c = await get(EP.companion.get);
    if (flags.json) return printJson(c);
    out(brand("● ") + bold(c.name || "Companion") + dim(`  (${c.agent_type || "companion"})`));
    if (c.description) out("  " + dim(c.description));
    out("");
    kv({
      id: c.id,
      virtual: c.virtual,
      "your voice sessions": c.totals?.voice ?? 0,
      "your text sessions": c.totals?.text ?? 0,
    });
    return out(dim("\n  History: whissle sessions list --agent companion"));
  }

  if (sub === "context") {
    // What the companion knows about the workspace before you type anything —
    // the same block that goes into its system prompt. Worth its own command:
    // when it answers "what agents do I have?" wrongly, this is where you look.
    const ctx = await get(EP.companion.context);
    if (flags.json) return printJson(ctx);
    const org = ctx.org || {};
    out(bold(org.name || "(workspace)") + dim(`  ${org.member_count ?? "?"} member(s)`));
    out("\n" + dim(`agents (${(ctx.agents || []).length})`));
    table(
      ["NAME", "VOICE"],
      (ctx.agents || []).map((a) => [trunc(a.name || "—", 34), a.voice || "—"]),
    );
    out("\n" + dim(`recent calls (${(ctx.recent_calls || []).length})`));
    table(
      ["AGENT", "STATUS", "WHEN"],
      (ctx.recent_calls || []).slice(0, 15).map((c) => [
        trunc(c.agent_name || "—", 24),
        c.status || "—",
        String(c.created_at || "").slice(0, 16).replace("T", " "),
      ]),
    );
    return;
  }

  if (sub === "refresh") {
    // Reconnected an integration in the browser? The companion picks it up on
    // its next TEXT message by itself; a LIVE VOICE session will not, because
    // its tool list was assembled when the session opened. Pass the `pc_id` that
    // session returned and it is refreshed in place, without a reconnect.
    const pcId = args[0] || (typeof flags["pc-id"] === "string" ? flags["pc-id"] : undefined);
    const r = await post(EP.companion.refreshIntegrations, pcId ? { pc_id: pcId } : {});
    if (flags.json) return printJson(r);
    // `live_sessions_refreshed` comes back as a LIST of the sessions touched —
    // and an empty list is truthy, so a naive `x ? … : ""` prints "· live
    // session(s)" with no number in the overwhelmingly common zero case.
    const n = refreshedCount(r.live_sessions_refreshed);
    ok(`Integrations reloaded${n ? ` · ${n} live session(s) updated` : ""}.`);
    const eff = r.effective || {};
    return out(dim(`  text: ${eff.text || "next-message"} · voice: ${eff.voice || "next-turn"}`));
  }

  if (sub === "sessions") {
    // Deliberately a POINTER, not a second implementation. `sessions list` is
    // already the union of voice and text and already accepts the `companion`
    // sentinel; a parallel listing here would be a second thing to keep correct.
    return out(
      dim("Your companion history lives in `sessions`:\n") +
        "  whissle sessions list --agent companion\n" +
        "  whissle sessions get <session-id>\n" +
        "  whissle sessions trace <session-id>",
    );
  }

  // ── the turn itself ───────────────────────────────────────────────────────
  // `whissle companion ask "…"`, `whissle companion -m "…"`, or bare for a REPL.
  const oneShot =
    (typeof flags.m === "string" && flags.m) ||
    (typeof flags.message === "string" && flags.message) ||
    (sub === "ask" ? args.join(" ") : sub ? [sub, ...args].join(" ") : "");

  const images = []
    .concat(flags.image || [])
    .filter((p) => typeof p === "string")
    .map((p) => imageDataUrl(p));

  // A session id you passed is a thread you are RESUMING; one we mint is a new
  // thread, and we say what it is so the next invocation can continue it. This
  // is the whole difference between a scriptable conversation and a series of
  // strangers.
  const resuming = typeof flags.session === "string" && flags.session;
  const sessionId = resuming || newSessionId();

  if (oneShot || images.length) {
    const text = oneShot || "What do you make of this?";
    const r = await runTurn({ text, sessionId, flags, images });

    if (r.__stream) {
      // `--json` still means "the API payload", even here: a script that pipes
      // us into jq must not have to strip narration out of stdout. So in JSON
      // mode the frames are consumed silently and only the terminal payload is
      // printed — unless you asked for the frames themselves with --events.
      if (flags.json && flags.events) {
        for await (const f of r.__stream) out(JSON.stringify({ event: f.event, data: f.data }));
        return;
      }
      const payload = await drainStream(r.__stream, {
        write: flags.json ? () => {} : (s) => process.stdout.write(s),
      });
      if (flags.json) printJson(payload);
      else for (const l of turnFooterLines(payload, { verbose: flags.verbose, tools: "none" })) out(l);
      if (!resuming) err(dim(`\nthread: --session ${sessionId}`));
      return;
    }

    if (flags.json) return printJson(r);
    renderTurn(r, { verbose: flags.verbose, showTools: flags.tools });
    if (!resuming) err(dim(`\nthread: --session ${sessionId}`));
    return;
  }

  // ── interactive ───────────────────────────────────────────────────────────
  if (flags.json) fatal("`--json` needs a message: whissle companion -m \"…\" --json");

  const info = await get(EP.companion.get).catch(() => null);
  out(brand("● ") + bold(info?.name || "Companion") + dim(streamNote(flags)));
  out(dim("Type a message. /exit to quit, /new for a fresh thread, /thread to print the id."));
  out(dim(`This conversation is saved — read it with \`whissle sessions list --agent companion\`\n`));
  if (resuming) out(dim(`resuming thread ${sessionId}\n`));

  let thread = sessionId;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => process.stdout.write(brand("you › "));
  prompt();

  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) return prompt();
    if (text === "/exit" || text === "/quit") return rl.close();
    if (text === "/thread") {
      out(dim(`  --session ${thread}`));
      return prompt();
    }
    if (text === "/new") {
      thread = newSessionId();
      ok(`New thread (${thread}).`);
      return prompt();
    }
    rl.pause();
    try {
      const r = await runTurn({ text, sessionId: thread, flags, images: [] });
      if (r.__stream) {
        process.stdout.write("\n" + brand("● "));
        const payload = await drainStream(r.__stream);
        for (const l of turnFooterLines(payload, { verbose: flags.verbose, tools: "none" })) out(l);
      } else {
        out("\n" + brand("● "));
        renderTurn(r, { verbose: flags.verbose, showTools: flags.tools });
      }
      out("");
    } catch (e) {
      err(brand("✗ ") + (e.message || e));
    }
    rl.resume();
    prompt();
  });

  await new Promise((resolve) => rl.on("close", resolve));
  out(dim(`\nbye.  (resume: whissle companion --session ${thread})`));
}

function streamNote(flags) {
  return flags["no-stream"] ? "  (buffered)" : "  (streaming)";
}
