# Makefile for common development tasks

.PHONY: e2e-up e2e-init e2e-run e2e-teardown e2e-full

# Bring up DB with docker compose
e2e-up:
	deno task docker:postgres:compose:up

# One-shot DB init (applies schema and seed)
e2e-init:
	deno task docker:postgres:db-init

# Run e2e tests (assumes DB is up and initialized)
e2e-run:
	deno task test:e2e

# Tear down DB (removes containers, left volumes intact)
e2e-teardown:
	deno task docker:postgres:compose:down

# Full flow: up, init, run tests, teardown
e2e-full: e2e-up e2e-init e2e-run e2e-teardown

e2e-keep: # run tests but keep DB running
	docker compose up -d db && deno task docker:postgres:db-init && deno task test:e2e
