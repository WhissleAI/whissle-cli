// whissle numbers list|available|search|buy|connect|release
// Buy a phone number (deducts workspace credits) and connect it to an agent for
// inbound calls — the platform-number flow. Needs numbers:read / numbers:write.
import { createInterface } from "node:readline/promises";
import { get, post, put, resolveOrgId } from "../api.mjs";
import { out, ok, table, trunc, dim, bold, printJson, fatal } from "../ui.mjs";

async function confirm(question) {
  if (!process.stdin.isTTY) return true; // non-interactive (CI) → assume --yes upstream
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(question + " [y/N] ")).trim().toLowerCase();
  rl.close();
  return a === "y" || a === "yes";
}

const numRow = (n) => [n.id, n.phone_number, n.agent_id ? trunc(n.agent_id, 14) : dim("—"), n.friendly_name || ""];

export async function run(sub, args, flags) {
  const org = await resolveOrgId();
  const base = `/api/orgs/${org}/twilio`;

  if (!sub || sub === "list") {
    const nums = await get(`${base}/free`);
    if (flags.json) return printJson(nums);
    table(["ID", "NUMBER", "AGENT", "LABEL"], (nums || []).map(numRow));
    out(dim(`\n  ${(nums || []).length} number(s) in this workspace`));
    return;
  }

  if (sub === "available") {
    const nums = await get(`${base}/free/available`);
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
    const res = await post(`${base}/free/search`, body);
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
    const res = await post(`${base}/free/purchase`, { phone_number: phone, friendly_name: flags.label });
    if (flags.json) return printJson(res);
    ok(`Purchased ${phone}` + (res.number?.id ? ` (${res.number.id})` : ""));
    out(dim(`  Connect it: whissle numbers connect ${phone} --agent <agent-id>`));
    return;
  }

  if (sub === "claim") {
    const id = args[0] || fatal("Usage: whissle numbers claim <number-id>   (ids from `whissle numbers available`)");
    const res = await post(`${base}/free/${id}/claim`, {});
    ok(`Claimed number ${id}`);
    if (flags.json) printJson(res);
    return;
  }

  if (sub === "connect") {
    // Bind a number to an agent for inbound. Accept a phone number OR an id.
    const ref = args[0] || fatal("Usage: whissle numbers connect <+1… | number-id> --agent <agent-id>");
    if (!flags.agent) fatal("--agent <agent-id> is required.");
    const nums = await get(`${base}/free`);
    const match = (nums || []).find((n) => n.id === ref || n.phone_number === ref);
    if (!match) fatal(`${ref} is not a number in this workspace (see \`whissle numbers list\`).`);
    await put(`${base}/agents/${flags.agent}/inbound-number`, { number_id: match.id, source: match.source || "platform" });
    ok(`Connected ${match.phone_number} → agent ${flags.agent} for inbound calls.`);
    return;
  }

  if (sub === "release") {
    const id = args[0] || fatal("Usage: whissle numbers release <number-id>");
    await post(`${base}/free/${id}/release`, {});
    ok(`Released number ${id}`);
    return;
  }

  fatal(`Unknown: numbers ${sub}. Try list | available | search | buy | claim | connect | release.`);
}
