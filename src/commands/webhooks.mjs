// whissle webhooks — outbound event delivery to YOUR endpoint.
//
// `create` registers `{url, events[], secret?}` and answers `{id, secret}`; the
// secret is shown ONCE, here, and never again. Every delivery is signed
//
//   X-Whissle-Signature: t=<unix>,v1=hex(hmac-sha256(secret, t + "." + body))
//
// so a receiver checks the signature over `t + "." + rawBody` and rejects a
// stale `t`. Failed deliveries retry at 1m / 5m / 30m, then dead-letter — and
// stay visible under `deliveries`, where `replay` re-sends one by hand.
// Key resolves the org (NOT org-prefixed).
import { get, post, del } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, ok, table, kv, trunc, dim, bold, printJson, printMutation, fatal } from "../ui.mjs";

const when = (s) => (s || "").slice(0, 16).replace("T", " ");

/** The six event kinds, with what each carries. Static — `whissle webhooks events`. */
export const EVENT_KINDS = [
  ["session.ended", "a voice, text or listen session closed — end_reason, duration_sec, cost_usd"],
  ["tool.held", "a tool call is waiting for a human — evidence, rationale, expires_at"],
  ["approval.decided", "a held action was approved, rejected, undone or expired"],
  ["kb.ingested", "a knowledge import finished — the manifest"],
  ["balance.threshold", "the wallet crossed an alert rule's balance_below_usd line"],
  ["latency.threshold", "a door's p95 crossed an alert rule's p95_ms_over line"],
];

export const SIGNATURE_SCHEME = 'X-Whissle-Signature: t=<unix>,v1=hex(hmac-sha256(secret, t + "." + body))';

/**
 * The create body from flags. `--events` is comma-separated (or repeated);
 * unknown kinds are refused HERE with the list, rather than as a 422 that says
 * only "invalid events".
 *
 * `known` is the vocabulary to check against — the caller passes the LIVE one
 * from GET /api/webhooks/events when it can reach it, and the built-in list is
 * only the offline fallback. Validating against a hard-coded array alone is how
 * a CLI ends up unable to subscribe to an event the platform already emits.
 *
 * Pure — exported for tests.
 */
export function webhookBody(flags, known = EVENT_KINDS.map(([k]) => k)) {
  const url = typeof flags.url === "string" ? flags.url : "";
  if (!/^https?:\/\//.test(url)) fatal("--url must be an http(s) URL.");
  const events = [].concat(flags.events || flags.event || [])
    .flatMap((v) => String(v).split(","))
    .map((v) => v.trim())
    .filter(Boolean);
  const vocabulary = new Set(known);
  if (!events.length) fatal(`--events is required, e.g. --events session.ended,tool.held  (kinds: ${[...vocabulary].join(", ")})`);
  const bad = events.filter((e) => !vocabulary.has(e));
  if (bad.length) fatal(`Unknown event kind(s): ${bad.join(", ")}. Valid: ${[...vocabulary].join(", ")}`);
  return {
    url,
    events,
    ...(typeof flags.secret === "string" && flags.secret ? { secret: flags.secret } : {}),
  };
}

/**
 * The event kinds the gateway will accept right now, or the built-in list when
 * it cannot be reached (no key, no network, an older gateway). Never throws —
 * a vocabulary lookup must not be the thing that fails a create.
 */
async function liveVocabulary() {
  try {
    const r = await get(EP.webhooks.events);
    if (Array.isArray(r?.events) && r.events.length) return r.events;
  } catch {
    /* fall through to what we know */
  }
  return EVENT_KINDS.map(([k]) => k);
}

const hookRow = (w) => [
  w.id,
  trunc(w.url || "—", 40),
  trunc((w.events || []).join(","), 40),
  w.enabled === false ? "off" : "on",
  w.last_delivery_at ? when(w.last_delivery_at) : "—",
];

export async function run(sub, args, flags) {
  if (!sub || sub === "list") {
    const res = await get(EP.webhooks.list);
    if (flags.json) return printJson(res);
    const hooks = Array.isArray(res) ? res : res?.webhooks || res?.items || [];
    table(["ID", "URL", "EVENTS", "ENABLED", "LAST DELIVERY"], hooks.map(hookRow));
    out(dim(`\n  ${hooks.length} webhook(s)  ·  whissle webhooks create --url https://… --events session.ended,tool.held`));
    return;
  }

  if (sub === "events") {
    // The gateway serves the vocabulary (GET /api/webhooks/events, from the
    // same tuple the emitters use), so ASK it — the built-in list below is only
    // a fallback for an offline run, and the moment the platform adds an event
    // a hard-coded list is a CLI that cannot subscribe to it. `--offline` is
    // the escape hatch for a script that must not touch the network.
    let kinds = EVENT_KINDS, live = null;
    if (!flags.offline) {
      try {
        live = await get(EP.webhooks.events);
      } catch {
        /* no key, no route, no network — fall back to what we know */
      }
    }
    if (Array.isArray(live?.events) && live.events.length) {
      const described = new Map(EVENT_KINDS);
      kinds = live.events.map((k) => [k, described.get(k) || dim("(new — see the docs)")]);
      if (live.test_event) kinds.push([live.test_event, "what `webhooks test <id>` sends; always deliverable"]);
    }
    if (flags.json) return printJson(kinds.map(([kind, description]) => ({ kind, description })));
    table(["EVENT", "WHEN"], kinds);
    out(dim(`\n  ${live ? "live from the gateway" : "built-in list (offline)"}`));
    out(dim(`  body: {id, type, created_at, organization_id, data}\n  ${SIGNATURE_SCHEME}`));
    return;
  }

  if (sub === "create") {
    const body = webhookBody(flags, await liveVocabulary());
    const r = await post(EP.webhooks.create, body);
    if (flags.json) return printJson(r);
    ok(`Created webhook ${r.id} → ${body.url}`);
    out(bold("  secret: ") + (r.secret || "(none returned)"));
    out(dim("  Shown once — store it now. Verify deliveries with:"));
    out(dim("  " + SIGNATURE_SCHEME));
    out(dim(`  Send a test event: whissle webhooks test ${r.id}`));
    return;
  }

  if (sub === "delete" || sub === "remove") {
    const id = args[0] || fatal("Usage: whissle webhooks delete <webhook-id> [--force]");
    if (!flags.force) fatal("This stops every delivery to that endpoint. Re-run with --force.");
    const r = await del(EP.webhooks.del(id));
    if (flags.json) return printMutation(r, { deleted: id });
    ok(`Deleted webhook ${id}`);
    return;
  }

  if (sub === "test") {
    const id = args[0] || fatal("Usage: whissle webhooks test <webhook-id>");
    const r = await post(EP.webhooks.test(id), {});
    if (flags.json) return printMutation(r, { tested: id });
    ok(`Sent a test event to webhook ${id}` + (r?.status ? dim(`  (${r.status})`) : ""));
    if (r?.delivery_id) out(dim(`  delivery ${r.delivery_id} — whissle webhooks deliveries ${id}`));
    return;
  }

  if (sub === "deliveries") {
    const id = args[0] || fatal("Usage: whissle webhooks deliveries <webhook-id> [--limit N]");
    const res = await get(EP.webhooks.deliveries(id), { query: { limit: flags.limit } });
    if (flags.json) return printJson(res);
    const rows = Array.isArray(res) ? res : res?.deliveries || res?.items || [];
    table(
      ["ID", "EVENT", "STATUS", "HTTP", "ATTEMPTS", "LAST TRY"],
      rows.map((d) => [
        d.id, trunc(d.event || d.type || "—", 20),
        d.dead_lettered ? "dead-lettered" : d.status || "—",
        d.response_status ?? d.http_status ?? "—",
        d.attempts ?? d.attempt_count ?? "—",
        when(d.last_attempt_at || d.updated_at || d.created_at),
      ]),
    );
    out(dim(`\n  ${rows.length} delivery(ies)  ·  re-send one: whissle webhooks replay ${id} <delivery-id>`));
    return;
  }

  if (sub === "replay") {
    const [id, deliveryId] = args;
    if (!id || !deliveryId) fatal("Usage: whissle webhooks replay <webhook-id> <delivery-id>");
    const r = await post(EP.webhooks.replay(id, deliveryId), {});
    if (flags.json) return printMutation(r, { replayed: deliveryId });
    ok(`Replayed delivery ${deliveryId}` + (r?.status ? dim(`  (${r.status})`) : ""));
    return;
  }

  fatal(`Unknown: webhooks ${sub}. Try list | create | delete | test | deliveries | replay | events.`);
}
