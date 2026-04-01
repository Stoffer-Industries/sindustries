import { prisma } from '../src/lib/prisma.ts';

async function main() {
  const email = 'dev@example.com';
  const user =
    (await prisma.user.findUnique({ where: { email } })) ??
    (await prisma.user.create({ data: { email } }));

  const card =
    (await prisma.linkedCard.findFirst({ where: { userId: user.id } })) ??
    (await prisma.linkedCard.create({
      data: {
        userId: user.id,
        provider: 'demo',
        providerCardId: `demo-${user.id}`,
        displayName: 'Demo Visa',
        last4: '1234'
      }
    }));

  await prisma.cardMonthlyBudget.upsert({
    where: { cardId_month: { cardId: card.id, month: currentMonthKey() } },
    update: { monthlyLimitCents: 200_000 },
    create: {
      userId: user.id,
      cardId: card.id,
      month: currentMonthKey(),
      monthlyLimitCents: 200_000
    }
  });

  console.log('Seeded dev user', { userId: user.id, cardId: card.id });
}

function currentMonthKey() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

