// whissle usage   — workspace wallet balance + recent ledger.
import { get, resolveOrgId } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, table, kv, trunc, dim, printJson } from "../ui.mjs";

export async function run(sub, args, flags) {
  const org = await resolveOrgId();
  const wallet = await get(EP.wallet.base(org));
  // The ledger is its own endpoint (GET /wallet/ledger) — the wallet body carries
  // only the balance. Fetch it separately; a failure never blocks the balance.
  let ledger = [];
  try {
    ledger = (await get(EP.wallet.ledger(org))) || [];
  } catch { /* ledger unavailable — still show the balance */ }

  if (flags.json) return printJson({ ...wallet, ledger });

  const bal = wallet.balance_usd ?? wallet.balance ?? wallet.credits ?? null;
  kv({ balance: bal != null ? `$${bal}` : dim("—"), currency: wallet.currency || "USD" }, ["balance", "currency"]);

  if (ledger.length) {
    out("\n  " + dim("recent activity:"));
    table(
      ["WHEN", "TYPE", "AMOUNT", "BALANCE"],
      ledger.slice(0, 20).map((e) => [
        (e.created_at || e.at || "").slice(0, 16).replace("T", " "),
        trunc(e.kind || e.type || e.reason || e.description || "—", 18),
        e.amount_usd != null ? `$${e.amount_usd}` : e.amount != null ? `$${e.amount}` : "—",
        e.balance_after != null ? `$${e.balance_after}` : e.balance_usd != null ? `$${e.balance_usd}` : e.balance != null ? `$${e.balance}` : "—",
      ]),
    );
  }
}
