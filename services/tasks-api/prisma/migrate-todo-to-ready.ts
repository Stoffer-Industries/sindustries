// Migration script to update existing tasks from todo -> open
// Run this once to migrate existing data

import { prisma } from '../src/lib/prisma';

async function migrate() {
  console.log('Starting migration: todo -> open');
  
  // Update tasks with status 'todo' to 'open'
  const result = await prisma.task.updateMany({
    where: { status: 'todo' },
    data: { status: 'open' }
  });
  
  console.log(`Updated ${result.count} tasks from 'todo' to 'open'`);
  
  // Verify the migration
  const todoCount = await prisma.task.count({ where: { status: 'todo' } });
  const openCount = await prisma.task.count({ where: { status: 'open' } });
  
  console.log(`Verification: ${todoCount} tasks still have 'todo', ${openCount} have 'open'`);
  
  await prisma.$disconnect();
  console.log('Migration complete');
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
