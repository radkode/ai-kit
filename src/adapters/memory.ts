import { randomUUID } from 'node:crypto';
import type {
  AiBudgetStore,
  AiCache,
  BudgetAmount,
  BudgetReservation,
} from '../core/contracts.js';

/**
 * In-memory adapters for development and tests ONLY. They are process-local:
 * on serverless they reset per cold start and are invisible across instances,
 * which is exactly the failure mode ai-kit exists to retire. Production uses
 * the Upstash adapters (or any other implementation of the contracts).
 */

interface CacheEntry {
  value: string;
  expiresAt: number;
}

export function memoryCache(options: { maxEntries?: number } = {}): AiCache {
  const maxEntries = options.maxEntries ?? 1000;
  const store = new Map<string, CacheEntry>();
  return {
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttlSeconds) {
      if (!store.has(key) && store.size >= maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest !== undefined) store.delete(oldest);
      }
      store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
  };
}

interface Ledger {
  reservedTokens: number;
  reservedUsd: number;
  spentTokens: number;
  spentUsd: number;
}

export function memoryBudget(): AiBudgetStore {
  const ledgers = new Map<string, Ledger>();
  const reservations = new Map<string, BudgetReservation>();

  function ledgerFor(key: string): Ledger {
    let ledger = ledgers.get(key);
    if (!ledger) {
      ledger = { reservedTokens: 0, reservedUsd: 0, spentTokens: 0, spentUsd: 0 };
      ledgers.set(key, ledger);
    }
    return ledger;
  }

  return {
    async reserve(key, amount, limit) {
      const ledger = ledgerFor(key);
      const wouldTokens = ledger.reservedTokens + ledger.spentTokens + amount.tokens;
      const wouldUsd = ledger.reservedUsd + ledger.spentUsd + amount.usd;
      if (wouldTokens > limit.tokens || wouldUsd > limit.usd) return null;
      ledger.reservedTokens += amount.tokens;
      ledger.reservedUsd += amount.usd;
      const reservation: BudgetReservation = { id: randomUUID(), key, reserved: amount };
      reservations.set(reservation.id, reservation);
      return reservation;
    },
    async settle(reservation, actual: BudgetAmount) {
      if (!reservations.delete(reservation.id)) return;
      const ledger = ledgerFor(reservation.key);
      ledger.reservedTokens -= reservation.reserved.tokens;
      ledger.reservedUsd -= reservation.reserved.usd;
      ledger.spentTokens += actual.tokens;
      ledger.spentUsd += actual.usd;
    },
    async release(reservation) {
      if (!reservations.delete(reservation.id)) return;
      const ledger = ledgerFor(reservation.key);
      ledger.reservedTokens -= reservation.reserved.tokens;
      ledger.reservedUsd -= reservation.reserved.usd;
    },
  };
}
