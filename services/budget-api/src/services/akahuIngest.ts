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
}> {
  const cardsByProviderId = new Map<string, { id: string }>();
  const balanceCapturedAt = new Date();
  let balanceSnapshotsCreated = 0;

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

  return { cardsByProviderId, balanceSnapshotsCreated };
}

/**
 * Upserts settled transactions by `providerTransactionId`.
 *
 * Idempotent by construction: a row that already exists is updated, never
 * duplicated, so re-running a backfill over the same window creates no
 * duplicates. Transactions whose account is not in `cardsByProviderId` are
 * skipped and counted — a transaction with no card cannot be written, and
 * dropping it silently would make a backfill look complete when it is not.
 */
export async function upsertAkahuSettledTransactions(params: {
  userId: string;
  transactions: AkahuTransaction[];
  cardsByProviderId: Map<string, { id: string }>;
}): Promise<{ created: number; updated: number; categorized: number; skipped: number }> {
  let created = 0;
  let updated = 0;
  let categorized = 0;
  let skipped = 0;

  for (const t of params.transactions) {
    const card = params.cardsByProviderId.get(t._account);
    if (!card) {
      skipped += 1;
      continue;
    }

    const amountCentsAbs = Math.round(Math.abs(t.amount) * 100);
    const direction = t.amount < 0 ? 'debit' : 'credit';
    const merchant = t.merchant?.name ?? null;
    const providerTransactionId = `akahu:${t._id}`;

    const existing = await prisma.transaction.findUnique({
      where: { providerTransactionId },
      select: { id: true }
    });

    if (existing) {
      await prisma.transaction.update({
        where: { providerTransactionId },
        data: {
          occurredAt: new Date(t.date),
          merchant,
          description: t.description,
          amountCents: amountCentsAbs,
          direction
        }
      });
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
    categorized += 1;

    await prisma.transaction.create({
      data: {
        userId: params.userId,
        cardId: card.id,
        provider: 'akahu',
        providerTransactionId,
        occurredAt: new Date(t.date),
        merchant,
        description: t.description,
        amountCents: amountCentsAbs,
        direction,
        category: cat.category,
        categoryConfidence: cat.confidence,
        categorySource: cat.source
      }
    });
    created += 1;
  }

  return { created, updated, categorized, skipped };
}
