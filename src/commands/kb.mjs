// whissle kb list|add   — attach knowledge to an agent (RAG). Needs kb:read/write.
import { get, post, upload } from "../api.mjs";
import { out, ok, table, trunc, dim, printJson, fatal } from "../ui.mjs";

export async function run(sub, args, flags) {
  const agentId = args[0] || flags.agent;

  if (!sub || sub === "list") {
    if (!agentId) fatal("Usage: whissle kb list <agent-id>");
    const docs = await get(`/api/agents/${agentId}/kb`);
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
      doc = await post(`/api/agents/${agentId}/kb/from-url`, { url: flags.url });
    } else if (flags.file) {
      doc = await upload(`/api/agents/${agentId}/kb/upload`, { filePath: flags.file, fields: { title: flags.title } });
    } else if (flags.text) {
      doc = await post(`/api/agents/${agentId}/kb`, {
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

  fatal(`Unknown: kb ${sub}. Try list | add.`);
}
