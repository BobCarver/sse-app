Project Overview
This workspace contains a multi‑runtime system with three distinct execution environments:
1. Deno — the primary application runtime, build system, and artifact compiler
2. Node.js — used exclusively for Playwright‑based end‑to‑end tests
3. Docker — used for Postgres and other infrastructure services
The project must maintain strict separation between these runtimes. Copilot should generate code and suggestions that respect this separation.
---
Directory Structure Requirements
The project follows this structure:
project/
  deno.json
  deno.lock

  public/
    clientA.js
    clientB.js
    clientC.js
    assets/

  app/
    src/
      main.ts
      routes/
      services/
      db/
    artifacts-src/
      clientA/
      clientB/
      clientC/
    tests/
      unit/
      integration/

  node-tests/
    package.json
    tsconfig.json
    playwright.config.ts
    tests/

  docker/
    postgres/
      Dockerfile
      init/
        001-schema.sql
        002-seed.sql
    compose.yaml

  scripts/
    build_artifacts.ts
    migrate.ts
    seed.ts

Copilot should preserve and reinforce this structure when generating new files or refactoring existing ones.
---
Security Boundary
• All publicly served files must live under public/.
• Nothing inside app/ should ever be directly served to clients.
• Copilot must not generate static‑file routes that expose application directories.
• Only the public/ directory is safe to mount as a static root.
---
Deno Application Rules
• All application code lives under app/src/.
• Use Deno’s standard library and JSR modules.
• Avoid Node APIs in the Deno runtime.
• Use Hono‑style routing patterns.
• Database access must go through a dedicated DB adapter layer.
• No business logic inside route handlers.
• Prefer pure functions where possible for unit testing.
---
Artifact Build Pipeline
The server supports three different client types, each requiring its own bundled artifact.
Requirements:
• Source files live in app/artifacts-src/clientX/.
• Output bundles must be written to public/clientX.js.
• Bundles must be deterministic and self‑contained.
• Use Deno’s bundling capabilities (deno bundle or Deno.emit).
• The build script is located at scripts/build_artifacts.ts.
• Copilot should generate or modify artifacts only within these directories.
---
Deno Tasks
Copilot should maintain or extend these tasks in deno.json:
• build:artifacts → runs the artifact bundling script
• build → runs all build steps
• test → runs Deno unit and integration tests
• dev → starts the Deno server
Tasks must remain cross‑platform and deterministic.
---
Testing Rules
Unit Tests (`app/tests/unit/`)
• Test pure functions and isolated modules.
• No database, filesystem, or network access.
• Use Deno’s built‑in test runner.
Integration Tests (`app/tests/integration/`)
• Use real Postgres (via Docker).
• Test route + service + DB interactions.
• Use rollback‑based isolation where appropriate.
Node‑based Playwright Tests (`node-tests/`)
• Must run only in the Node runtime.
• Must not import Deno modules.
• Should assume the Deno server is already running.
---
Docker Requirements
• All Docker‑related files live under docker/.
• Postgres must be defined in docker/compose.yaml.
• Initialization SQL lives in docker/postgres/init/.
• Copilot should not place application code inside Docker directories.
---
Server Behavior
• The Deno server must serve static files exclusively from the public/ directory.
• The server must choose the correct bundle (clientA.js, clientB.js, clientC.js) based on client type.
• No other directories should be exposed to the browser.
---
General Coding Conventions
• Prefer explicit imports over wildcard imports.
• Use clear, deterministic naming.
• Avoid hidden side effects.
• Keep modules small and composable.
• Favor pure functions for logic-heavy code.
• Maintain strict separation between:
	◦ routing
	◦ services
	◦ database access
	◦ artifact generation
	◦ testing
---
What Copilot Should Avoid
• Do not mix Node and Deno APIs.
• Do not place build scripts outside scripts/.
• Do not generate artifacts outside public/.
• Do not modify Docker files unless explicitly asked.
• Do not introduce import maps unless required.
• Do not generate code that assumes a browser bundler like Webpack, Vite, or Rollup.
---
Primary Goal
Copilot should help maintain a clean, deterministic, audit‑friendly architecture with strict runtime boundaries, a secure static‑file boundary, and a predictable build pipeline.