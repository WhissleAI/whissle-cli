// whissle voices — the studio voice catalog: what will an agent actually sound like?
//
// An agent stores a coarse (voice = language, voice_gender) pair; the pipeline
// derives the concrete voice at call time. GET /api/voices returns that
// derivation from the SAME tables the call path resolves through, so what this
// prints is what a call does. Engine/voice ids in the response are printed as
// data. Distinct from `whissle models voices` — the à-la-carte model-API
// catalog for `models tts --voice`.
import { get } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, table, trunc, dim, printJson, fatal } from "../ui.mjs";

/** Client-side filter over the catalog. Pure — exported for tests. */
export function filterVoices(voices, { language, gender } = {}) {
  return (voices || []).filter(
    (v) =>
      (!language || v.language === language) &&
      (!gender || v.gender === gender),
  );
}

export async function run(sub, args, flags) {
  if (sub && sub !== "list") {
    fatal("Usage: whissle voices [--language en|hi|hi-en|te|es|zh] [--gender female|male]");
  }
  const res = await get(EP.voices);
  if (flags.json) return printJson(res);

  const voices = filterVoices(res?.voices, {
    language: typeof flags.language === "string" ? flags.language : undefined,
    gender: typeof flags.gender === "string" ? flags.gender : undefined,
  });
  table(
    ["LANGUAGE", "GENDER", "VOICE", "ENGINE", "LOCALE"],
    voices.map((v) => [
      v.language, v.gender, trunc(v.voice_id || "—", 32), v.engine || "—", v.locale || "—",
    ]),
  );
  const langs = (res?.languages || []).map((l) => `${l.value} (${l.label})`).join(", ");
  out(dim(`\n  ${voices.length} voice(s)` + (langs ? `  ·  languages: ${langs}` : "")));
  out(dim("  Pick one on an agent: whissle agents update <id> --voice <language> --voice-gender <gender>"));
  if (res?.pricing) out(dim(`  pricing: ${JSON.stringify(res.pricing)}`));
}
