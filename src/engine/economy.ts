// =============================================================================
// economy.ts - Currency tracking and shop transaction system.
// =============================================================================

import { CurrencyEntry, TransactionLog } from "../state/GameState";
import { TransactionLogSchema } from "../state/schema";
import { StateModule } from "../state/state";
import { UIManager } from "../ui/UIManager";
import { safeParseJsonBlock } from "./tag-utils";

function parseTransactionBlock(block: string): TransactionLog | null {
  const parsed = safeParseJsonBlock(TransactionLogSchema, block);
  if (!parsed.ok || !parsed.data) return null;
  return parsed.data;
}

function applyTransaction(tx: TransactionLog): void {
  const currencies = StateModule.state.currencies || [];
  const log = StateModule.state.transactionLog || [];
  const entryIdx = currencies.findIndex(function(c: CurrencyEntry) { return c.name === tx.currency; });

  if (tx.type === "buy" || tx.type === "fine") {
    if (entryIdx >= 0) currencies[entryIdx].amount -= tx.amount;
  } else if (tx.type === "sell" || tx.type === "reward") {
    if (entryIdx >= 0) currencies[entryIdx].amount += tx.amount;
  }

  if (entryIdx < 0) {
    var newAmount = tx.type === "buy" || tx.type === "fine" ? -tx.amount : tx.amount;
    if (newAmount < 0) newAmount = 0;
    currencies.push({ name: tx.currency, amount: newAmount, props: {} });
  }

  log.push(tx);
  if (log.length > 50) log.shift();

  StateModule.state.currencies = currencies;
  StateModule.state.transactionLog = log;
}

export const EconomyModule = {
  lastIssues: [] as Array<{ kind: string; error: string }>,

  extract(aiText: string): string {
    const issues: Array<{ kind: string; error: string }> = [];
    const txRegex = /\[TRANSACTION\](.*?)\[\/TRANSACTION\]/gs;
    let match: RegExpExecArray | null;
    while ((match = txRegex.exec(aiText)) !== null) {
      const tx = parseTransactionBlock(match[1]);
      if (tx) applyTransaction(tx);
      else issues.push({ kind: "TRANSACTION", error: "Failed to parse transaction block" });
    }
    EconomyModule.lastIssues = issues;
    if (issues.length > 0) UIManager.showParseNotice(issues);
    UIManager.renderEconomyPanel();
    return aiText;
  },

  getAllBalances(): CurrencyEntry[] {
    return StateModule.state.currencies || [];
  },

  getTransactionLog(): TransactionLog[] {
    return StateModule.state.transactionLog || [];
  },

  getTotalWealth(): number {
    const currencies = StateModule.state.currencies || [];
    return currencies.reduce(function(sum: number, c: CurrencyEntry) { return sum + c.amount; }, 0);
  },

  canAfford(currency: string, amount: number): boolean {
    var currencies = StateModule.state.currencies || [];
    var entry = currencies.find(function(c: CurrencyEntry) { return c.name === currency; });
    return (entry ? entry.amount : 0) >= amount;
  },
};
