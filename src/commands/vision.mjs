// whissle vision ask|batch — one image, one question, one short answer.
//
// `POST /api/agents/{id}/vision` takes a data-URL image and a question and
// answers `{answer, clear, model_tier, trace_id}`. `clear:false` is the model
// saying nothing is clearly visible — shown as such rather than dressed up as
// an answer. Priced as a vision call, metered under service `vision`.
// `batch` fans out up to 40 `{id, image, question, hint?}` items.
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { post } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, md, dim, printJson, fatal, table, trunc } from "../ui.mjs";
import { contractFooterLines } from "../turn.mjs";

const IMAGE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** The most items one batch call accepts (the server refuses more). */
export const BATCH_MAX = 40;

/**
 * A path → the data URL the door takes; a value that already IS a data URL is
 * passed through untouched (a batch file may mix both). Pure given `read` —
 * exported for tests.
 */
export function imageDataUrl(pathOrUrl, read = readFileSync) {
  if (/^data:image\//i.test(pathOrUrl)) return pathOrUrl;
  const mime = IMAGE_MIME[extname(pathOrUrl).toLowerCase()];
  if (!mime) fatal(`${pathOrUrl}: images must be .png, .jpg, .webp or .gif (or a data: URL).`);
  return `data:${mime};base64,${Buffer.from(read(pathOrUrl)).toString("base64")}`;
}

/** The `ask` body. Pure — exported for tests. */
export function askBody({ image, question, hint, maxWords }) {
  return {
    image,
    question,
    ...(hint ? { hint } : {}),
    ...(maxWords ? { max_words: parseInt(maxWords, 10) } : {}),
  };
}

/** The `batch` body from a parsed items file. Pure given `read` — exported for tests. */
export function batchBody(items, { concurrency, read = readFileSync } = {}) {
  const list = Array.isArray(items) ? items : items?.items;
  if (!Array.isArray(list) || !list.length) fatal("--file must hold a JSON array of {id, image, question, hint?} items.");
  if (list.length > BATCH_MAX) fatal(`A batch takes at most ${BATCH_MAX} items; this file has ${list.length}.`);
  return {
    items: list.map((it, i) => {
      if (!it || !it.image || !it.question) fatal(`item ${i}: needs both "image" and "question".`);
      return {
        id: it.id != null ? String(it.id) : String(i),
        image: imageDataUrl(String(it.image), read),
        question: String(it.question),
        ...(it.hint ? { hint: String(it.hint) } : {}),
      };
    }),
    ...(concurrency ? { concurrency: parseInt(concurrency, 10) } : {}),
  };
}

export async function run(sub, args, flags) {
  if (sub === "ask") {
    const [agentId, image, ...q] = args;
    const question = q.join(" ") || (typeof flags.question === "string" ? flags.question : "");
    if (!agentId || !image || !question) {
      fatal('Usage: whissle vision ask <agent-id> <image.png> "what is this?" [--hint …] [--max-words 40]');
    }
    const r = await post(
      EP.agents.vision(agentId),
      askBody({ image: imageDataUrl(image), question, hint: flags.hint, maxWords: flags["max-words"] }),
    );
    if (flags.json) return printJson(r);
    if (r.clear === false) out(dim("(nothing clearly visible)"));
    out(md(r.answer || dim("(no answer)")));
    for (const l of contractFooterLines(r)) out(l);
    return;
  }

  if (sub === "batch") {
    const agentId = args[0] || fatal("Usage: whissle vision batch <agent-id> --file items.json [--concurrency 2]");
    if (typeof flags.file !== "string") fatal("--file items.json is required (a JSON array of {id, image, question, hint?}).");
    let items;
    try { items = JSON.parse(readFileSync(flags.file, "utf8")); }
    catch (e) { fatal(`--file: cannot read ${flags.file} as JSON (${e.message})`); }
    const r = await post(EP.agents.visionBatch(agentId), batchBody(items, { concurrency: flags.concurrency }));
    if (flags.json) return printJson(r);
    const results = r?.results || [];
    table(["ID", "CLEAR", "ANSWER"], results.map((x) => [x.id, x.clear === false ? "no" : "yes", trunc(x.answer || "", 70)]));
    out(dim(`\n  ${results.length} result(s)`));
    return;
  }

  fatal(`Unknown: vision ${sub || ""}. Try ask <agent-id> <image> "<question>" | batch <agent-id> --file items.json.`);
}
