// whissle models chat|tts|transcribe|voices   — the à-la-carte model API (models:invoke).
import { writeFileSync } from "node:fs";
import { get, post, upload, raw } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, ok, md, table, dim, printJson, fatal } from "../ui.mjs";

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
    const r = await post(EP.models.chat, { messages, fast: !!flags.fast, ...(flags["max-tokens"] ? { max_tokens: Number(flags["max-tokens"]) } : {}) });
    if (flags.json) return printJson(r);
    out(md(r.text));
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
    // Transcribe a pre-recorded file (calls, meetings). You pick the LANGUAGE;
    // the platform picks the engine — the model/provider is never exposed.
    const file = args[0] || fatal(
      "Usage: whissle models transcribe <audio-file> [--language en|hi|te|hinglish|tenglish] [--diarize]");
    const r = await upload(EP.models.transcribe, {
      filePath: file,
      fields: { language: flags.language || "", diarize: flags.diarize ? "true" : "false" },
    });
    if (flags.json) return printJson(r);
    out(md(r.text));
    out(dim(`\n  ${r.duration_seconds ?? "?"}s · $${r.cost_usd ?? "?"}` +
      (Array.isArray(r.segments) ? ` · ${r.segments.length} segment(s)` : "")));
    return;
  }

  fatal(`Unknown: models ${sub}. Try chat | tts | transcribe | voices.`);
}
