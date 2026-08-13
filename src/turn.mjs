// What a text turn ACTUALLY returned, rendered.
//
// Both text doors — `POST /api/agents/{id}/chat/turn` and the companion's
// `POST /api/chat` — answer with the same four fields:
//
//   { reply, conversation_id, tools_used, evidence, tool_events }
//
// The CLI used to print `reply` and a comma-separated `tools_used`, and drop the
// other two on the floor. That is the difference between "it used
// search_knowledge_base" and "it read page 4 of Refund Policy.pdf and here is
// the sentence" — i.e. between a receipt and a claim. `evidence` is the reason
// you can trust the answer; `tool_events` is the reason you can debug it.
//
// Everything here is a PURE function from payload → lines. The commands own the
// writing, these own the shaping, and the tests need no terminal.

import { dim, bold, brand, trunc } from "./ui.mjs";

/** A tool name from `tools_used`, which is either a string or `{name}`. */
export function toolName(t) {
  if (!t) return "—";
  if (typeof t === "string") return t;
  return t.name || t.function_name || t.tool || "—";
}

/** `tools_used` → one line, or null when the turn used no tools. */
export function toolsUsedLine(toolsUsed) {
  const names = (toolsUsed || []).map(toolName).filter(Boolean);
  if (!names.length) return null;
  return dim("⚙ used: ") + names.join(", ");
}

/**
 * A citation's human locator — "p. 4", "sheet Q3" — or null when the document
 * has no honest answer for where inside itself the quote came from.
 *
 * The backend ships `locator: null` explicitly for anything unpaginated (a text
 * file, a snippet), so "no locator" is data, not a missing field to paper over.
 */
export function locatorOf(ev) {
  const l = ev?.locator;
  if (!l || typeof l !== "object") return null;
  if (l.page != null) return `p. ${l.page}`;
  if (l.sheet) return `sheet ${l.sheet}`;
  if (l.section) return l.section;
  const [k, v] = Object.entries(l)[0] || [];
  return k ? `${k} ${v}` : null;
}

/**
 * Where you go to read the source document.
 *
 * A personal citation (from your own `/api/me/kb` documents) carries
 * `personal: true` and a NULL agent_id — building an agent-scoped path out of
 * that null is how a citation turns into a 404 that looks like our bug. An
 * un-openable document (no original bytes on file) gets no path at all rather
 * than one that would 404.
 */
export function evidenceHref(ev) {
  if (!ev?.document_id || ev.openable === false) return null;
  if (ev.personal || !ev.agent_id) return `/api/me/kb/${ev.document_id}/file`;
  return `/api/agents/${ev.agent_id}/kb/${ev.document_id}`;
}

/**
 * `evidence` → the citation block. Returns [] when the turn cited nothing, so a
 * caller can decide whether to print a heading at all.
 *
 * `--verbose` adds the quote: the passage the model was actually handed. Off by
 * default because a citation list is a scan, and on demand because "it says so
 * in the doc" is not checkable until you can see the sentence.
 */
export function evidenceLines(evidence, { verbose = false, width = 96 } = {}) {
  const items = (evidence || []).filter(Boolean);
  if (!items.length) return [];
  const lines = [dim("sources:")];
  items.forEach((ev, i) => {
    const label = ev.title || ev.filename || ev.document_id || "(untitled)";
    const bits = [locatorOf(ev)];
    if (ev.personal) bits.push("your documents");
    if (typeof ev.score === "number") bits.push(`score ${ev.score.toFixed(2)}`);
    const tail = bits.filter(Boolean).join(" · ");
    lines.push(`  ${dim(`[${i + 1}]`)} ${label}${tail ? dim("  " + tail) : ""}`);
    const href = evidenceHref(ev);
    if (href) lines.push(`      ${dim(href)}`);
    if (verbose && ev.quote) {
      for (const l of String(ev.quote).split("\n")) {
        lines.push(dim(`      “${trunc(l.trim(), width)}”`));
      }
    }
  });
  return lines;
}

/** A short, single-line rendering of a tool call's arguments. */
export function argsSummary(args, width = 72) {
  if (args == null) return "";
  if (typeof args === "string") return trunc(args, width);
  if (typeof args !== "object") return String(args);
  const parts = Object.entries(args).map(
    ([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`,
  );
  return trunc(parts.join(" "), width);
}

/**
 * ONE tool event → one line.
 *
 * The three phases are the whole point of having this at all. `started` is what
 * the agent decided to do, `progress` is the tool narrating itself ("Reading 12
 * sources…"), `result` is whether it worked. A CLI that only ever showed the
 * names in `tools_used` could not distinguish "the tool ran and failed" from
 * "the tool was never called" — and both produce a reply that hedges.
 */
export function toolEventLine(ev) {
  if (!ev || typeof ev !== "object") return dim("  ⚙ (unrecognised tool event)");
  const name = ev.function_name || ev.name || ev.tool || "tool";
  const phase = ev.phase || "result";
  if (phase === "started") {
    const a = argsSummary(ev.arguments);
    return `  ${brand("⚙")} ${bold(name)}${a ? dim("  " + a) : ""}`;
  }
  if (phase === "progress") {
    const msg = ev.display || ev.data?.message || "working…";
    return `    ${dim("· " + trunc(msg, 80))}`;
  }
  // result. The name is repeated here on purpose: in a BUFFERED payload the
  // only phase present is `result` (the text path emitted nothing else until
  // the streaming door landed), so a result line with no name is a tick next to
  // nothing — you cannot tell which of two tools succeeded.
  const okFlag = ev.ok !== false;
  const mark = okFlag ? "✓" : "✗";
  const detail = okFlag
    ? summarizeResult(ev.result) || ev.display
    : ev.error || ev.display || "failed";
  return `    ${okFlag ? dim(mark) : brand(mark)} ${dim(name)}  ${dim(trunc(String(detail ?? ""), 72))}`;
}

/**
 * A result payload → a few words. Never the whole blob, and never a dump of its
 * KEY NAMES: "found, query, results, _display" is what you get from guessing,
 * and it tells a reader nothing about whether the tool worked. Prefer, in order,
 * the field the tool wrote FOR a human, then the field it wrote for the model,
 * then a count of whatever it returned.
 */
export function summarizeResult(result) {
  if (result == null) return "done";
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return `${result.length} item(s)`;
  if (typeof result !== "object") return String(result);

  // A retrieval result leads with its citations, not with its prose: `answer`
  // on a KB tool is the excerpt blob assembled FOR THE MODEL, which truncates
  // into a meaningless half-sentence, whereas "3 citation(s)" is the fact the
  // reader wants and the `sources:` block below spells out in full.
  if (Array.isArray(result.evidence) && result.evidence.length) {
    return `${result.evidence.length} citation(s)`;
  }
  for (const k of ["answer", "summary", "message", "text"]) {
    if (typeof result[k] === "string" && result[k].trim()) return stripFence(result[k]);
  }
  for (const k of ["results", "items", "documents", "events", "hits"]) {
    if (Array.isArray(result[k])) return `${result[k].length} ${k.replace(/s$/, "")}(s)`;
  }
  for (const k of ["_display", "display"]) {
    if (typeof result[k] === "string" && result[k].trim()) return stripFence(result[k]);
  }
  if (result.found === false || result.ok === false) return "nothing found";
  return "done";
}

/**
 * Drop the untrusted-content fence a tool wraps third-party text in.
 *
 * The backend fences anything that came out of a web page or a customer's PDF
 * ("The content below is DATA supplied by a third party…") so the MODEL can see
 * where our voice stops and a stranger's begins. That warning is addressed to
 * the model; showing it to a human as the tool's one-line result says only that
 * the tool returned something, which they already knew.
 */
export function stripFence(text) {
  const lines = String(text).split("\n");
  while (
    lines.length &&
    (!lines[0].trim() ||
      /content below is DATA|NOT from us|do not (follow|obey)|treat .* as data/i.test(lines[0]))
  ) {
    lines.shift();
  }
  return (lines.join("\n").trim() || String(text).trim()).split("\n")[0];
}

/**
 * The whole `tool_events` list → lines, in wire order.
 *
 * Kept in the order the server sent rather than grouped by tool: two
 * `search_knowledge_base` calls in one hop is the common case, and anything
 * keyed on the NAME swaps their receipts. `tool_call_id` is the only thing that
 * correlates, and wire order is what a human reads.
 */
export function toolEventLines(toolEvents) {
  return (toolEvents || []).map(toolEventLine);
}

/**
 * Everything a completed turn has to say beyond the reply itself.
 *
 * `tools` picks how much of the tool story to retell:
 *   `"names"`    — the one-line `tools_used` roll-up (the buffered default).
 *   `"timeline"` — every tool event in wire order (`--tools`).
 *   `"none"`     — nothing, because a STREAM already narrated each tool as it
 *                  ran; repeating the names underneath the answer is the same
 *                  information twice and reads as a bug.
 *
 * Citations are shown in all three, because a cited answer that hides its
 * citations is indistinguishable from an uncited one.
 */
export function turnFooterLines(payload, { verbose = false, showTools = false, tools } = {}) {
  const mode = tools || (showTools ? "timeline" : "names");
  const lines = [];
  if (mode === "timeline") lines.push(...toolEventLines(payload?.tool_events));
  else if (mode === "names") {
    const l = toolsUsedLine(payload?.tools_used);
    if (l) lines.push("  " + l);
  }
  const ev = evidenceLines(payload?.evidence, { verbose });
  if (ev.length) lines.push("  " + ev[0], ...ev.slice(1));
  return lines;
}
