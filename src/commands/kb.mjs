// whissle kb list|add|update|remove — attach knowledge to an AGENT (RAG).
// whissle kb sync|docs|search|eval    — VERSIONED documents keyed by YOUR id,
//                                       retrieval as the agent sees it, and a
//                                       recall harness for it.
// whissle kb import-conversations      — drop a chat export on the ingest door.
// whissle kb me  list|add|get|remove   — YOUR OWN documents, no agent involved.
// Needs kb:read / kb:write for both.
//
// `sync <dir>` is the operation you want when knowledge is generated from a
// source of truth you own: every file becomes a document whose `external_id`
// is its path, PUT with a sha256 `content_hash`. The server answers a same
// hash with `{unchanged:true}` and no re-embed, so a no-op sync costs one
// request per file and zero embedding; changed content is a new `doc_version`
// with the old chunks retired (kept 30 days so old citations still resolve).
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
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import { del, get, patch, post, put, raw, upload } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, ok, warn, table, trunc, dim, kv, printJson, printMutation, fatal } from "../ui.mjs";

// ── sync helpers (pure; exported for tests) ──────────────────────────────────

/** The sha256 hex the server keys "unchanged" on. */
export function hashContent(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export const SYNC_EXTS = ["md", "txt", "html", "json", "csv"];

const MIME = { md: "text/markdown", txt: "text/plain", html: "text/html", json: "application/json", csv: "text/csv" };

/** A file's title: its first `# ` heading, else its name without the extension. */
export function titleOf(relPath, content) {
  const m = /^#\s+(.+?)\s*$/m.exec(content);
  if (m) return m[1].trim();
  const base = relPath.split("/").pop();
  return base.replace(/\.[^.]+$/, "") || base;
}

/** Walk `dir`, returning `{externalId, absPath}` for every file with a wanted extension, sorted. */
export function walkDir(dir, exts = SYNC_EXTS, deps = { readdirSync, statSync }) {
  const want = new Set(exts.map((e) => e.replace(/^\./, "").toLowerCase()));
  const files = [];
  const visit = (d) => {
    for (const name of deps.readdirSync(d)) {
      if (name.startsWith(".")) continue;
      const abs = join(d, name);
      if (deps.statSync(abs).isDirectory()) visit(abs);
      else if (want.has(extname(name).slice(1).toLowerCase())) {
        files.push({ externalId: relative(dir, abs).split(sep).join("/"), absPath: abs });
      }
    }
  };
  visit(dir);
  return files.sort((a, b) => a.externalId.localeCompare(b.externalId));
}

/**
 * The plan: one PUT per local file (with its hash), and — when pruning — one
 * DELETE per server document whose external_id is not on disk. `files` are
 * `{externalId, content}` (content as Buffer or string); `existingDocs` is what
 * `GET kb/docs` returned. Pure.
 */
export function planSync(files, existingDocs, { namespace, prune = false } = {}) {
  const puts = files.map((f) => {
    const bytes = Buffer.isBuffer(f.content) ? f.content : Buffer.from(String(f.content ?? ""), "utf8");
    const content = bytes.toString("utf8");
    const ext = extname(f.externalId).slice(1).toLowerCase();
    return {
      externalId: f.externalId,
      body: {
        title: titleOf(f.externalId, content),
        content,
        ...(MIME[ext] ? { mime: MIME[ext] } : {}),
        ...(namespace ? { namespace } : {}),
        content_hash: hashContent(bytes),
      },
    };
  });
  const local = new Set(puts.map((p) => p.externalId));
  const deletes = prune
    ? (existingDocs || []).filter((d) => d.external_id && !local.has(d.external_id)).map((d) => d.external_id)
    : [];
  return { puts, deletes };
}

/**
 * Run a plan and account for it. `api` is injectable so the wire bodies can be
 * asserted without a network; the counts come from the server's own answers
 * (`unchanged:true` → unchanged, a `doc_version` of 1 or a `created` flag →
 * added, anything else → updated).
 */
export async function applySync(agentId, plan, api = { put, del }) {
  const stats = { added: 0, updated: 0, unchanged: 0, removed: 0 };
  for (const p of plan.puts) {
    const r = await api.put(EP.agents.kb.docByExternalId(agentId, encodeURIComponent(p.externalId)), p.body);
    if (r && r.unchanged) stats.unchanged++;
    else if (r && (r.created === true || r.doc_version === 1)) stats.added++;
    else stats.updated++;
  }
  for (const ext of plan.deletes) {
    await api.del(EP.agents.kb.docByExternalId(agentId, encodeURIComponent(ext)));
    stats.removed++;
  }
  return stats;
}

/** Labels file → the eval body. Accepts `{cases:[…]}` or a bare array. Pure. */
export function evalBody(labels, k) {
  const cases = Array.isArray(labels) ? labels : labels?.cases;
  if (!Array.isArray(cases) || !cases.length) fatal("labels must be a JSON array of {question, expected_doc_id?, expected_chunk_id?} (or {cases:[…]}).");
  for (const [i, c] of cases.entries()) {
    if (!c || !c.question) fatal(`case ${i}: needs a "question".`);
  }
  return { cases, ...(k ? { k: parseInt(k, 10) } : {}) };
}

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
    const r = await del(EP.agents.kb.doc(agentId, docId));
    if (flags.json) return printMutation(r, { deleted: docId });
    ok(`Removed document ${docId}.`);
    return;
  }

  if (sub === "sync") {
    const dir = rest[0] || fatal("Usage: whissle kb sync <agent-id> <dir> [--namespace ns] [--prune] [--dry-run] [--ext md,txt,html,json,csv]");
    if (!agentId) fatal("Usage: whissle kb sync <agent-id> <dir> [--namespace ns] [--prune] [--dry-run]");
    const exts = typeof flags.ext === "string" ? flags.ext.split(",").map((e) => e.trim()).filter(Boolean) : SYNC_EXTS;
    const namespace = typeof flags.namespace === "string" ? flags.namespace : undefined;
    let listed;
    try { listed = walkDir(dir, exts); }
    catch (e) { fatal(`cannot read ${dir}: ${e.message}`); }
    const files = listed.map((f) => ({ externalId: f.externalId, content: readFileSync(f.absPath) }));
    // Pruning needs the server's list; a plain sync does not, so it is not fetched.
    const existing = flags.prune ? await get(EP.agents.kb.docs(agentId), { query: { namespace } }) : [];
    const plan = planSync(files, Array.isArray(existing) ? existing : existing?.docs || [], { namespace, prune: !!flags.prune });
    if (flags["dry-run"]) {
      if (flags.json) return printJson({ dry_run: true, puts: plan.puts.map((p) => ({ external_id: p.externalId, title: p.body.title, content_hash: p.body.content_hash })), deletes: plan.deletes });
      table(["ACTION", "EXTERNAL ID", "TITLE", "HASH"], [
        ...plan.puts.map((p) => ["put", p.externalId, trunc(p.body.title, 30), p.body.content_hash.slice(0, 12)]),
        ...plan.deletes.map((d) => ["delete", d, "", ""]),
      ]);
      return out(dim(`\n  dry run — ${plan.puts.length} put(s), ${plan.deletes.length} delete(s); nothing sent`));
    }
    const stats = await applySync(agentId, plan);
    if (flags.json) return printJson({ agent_id: agentId, namespace: namespace || null, ...stats });
    ok(`Synced ${dir}: ${stats.added} added · ${stats.updated} updated · ${stats.unchanged} unchanged · ${stats.removed} removed`);
    return;
  }

  if (sub === "docs") {
    if (!agentId) fatal("Usage: whissle kb docs <agent-id> [--namespace ns]");
    const res = await get(EP.agents.kb.docs(agentId), { query: { namespace: flags.namespace } });
    if (flags.json) return printJson(res);
    const docs = Array.isArray(res) ? res : res?.docs || [];
    table(
      ["DOC ID", "EXTERNAL ID", "TITLE", "VER", "NS", "CHUNKS", "UPDATED"],
      docs.map((d) => [
        d.doc_id || d.id, trunc(d.external_id || "—", 28), trunc(d.title || "—", 26),
        d.doc_version ?? "—", d.namespace || "—", d.chunks ?? "—", String(d.updated_at || "").slice(0, 16).replace("T", " "),
      ]),
    );
    return out(dim(`\n  ${docs.length} versioned document(s)`));
  }

  if (sub === "search") {
    const q = rest.join(" ") || (typeof flags.q === "string" ? flags.q : "");
    if (!agentId || !q) fatal('Usage: whissle kb search <agent-id> "<question>" [--k 5] [--namespace ns]');
    const res = await get(EP.agents.kb.search(agentId), { query: { q, k: flags.k, namespace: flags.namespace } });
    if (flags.json) return printJson(res);
    const hits = Array.isArray(res) ? res : res?.results || [];
    table(
      ["SCORE", "CHUNK", "DOC", "VER", "TEXT"],
      hits.map((h) => [
        typeof h.score === "number" ? h.score.toFixed(3) : "—", trunc(h.chunk_id || "—", 16),
        trunc(h.doc_id || "—", 16), h.doc_version ?? "—", trunc(String(h.text || "").replace(/\s+/g, " "), 60),
      ]),
    );
    return out(dim(`\n  ${hits.length} chunk(s)`));
  }

  if (sub === "eval") {
    const file = rest[0] || fatal("Usage: whissle kb eval <agent-id> <labels.json> [--k 5]");
    if (!agentId) fatal("Usage: whissle kb eval <agent-id> <labels.json> [--k 5]");
    let labels;
    try { labels = JSON.parse(readFileSync(file, "utf8")); }
    catch (e) { fatal(`cannot read ${file} as JSON (${e.message})`); }
    const res = await post(EP.agents.kb.eval(agentId), evalBody(labels, flags.k));
    if (flags.json) return printJson(res);
    const pct = (v) => (typeof v === "number" ? `${(v * 100).toFixed(1)}%` : "—");
    kv({ "recall@1": pct(res.recall_at_1), "recall@3": pct(res.recall_at_3), "recall@5": pct(res.recall_at_5), mrr: typeof res.mrr === "number" ? res.mrr.toFixed(3) : "—" });
    out("");
    table(
      ["HIT RANK", "QUESTION", "TOP"],
      (res.cases || []).map((c) => [
        c.hit_rank == null ? "miss" : String(c.hit_rank), trunc(c.question || "", 50),
        trunc((c.top || []).map((t) => (typeof t === "string" ? t : t.doc_id || t.chunk_id || "")).join(", "), 40),
      ]),
    );
    return out(dim(`\n  ${(res.cases || []).length} case(s)`));
  }

  if (sub === "import-conversations") {
    const file = rest[0] || fatal("Usage: whissle kb import-conversations <agent-id> <export-file>");
    if (!agentId) fatal("Usage: whissle kb import-conversations <agent-id> <export-file>");
    const r = await upload(EP.agents.kb.ingest(agentId), { filePath: file });
    if (flags.json) return printJson(r);
    if (r?.kind === "job" || r?.job_id) {
      ok(`Import queued as job ${r.job_id || r.id}.`);
      return out(dim(`  Poll it: whissle kb import-status ${agentId} ${r.job_id || r.id}`));
    }
    ok(`Imported ${basename(file)}: ${r?.imported ?? r?.documents?.length ?? "?"} document(s)` + (r?.skipped?.length ? `, ${r.skipped.length} skipped` : ""));
    for (const s of r?.skipped || []) warn(`${s.name || s.file || "?"}: ${s.reason || "skipped"}`);
    return;
  }

  if (sub === "import-status") {
    if (!agentId) fatal("Usage: whissle kb import-status <agent-id> [<job-id>]");
    const jobId = rest[0];
    const r = await get(jobId ? EP.agents.kb.ingestJob(agentId, jobId) : EP.agents.kb.ingest(agentId));
    if (flags.json) return printJson(r);
    kv({ job: r?.job_id || r?.id || jobId || "—", status: r?.status, imported: r?.imported ?? r?.manifest?.imported, skipped: Array.isArray(r?.skipped) ? r.skipped.length : r?.manifest?.skipped?.length });
    return;
  }

  fatal(`Unknown: kb ${sub}. Try list | add | update | remove | sync | docs | search | eval | import-conversations | me <list|add|get|remove>.`);
}
