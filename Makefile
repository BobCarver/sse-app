# Makefile for common development tasks

.PHONY: e2e-up e2e-init e2e-run e2e-teardown e2e-full e2e-keep

# Bring up DB with docker compose
e2e-up:
    docker compose up -d db

# One-shot DB init (applies schema and seed)
e2e-init:
    docker compose run --rm db-init

# Run e2e tests (assumes DB is up and initialized)
e2e-run:
    cd tests && npm ci && npx playwright test

# Tear down DB (removes containers)
e2e-teardown:
    docker compose down

# Full flow: up, init, run tests, teardown
e2e-full: e2e-up e2e-init e2e-run e2e-teardown

# run tests but keep DB running
e2e-keep:
    docker compose up -d db && docker compose run --rm db-init && cd tests && npm ci && npx playwright test

