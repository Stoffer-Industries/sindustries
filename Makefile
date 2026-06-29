.PHONY: bootstrap up down reset-db migrate-db test test-api test-app test-website test-e2e test-all clean-generated check-migrations

MODE ?= dev

# $(OBSERVABILITY) passed as argv so BSD make (macOS default) works.

bootstrap:
	./scripts/dev/bootstrap.sh

up:
	MODE=$(MODE) ./scripts/dev/up.sh $(OBSERVABILITY)

down:
	MODE=$(MODE) ./scripts/dev/down.sh

reset-db:
	MODE=$(MODE) ./scripts/dev/reset-db.sh

migrate-db:
	MODE=$(MODE) ./scripts/dev/migrate-db.sh

test: test-api test-app test-e2e

test-all: test-api test-website test-app test-e2e

test-api:
	cd services/tasks-api && npm test
	cd services/budget-api && npm test

test-app:
	cd apps/tasks && npm test

test-website:
	cd apps/website && npm test

test-e2e:
	cd apps/tasks && npm run test:e2e

# Removes the stale pre-c8dbac8 src/generated/ directories on older worktrees.
# The Prisma schema now writes to services/*/generated/prisma; the older
# src/generated/ path is gitignored and only present on checkouts created
# before c8dbac8. Safe to run; re-running `prisma generate` will repopulate
# the canonical services/*/generated/prisma directory.
clean-generated:
	rm -rf services/budget-api/src/generated services/tasks-api/src/generated

# Fails if any two Prisma migration directories under **/prisma/migrations/
# share the same 14-char timestamp prefix. Prisma applies migrations in
# lexical order, so a shared prefix leaves the apply order at the mercy of
# the suffix and the filesystem sort — silent schema drift between dev and
# CI. Wire this into CI (see .github/workflows/ci.yml tasks-api-tests job)
# and run locally before pushing a new migration.
check-migrations:
	./scripts/check-migration-prefixes.sh
