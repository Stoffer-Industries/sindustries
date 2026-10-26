import { prisma } from '../lib/prisma';
import { categorizeTransaction } from './categorizer';
import type { AkahuAccount, AkahuTransaction } from './akahuClient';

/**
 * Shared Akahu ingest path.
 *
 * The `/akahu/sync` route and the bounded backfill both write the same
 * financial records from the same provider payload, so the write semantics
 * live here once rather than being duplicated per caller. A backfill that
 * wrote records by a different path would produce rows the sync could not
 * recognise as its own.
 *
 * Both callers are additive and idempotent: rows are keyed by
 * `providerTransactionId` and upserted, never deleted.
 */

export function akahuAmountToCents(amount: number | undefined): number | null {
  return typeof amount === 'number' && Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

/**
 * Upserts the provider accounts into `LinkedCard` so transactions can be
 * attached to a card.
 *
 * `captureBalanceSnapshots` is false for the backfill: a backfill repairs
 * *transaction history* for a past window, and the balance it would record
 * is the balance as of now — not as of the backfilled window. Recording it
 * would put a misleading "historical" snapshot into the balance history.
 */
export async function ensureAkahuCards(params: {
  userId: string;
  accounts: AkahuAccount[];
  captureBalanceSnapshots: boolean;
}): Promise<{
  cardsByProviderId: Map<string, { id: string }>;
  balanceSnapshotsCreated: number;
  cardsSkippedCrossTenant: number;
}> {
  const cardsByProviderId = new Map<string, { id: string }>();
  const balanceCapturedAt = new Date();
  let balanceSnapshotsCreated = 0;
  let cardsSkippedCrossTenant = 0;

  for (const acc of params.accounts) {
    const currentBalanceCents = akahuAmountToCents(acc.balance?.current);
    const availableBalanceCents = akahuAmountToCents(acc.balance?.available);
    const balanceCurrency = acc.balance?.currency ?? null;
    const balanceOverdrawn =
      typeof acc.balance?.overdrawn === 'boolean' ? acc.balance.overdrawn : null;
    const hasBalance =
      currentBalanceCents !== null ||
      availableBalanceCents !== null ||
      balanceCurrency !== null ||
      balanceOverdrawn !== null;

    // `LinkedCard` is unique on (provider, providerCardId) globally, not per
    // user, so a lookup by the provider's account id can find a card that
    // belongs to somebody else — an Akahu account linked to two users, or a
    // reconnect that re-points the connection. That card is not this user's:
    // writing to it would rewrite another user's card and would attach this
    // user's transactions to it. It is left untouched and the account is
    // skipped, so the transactions under it are skipped too (no card).
    const existing = await prisma.linkedCard.findUnique({
      where: { provider_providerCardId: { provider: 'akahu', providerCardId: acc._id } },
      select: { id: true, userId: true }
    });

    if (existing && existing.userId !== params.userId) {
      cardsSkippedCrossTenant += 1;
      console.warn('[akahu-ingest] skipped a provider account linked to another user', {
        providerCardId: acc._id,
        ownerUserId: existing.userId,
        requestedUserId: params.userId
      });
      continue;
    }

    const card = await prisma.linkedCard.upsert({
      where: {
        provider_providerCardId: { provider: 'akahu', providerCardId: acc._id }
      },
      update: {
        displayName: acc.name ?? 'Akahu account',
        currentBalanceCents,
        availableBalanceCents,
        balanceCurrency,
        balanceOverdrawn,
        balanceUpdatedAt: hasBalance ? balanceCapturedAt : null
      },
      create: {
        userId: params.userId,
        provider: 'akahu',
        providerCardId: acc._id,
        displayName: acc.name ?? 'Akahu account',
        last4: null,
        currentBalanceCents,
        availableBalanceCents,
        balanceCurrency,
        balanceOverdrawn,
        balanceUpdatedAt: hasBalance ? balanceCapturedAt : null
      },
      select: { id: true }
    });
    cardsByProviderId.set(acc._id, card);

    if (hasBalance && params.captureBalanceSnapshots) {
      await prisma.accountBalanceSnapshot.create({
        data: {
          userId: params.userId,
          cardId: card.id,
          currentBalanceCents,
          availableBalanceCents,
          currency: balanceCurrency,
          overdrawn: balanceOverdrawn,
          capturedAt: balanceCapturedAt
        }
      });
      balanceSnapshotsCreated += 1;
    }
  }

  return { cardsByProviderId, balanceSnapshotsCreated, cardsSkippedCrossTenant };
}

/**
 * Upserts settled transactions by `providerTransactionId`.
 *
 * Idempotent by construction: a row that already exists is updated, never
 * duplicated, so re-running a backfill over the same window creates no
 * duplicates. Transactions whose account is not in `cardsByProviderId` are
 * skipped and counted — a transaction with no card cannot be written, and
 * dropping it silently would make a backfill look complete when it is not.
 *
 * `providerTransactionId` is a *global* unique column, not scoped per
 * user, so a lookup by it can find a row that belongs to somebody else (an
 * Akahu account linked to two users, or a reconnect that re-points
 * `AkahuConnection`). Such a row is never written: it is skipped and
 * counted separately, because updating it would rewrite another user's
 * financial record while leaving the row on their account.
 *
 * The write is a read-then-write, so two concurrent backfills over the
 * same window can both miss the row and race to create it. The loser of
 * that race gets a unique-constraint violation; it re-reads the row the
 * winner inserted and converges on it, so the run still ends with one row
 * per provider transaction instead of failing.
 */
export async function upsertAkahuSettledTransactions(params: {
  userId: string;
  transactions: AkahuTransaction[];
  cardsByProviderId: Map<string, { id: string }>;
}): Promise<{
  created: number;
  updated: number;
  categorized: number;
  skipped: number;
  skippedCrossTenant: number;
}> {
  let created = 0;
  let updated = 0;
  let categorized = 0;
  let skipped = 0;
  let skippedCrossTenant = 0;

  for (const t of params.transactions) {
    const card = params.cardsByProviderId.get(t._account);
    if (!card) {
      skipped += 1;
      continue;
    }

    const amountCentsAbs = Math.round(Math.abs(t.amount) * 100);
    const direction: 'debit' | 'credit' = t.amount < 0 ? 'debit' : 'credit';
    const merchant = t.merchant?.name ?? null;
    const providerTransactionId = `akahu:${t._id}`;

    const settlement = {
      occurredAt: new Date(t.date),
      merchant,
      description: t.description,
      amountCents: amountCentsAbs,
      direction
    };

    const existing = await prisma.transaction.findUnique({
      where: { providerTransactionId },
      select: { id: true, userId: true }
    });

    if (existing) {
      if (existing.userId !== params.userId) {
        skippedCrossTenant += 1;
        console.warn('[akahu-ingest] skipped a provider transaction owned by another user', {
          providerTransactionId,
          ownerUserId: existing.userId,
          requestedUserId: params.userId
        });
        continue;
      }
      await prisma.transaction.update({ where: { id: existing.id }, data: settlement });
      updated += 1;
      continue;
    }

    const categoryInputMerchant = merchant ?? t.description ?? 'unknown';
    const cat = await categorizeTransaction({
      userId: params.userId,
      merchant: categoryInputMerchant,
      description: t.description,
      amountCents: amountCentsAbs
    });

    try {
      await prisma.transaction.create({
        data: {
          userId: params.userId,
          cardId: card.id,
          provider: 'akahu',
          providerTransactionId,
          ...settlement,
          category: cat.category,
          categoryConfidence: cat.confidence,
          categorySource: cat.source
        }
      });
      created += 1;
      categorized += 1;
    } catch (err: any) {
      // A concurrent writer inserted the same provider transaction between
      // our lookup and our insert. Converge on the row they wrote instead
      // of failing the run.
      if (String(err?.code) !== 'P2002') throw err;

      const winner = await prisma.transaction.findUnique({
        where: { providerTransactionId },
        select: { id: true, userId: true }
      });
      if (!winner) throw err;

      if (winner.userId !== params.userId) {
        skippedCrossTenant += 1;
        console.warn('[akahu-ingest] skipped a provider transaction owned by another user', {
          providerTransactionId,
          ownerUserId: winner.userId,
          requestedUserId: params.userId
        });
        continue;
      }

      await prisma.transaction.update({ where: { id: winner.id }, data: settlement });
      updated += 1;
    }
  }

  return { created, updated, categorized, skipped, skippedCrossTenant };
}
