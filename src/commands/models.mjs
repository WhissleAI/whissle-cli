// whissle models chat|tts|transcribe   — the à-la-carte model API (models:invoke).
import { writeFileSync } from "node:fs";
import { post, upload, raw } from "../api.mjs";
import { out, ok, md, dim, printJson, fatal } from "../ui.mjs";

export async function run(sub, args, flags) {
  if (sub === "chat") {
    const prompt = args.join(" ") || fatal('Usage: whissle models chat "your prompt"');
    const messages = [];
    if (flags.system) messages.push({ role: "system", content: flags.system });
    messages.push({ role: "user", content: prompt });
    const r = await post("/api/models/chat", { messages, fast: !!flags.fast, ...(flags["max-tokens"] ? { max_tokens: Number(flags["max-tokens"]) } : {}) });
    if (flags.json) return printJson(r);
    out(md(r.text));
    out(dim(`\n  ${r.usage?.input_tokens ?? "?"}→${r.usage?.output_tokens ?? "?"} tokens · $${r.cost_usd ?? "?"} · ${r.latency_ms ?? "?"}ms`));
    return;
  }

  if (sub === "tts") {
    const text = args.join(" ") || fatal('Usage: whissle models tts "text to speak" --out hello.mp3');
    const outPath = flags.out || "speech.mp3";
    const res = await raw("POST", "/api/models/tts", {
      body: { text, voice: flags.voice, output_format: flags["output-format"] },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(outPath, buf);
    ok(`Wrote ${buf.length} bytes → ${outPath}` + (res.headers.get("x-cost-usd") ? `  ($${res.headers.get("x-cost-usd")})` : ""));
    return;
  }

  if (sub === "transcribe") {
    const file = args[0] || fatal("Usage: whissle models transcribe <audio-file> [--language xx] [--diarize]");
    const r = await upload("/api/models/transcribe", {
      filePath: file,
      fields: { language: flags.language || "", model: flags.model || "", diarize: flags.diarize ? "true" : "false" },
    });
    if (flags.json) return printJson(r);
    out(md(r.text));
    out(dim(`\n  ${r.duration_seconds ?? "?"}s · $${r.cost_usd ?? "?"}`));
    return;
  }

  fatal(`Unknown: models ${sub}. Try chat | tts | transcribe.`);
}
