// whissle usage   — workspace wallet balance + recent ledger.
import { get, resolveOrgId } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, table, kv, trunc, dim, warn, printJson } from "../ui.mjs";

export async function run(sub, args, flags) {
  const org = await resolveOrgId();
  const wallet = await get(EP.wallet.base(org));
  // The ledger is its own endpoint (GET /wallet/ledger) — the wallet body carries
  // only the balance. Fetch it separately; a failure never blocks the balance.
  let ledger = [];
  let ledgerError = null;
  try {
    ledger = (await get(EP.wallet.ledger(org))) || [];
  } catch (e) {
    // Still show the balance — but SAY the ledger is missing. Swallowing this
    // made "your key lacks billing:read" and "you have never spent anything"
    // the same output: `ledger: []`, exit 0.
    ledgerError = { error: e?.message || String(e), status: e?.status ?? null };
  }

  if (flags.json) return printJson({ ...wallet, ledger, ...(ledgerError ? { ledger_error: ledgerError } : {}) });
  if (ledgerError) warn(`Could not read the ledger (${ledgerError.error}) — the balance below is still current.`);

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
