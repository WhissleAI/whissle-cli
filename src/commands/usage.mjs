// whissle usage   — workspace wallet balance + recent ledger.
import { get, resolveOrgId } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, table, kv, trunc, dim, printJson } from "../ui.mjs";

export async function run(sub, args, flags) {
  const org = await resolveOrgId();
  const wallet = await get(EP.wallet(org));
  if (flags.json) return printJson(wallet);

  const bal = wallet.balance_usd ?? wallet.balance ?? wallet.credits ?? null;
  kv({ balance: bal != null ? `$${bal}` : dim("—"), currency: wallet.currency || "USD" }, ["balance", "currency"]);

  const ledger = wallet.ledger || wallet.entries || wallet.transactions || [];
  if (ledger.length) {
    out("\n  " + dim("recent activity:"));
    table(
      ["WHEN", "TYPE", "AMOUNT", "BALANCE"],
      ledger.slice(0, 20).map((e) => [
        (e.created_at || e.at || "").slice(0, 16).replace("T", " "),
        trunc(e.type || e.kind || e.reason || "—", 18),
        e.amount_usd != null ? `$${e.amount_usd}` : e.amount != null ? `$${e.amount}` : "—",
        e.balance_usd != null ? `$${e.balance_usd}` : e.balance != null ? `$${e.balance}` : "—",
      ]),
    );
  }
}
