// whissle numbers list|available|search|buy|provision|connect|assign|release
// Buy a phone number (deducts workspace credits) and connect it to an agent for
// inbound calls — the platform-number flow. Needs numbers:read / numbers:write.
import { createInterface } from "node:readline/promises";
import { get, post, put, resolveOrgId } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, ok, table, trunc, dim, bold, printJson, printMutation, fatal } from "../ui.mjs";

async function confirm(question) {
  // NOT auto-yes. There is no "--yes upstream" to assume: a piped or CI
  // invocation reaching here has already failed the `flags.yes` check at the
  // call site, so answering for the user would buy a number — on a recurring
  // charge — because nobody was at a keyboard to say no.
  if (!process.stdin.isTTY) {
    fatal("Buying a number deducts credits and recurs monthly. There is no TTY to confirm on — re-run with --yes.");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(question + " [y/N] ")).trim().toLowerCase();
  rl.close();
  return a === "y" || a === "yes";
}

/**
 * The first candidate a search answered with — the one `provision` buys.
 * Pure — exported for tests.
 */
export function firstCandidate(res) {
  const nums = Array.isArray(res) ? res : res?.numbers || [];
  const n = nums[0];
  return n ? n.phone_number || n.phoneNumber || null : null;
}

const numRow = (n) => [n.id, n.phone_number, n.agent_id ? trunc(n.agent_id, 14) : dim("—"), n.friendly_name || ""];

export async function run(sub, args, flags) {
  const org = await resolveOrgId();

  if (!sub || sub === "list") {
    const nums = await get(EP.numbers.free(org));
    if (flags.json) return printJson(nums);
    table(["ID", "NUMBER", "AGENT", "LABEL"], (nums || []).map(numRow));
    out(dim(`\n  ${(nums || []).length} number(s) in this workspace`));
    return;
  }

  if (sub === "available") {
    const nums = await get(EP.numbers.available(org));
    if (flags.json) return printJson(nums);
    table(["ID", "NUMBER", "LABEL"], (nums || []).map((n) => [n.id, n.phone_number, n.friendly_name || ""]));
    out(dim(`\n  ${(nums || []).length} available to claim`));
    return;
  }

  if (sub === "search") {
    const body = {
      country: (flags.country || "US").toUpperCase(),
      area_code: flags.area,
      contains: flags.contains,
      limit: flags.limit ? Number(flags.limit) : 20,
    };
    const res = await post(EP.numbers.search(org), body);
    if (flags.json) return printJson(res);
    const nums = res.numbers || res || [];
    table(["NUMBER", "REGION", "CAPABILITIES"], nums.map((n) => [
      n.phone_number || n.phoneNumber, n.locality || n.region || "",
      [n.voice && "voice", n.sms && "sms", n.mms && "mms"].filter(Boolean).join("/"),
    ]));
    if (res.monthly_price) out(dim(`\n  ~$${res.monthly_price}/mo · buy with: whissle numbers buy <number>`));
    return;
  }

  if (sub === "buy") {
    const phone = args[0] || fatal("Usage: whissle numbers buy <+1…>   (find candidates with `whissle numbers search`)");
    if (!flags.yes && !(await confirm(`Buy ${bold(phone)}? This deducts credits from your workspace wallet.`))) {
      return out(dim("Cancelled."));
    }
    const res = await post(EP.numbers.purchase(org), { phone_number: phone, friendly_name: flags.label });
    if (flags.json) return printJson(res);
    ok(`Purchased ${phone}` + (res.number?.id ? ` (${res.number.id})` : ""));
    out(dim(`  Connect it: whissle numbers connect ${phone} --agent <agent-id>`));
    return;
  }

  if (sub === "provision") {
    // search → buy the first match → (optionally) route it to an agent, in one
    // go. The purchase is the part that costs money, so it keeps the same
    // confirmation `buy` has.
    const body = {
      country: (flags.country || "US").toUpperCase(),
      area_code: flags["area-code"] || flags.area,
      contains: flags.contains,
      limit: 1,
    };
    const found = await post(EP.numbers.search(org), body);
    const phone = firstCandidate(found);
    if (!phone) fatal(`No numbers available for ${body.country}${body.area_code ? ` area ${body.area_code}` : ""}${body.contains ? ` containing ${body.contains}` : ""}.`);
    if (!flags.yes && !(await confirm(`Buy ${bold(phone)}? This deducts credits from your workspace wallet.`))) {
      return out(dim("Cancelled."));
    }
    const bought = await post(EP.numbers.purchase(org), { phone_number: phone, friendly_name: flags.label });
    let assigned = null;
    if (typeof flags.agent === "string" && flags.agent) {
      const numberId = bought?.number?.id || bought?.id;
      if (numberId) {
        assigned = await put(EP.numbers.inboundNumber(org, flags.agent), { number_id: numberId, source: bought?.number?.source || "platform" });
      }
    }
    if (flags.json) return printJson({ phone_number: phone, purchase: bought, ...(flags.agent ? { agent_id: flags.agent, assigned: assigned ?? false } : {}) });
    ok(`Provisioned ${phone}` + (bought?.number?.id ? ` (${bought.number.id})` : ""));
    if (flags.agent) out(assigned ? `  routed inbound → agent ${flags.agent}` : dim(`  could not route it (no number id returned) — whissle numbers assign <number-id> --agent ${flags.agent}`));
    return;
  }

  if (sub === "claim") {
    const id = args[0] || fatal("Usage: whissle numbers claim <number-id>   (ids from `whissle numbers available`)");
    const res = await post(EP.numbers.claim(org, id), {});
    // JSON FIRST: this printed the green line to stdout unconditionally and then
    // the payload, so `… --json | jq` choked on line 1 of its input.
    if (flags.json) return printMutation(res, { claimed: id });
    ok(`Claimed number ${id}`);
    return;
  }

  if (sub === "connect" || sub === "assign") {
    // Bind a number to an agent for inbound. Accept a phone number OR an id.
    const ref = args[0] || fatal(`Usage: whissle numbers ${sub} <+1… | number-id> --agent <agent-id>`);
    if (!flags.agent) fatal("--agent <agent-id> is required.");
    const nums = await get(EP.numbers.free(org));
    const match = (nums || []).find((n) => n.id === ref || n.phone_number === ref);
    if (!match) fatal(`${ref} is not a number in this workspace (see \`whissle numbers list\`).`);
    const r = await put(EP.numbers.inboundNumber(org, flags.agent), { number_id: match.id, source: match.source || "platform" });
    if (flags.json) return printMutation(r, { number_id: match.id, phone_number: match.phone_number, agent_id: flags.agent });
    ok(`Connected ${match.phone_number} → agent ${flags.agent} for inbound calls.`);
    return;
  }

  if (sub === "release") {
    const id = args[0] || fatal("Usage: whissle numbers release <number-id>");
    const r = await post(EP.numbers.release(org, id), {});
    if (flags.json) return printMutation(r, { released: id });
    ok(`Released number ${id}`);
    return;
  }

  fatal(`Unknown: numbers ${sub}. Try list | available | search | buy | provision | claim | connect | assign | release.`);
}
