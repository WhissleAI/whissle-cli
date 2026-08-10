// whissle kb list|add|update|remove — attach knowledge to an agent (RAG).
// Needs kb:read / kb:write.
import { del, get, patch, post, upload } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, ok, table, trunc, dim, printJson, fatal } from "../ui.mjs";

export async function run(sub, args, flags) {
  const agentId = args[0] || flags.agent;
  // Positionals after the agent id. With `--agent <id>` the agent never took a
  // positional slot, so nothing was consumed and args[0] is already the doc id.
  const rest = flags.agent && !args[0] ? args : args.slice(1);

  if (!sub || sub === "list") {
    if (!agentId) fatal("Usage: whissle kb list <agent-id>");
    const docs = await get(EP.agents.kb.base(agentId));
    if (flags.json) return printJson(docs);
    table(
      ["ID", "TITLE", "SOURCE", "CHARS"],
      (docs || []).map((d) => [d.id, trunc(d.title || "—", 34), d.source_type || "—", d.char_count ?? "—"]),
    );
    out(dim(`\n  ${(docs || []).length} document(s)`));
    return;
  }

  if (sub === "add") {
    if (!agentId) fatal("Usage: whissle kb add <agent-id> [--text … | --file f.pdf | --url https://…]");
    let doc;
    if (flags.url) {
      doc = await post(EP.agents.kb.fromUrl(agentId), { url: flags.url });
    } else if (flags.file) {
      doc = await upload(EP.agents.kb.upload(agentId), { filePath: flags.file, fields: { title: flags.title } });
    } else if (flags.text) {
      doc = await post(EP.agents.kb.base(agentId), {
        title: flags.title || "Snippet",
        content: flags.text,
        source_type: "snippet",
      });
    } else {
      fatal("Provide one of --text, --file, or --url.");
    }
    if (flags.json) return printJson(doc);
    ok(`Added to knowledge base${doc?.id ? ` (${doc.id})` : ""}.` + (doc?.job_id ? ` Ingest job ${doc.job_id}.` : ""));
    return;
  }

  if (sub === "update") {
    // Re-sync a document in place. The point is that this REPLACES rather than
    // adds: a pipeline that pushes knowledge from a source of truth on every
    // change would otherwise leave the agent holding every past revision, and
    // retrieval would happily quote the oldest one.
    const docId = rest[0] || fatal("Usage: whissle kb update <agent-id> <doc-id> [--title …] [--text …]");
    const body = {};
    if (flags.title && flags.title !== true) body.title = flags.title;
    if (flags.text && flags.text !== true) body.content = flags.text;
    if (!Object.keys(body).length) fatal("Nothing to change — pass --title and/or --text.");
    const doc = await patch(EP.agents.kb.doc(agentId, docId), body);
    if (flags.json) return printJson(doc);
    ok(`Updated "${doc?.title ?? docId}"${"content" in body ? " (reindexed)" : ""}.`);
    return;
  }

  if (sub === "remove") {
    const docId = rest[0] || fatal("Usage: whissle kb remove <agent-id> <doc-id> [--force]");
    if (!flags.force) {
      fatal(`This deletes the document AND disarms any lookup tool built from it. Re-run with --force.`);
    }
    await del(EP.agents.kb.doc(agentId, docId));
    ok(`Removed document ${docId}.`);
    return;
  }

  fatal(`Unknown: kb ${sub}. Try list | add | update | remove.`);
}
