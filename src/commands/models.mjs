// whissle models chat|tts|transcribe|voices   — the à-la-carte model API (models:invoke).
import { writeFileSync } from "node:fs";
import { get, post, upload, raw } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, ok, md, table, dim, warn, printJson, fatal } from "../ui.mjs";

/**
 * The speech engines `--engine` may name (routes/models.py `_ENGINES`).
 *
 * `whissle` is Whissle's own model: it is the only one that also produces
 * ACOUSTIC METADATA (emotion, intent, age, gender, …) alongside the words, which
 * is the whole reason to ask for it by name. The other three are third parties
 * that return text and nothing else.
 *
 * `verbit` is ENGLISH ONLY, and naming it for another language degrades to the
 * platform default — which the response tells you about, in `warnings`. It also
 * runs on Verbit's streaming socket rather than a batch job, so a long upload
 * takes roughly as long as the audio; for hours of media, prefer another engine.
 */
export const ENGINES = ["deepgram", "sarvam", "whissle", "verbit"];

/**
 * The `engine` form field from `--engine`, or `undefined` to let the platform
 * pick from the language (the behaviour every pre-1.6 caller got).
 *
 * Validated here rather than at the server so a typo costs a round-trip and not
 * an upload. Pure — exported for tests.
 */
export function engineField(flags) {
  if (flags.engine === undefined) return undefined;
  const asked = String(flags.engine).trim().toLowerCase();
  if (!ENGINES.includes(asked)) {
    fatal(`--engine must be one of ${ENGINES.join(" | ")} (got "${flags.engine}"). Omit it to let the platform pick from --language.`);
  }
  return asked;
}

/**
 * The one-line footer under a transcript.
 *
 * `engine` is only in the response when the caller NAMED one, and it is the
 * engine that actually RAN — which is not always the one asked for. Pure —
 * exported for tests.
 */
export function transcribeFooter(r) {
  const bits = [`${r.duration_seconds ?? "?"}s`, `$${r.cost_usd ?? "?"}`];
  if (Array.isArray(r.segments)) bits.push(`${r.segments.length} segment(s)`);
  if (r.engine) bits.push(`engine: ${r.engine}`);
  if (r.metadata && typeof r.metadata === "object") {
    const tags = Object.keys(r.metadata).filter((k) => !k.endsWith("_confidence") && k !== "probs");
    if (tags.length) bits.push(`metadata: ${tags.join(", ")}`);
  }
  return bits.join(" · ");
}

export async function run(sub, args, flags) {
  if (sub === "voices") {
    // Discovery: the voice ids you can pass to `--voice` (tts) or an agent's voice.
    const r = await get(EP.models.voices);
    if (flags.json) return printJson(r);
    const voices = r.voices || [];
    table(
      ["ID", "NAME", "ENGINE", "GENDER", "ACCENT"],
      voices.map((v) => [v.id, v.name || "—", v.engine || "—", v.gender || "—", v.accent || "—"]),
    );
    out(dim(`\n  ${voices.length} voice(s)` + (r.default_engine ? ` · default engine: ${r.default_engine}` : "")));
    return;
  }

  if (sub === "chat") {
    const prompt = args.join(" ") || fatal('Usage: whissle models chat "your prompt"');
    const messages = [];
    if (flags.system) messages.push({ role: "system", content: flags.system });
    messages.push({ role: "user", content: prompt });
    // --json-object asks the ENDPOINT to constrain the decode, which is not the
    // same as --json (that one is this CLI's machine-output flag). Two different
    // things that both say json, so the help text names the distinction.
    const r = await post(EP.models.chat, {
      messages,
      fast: !!flags.fast,
      ...(flags["max-tokens"] ? { max_tokens: Number(flags["max-tokens"]) } : {}),
      ...(flags["json-object"] ? { response_format: { type: "json_object" } } : {}),
    });
    if (flags.json) return printJson(r);
    // A tool-calling turn returns EMPTY text — that is the answer, not a
    // failure — so print the calls rather than a blank line.
    if (r.tool_calls?.length) {
      for (const c of r.tool_calls) out(`  ${c.name}(${JSON.stringify(c.input ?? {})})`);
    } else {
      out(md(r.text));
    }
    if (r.json_valid === false) {
      out(dim("\n  json_valid=false — the reply did not parse. Usually truncation:"));
      out(dim("  raise --max-tokens and check finish_reason."));
    }
    out(dim(`\n  ${r.usage?.input_tokens ?? "?"}→${r.usage?.output_tokens ?? "?"} tokens · $${r.cost_usd ?? "?"} · ${r.latency_ms ?? "?"}ms`));
    return;
  }

  if (sub === "tts") {
    const text = args.join(" ") ||
      fatal('Usage: whissle models tts "text to speak" --out hello.mp3 [--language en|hi|te|hinglish|tenglish] [--voice <id>]');
    const outPath = flags.out || "speech.mp3";
    // --language picks a voice that speaks that language; omit it and the platform
    // auto-detects from the script (Devanagari→Hindi, Telugu→Telugu). Engine hidden.
    const res = await raw("POST", EP.models.tts, {
      body: {
        text,
        language: flags.language,
        voice: flags.voice,
        output_format: flags["output-format"],
      },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(outPath, buf);
    ok(`Wrote ${buf.length} bytes → ${outPath}` + (res.headers.get("x-cost-usd") ? `  ($${res.headers.get("x-cost-usd")})` : ""));
    return;
  }

  if (sub === "transcribe") {
    // Transcribe a pre-recorded file (calls, meetings). You pick the LANGUAGE,
    // and — since 1.6.0 — you may also name the ENGINE. Omit `--engine` and the
    // platform still picks one from the language, exactly as it always did.
    const file = args[0] || fatal(
      "Usage: whissle models transcribe <audio-file> [--language en|hi|te|hinglish|tenglish] [--diarize] [--engine whissle|deepgram|sarvam|verbit]");
    const engine = engineField(flags);
    const r = await upload(EP.models.transcribe, {
      filePath: file,
      fields: { language: flags.language || "", diarize: flags.diarize ? "true" : "false", ...(engine ? { engine } : {}) },
    });
    if (flags.json) return printJson(r);
    // Warnings FIRST and on stderr: the platform degrades rather than failing,
    // so a transcript that came from a different engine than you asked for
    // still arrives looking perfectly fine. Printing that after the text (or
    // not at all) is how someone ends up believing a Deepgram transcript
    // carries Whissle metadata.
    for (const w of Array.isArray(r.warnings) ? r.warnings : []) warn(w);
    out(md(r.text));
    out(dim(`\n  ${transcribeFooter(r)}`));
    return;
  }

  fatal(`Unknown: models ${sub}. Try chat | tts | transcribe | voices.`);
}
