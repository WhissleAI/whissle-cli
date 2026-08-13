// whissle kb list|add|update|remove — attach knowledge to an AGENT (RAG).
// whissle kb me  list|add|get|remove   — YOUR OWN documents, no agent involved.
// Needs kb:read / kb:write for both.
//
// The two are genuinely different things and share only a scope. An agent's KB
// is org property that grounds what that agent says to strangers. `/api/me/kb`
// (migration 157) is one person's private library: it belongs to the member who
// uploaded it, it is readable only by them, and it is never folded into any
// agent's prompt — the companion reads it on their behalf and cites it back.
//
// A `wsk_` key resolves to ONE PERSON, so `kb me` reaches its creator's
// documents and nobody else's. No route under it takes a user id, which is why
// that isolation is a property of the SQL rather than of a check anyone could
// forget — and why there is no `--user` flag here to ask for.
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { del, get, patch, post, raw, upload } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, ok, warn, table, trunc, dim, kv, printJson, fatal } from "../ui.mjs";

/**
 * The filename to write a downloaded document to.
 *
 * Prefers `--out`, then the server's Content-Disposition (the original name it
 * was uploaded under), then the doc id. Any path component in the server's name
 * is stripped: a filename is data that came from an upload, and a downloader
 * that honours `../` in it writes wherever that says.
 *
 * Exported for tests.
 */
export function downloadName({ out: flag, disposition, docId }) {
  if (typeof flag === "string" && flag) return flag;
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition || "");
  const name = m ? basename(decodeURIComponent(m[1])) : "";
  return name && name !== "." && name !== ".." ? name : `${docId}.bin`;
}

/** `whissle kb me …` — the caller's own documents. */
async function runMine(sub, args, flags) {
  if (!sub || sub === "list") {
    const r = await get(EP.me.kb.base, {
      query: { limit: flags.limit, offset: flags.offset },
    });
    if (flags.json) return printJson(r);
    const docs = r?.documents || [];
    table(
      ["ID", "TITLE", "SOURCE", "CHARS", "ADDED"],
      docs.map((d) => [
        d.id,
        trunc(d.title || d.file_name || "—", 32),
        d.source_type || "—",
        d.char_count ?? "—",
        String(d.created_at || "").slice(0, 10),
      ]),
    );
    return out(dim(`\n  ${docs.length} document(s) — yours alone; no agent can read these.`));
  }

  if (sub === "add") {
    const file = (typeof flags.file === "string" && flags.file) || args[0];
    if (!file) fatal("Usage: whissle kb me add <file> [--session <chat-session-id>]");
    // `--session` tells the companion's thread the file arrived, so it can say
    // "got it" and answer from the document on the very next message instead of
    // needing to be told a file exists.
    const r = await upload(EP.me.kb.base, {
      filePath: file,
      ...(typeof flags.session === "string" ? { fields: { session_id: flags.session } } : {}),
    });
    if (flags.json) return printJson(r);
    // The ingest MANIFEST, not a green tick. The backend goes out of its way to
    // refuse a file it could not read (422 with the reason) rather than store an
    // empty document — so the CLI must not undo that by printing "✓ added" over
    // a document with zero chunks. `searchable: false` means it is stored and
    // NOT answerable-from, and that is the one line worth shouting.
    const d = r.document || {};
    ok(`Added "${d.title || basename(file)}"${d.id ? ` (${d.id})` : ""}.`);
    kv({
      characters: d.chars,
      chunks: d.chunks,
      replaced: d.replaced || undefined,
      searchable: r.searchable,
      "told the companion": r.announced,
    });
    for (const w of r.warnings || []) {
      for (const f of w.findings || [{ detail: w.detail || JSON.stringify(w) }]) {
        warn(f.detail || f.kind || "check this document");
      }
    }
    if (r.searchable === false) {
      warn("Stored, but NOT indexed — nothing can answer from it yet.");
    }
    return out(dim("\n  Ask about it: whissle companion -m \"what does <that document> say about …\""));
  }

  if (sub === "get" || sub === "download") {
    const docId = args[0] || fatal("Usage: whissle kb me get <doc-id> [--out file]");
    const res = await raw("GET", EP.me.kb.file(docId) + "?disposition=attachment");
    const name = downloadName({
      out: flags.out,
      disposition: res.headers.get("content-disposition"),
      docId,
    });
    writeFileSync(name, Buffer.from(await res.arrayBuffer()));
    if (flags.json) return printJson({ document_id: docId, file: name });
    return ok(`Saved → ${name}`);
  }

  if (sub === "remove" || sub === "delete") {
    const docId = args[0] || fatal("Usage: whissle kb me remove <doc-id> [--force]");
    if (!flags.force) fatal("This permanently deletes the document and its chunks. Re-run with --force.");
    const r = await del(EP.me.kb.doc(docId));
    if (flags.json) return printJson(r ?? { deleted: docId });
    return ok(`Removed document ${docId}.`);
  }

  fatal(`Unknown: kb me ${sub}. Try list | add | get | remove.`);
}

export async function run(sub, args, flags) {
  // `me` is a SUBGROUP, checked before anything treats a positional as an agent
  // id — otherwise `whissle kb me list` would ask the API for an agent called
  // "me" and 404 with a confusing message.
  if (sub === "me" || flags.me) {
    return runMine(sub === "me" ? args[0] : sub, sub === "me" ? args.slice(1) : args, flags);
  }

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

  fatal(`Unknown: kb ${sub}. Try list | add | update | remove | me <list|add|get|remove>.`);
}
