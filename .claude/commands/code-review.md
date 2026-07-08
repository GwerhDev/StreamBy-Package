---
description: Full audit of StreamBy-Package — routes, services, adapters, models, and types. Checks layer violations, naming conventions, error handling, security, type safety, and test coverage. Produces a prioritized remediation plan.
---

You are the lead reviewer for StreamBy-Package. Your job is to audit code against the project's architecture conventions and produce a prioritized remediation plan.

If `$ARGUMENTS` is provided, review that specific file or directory.
If no argument is given, ask the user what scope to review (single file, directory, or full project).

---

## Architecture

StreamBy-Package is a Node.js/Express library (`createStreamByRouter()`) with four clear layers:

```
src/
  adapters/        DB abstraction — sql.ts, nosql.ts, connectionManager.ts
  middleware/
    routes/        Express routers by domain (one file per resource)
  services/        Business logic — pure functions, no HTTP concerns
  models/          Generic Model<T> registry
  providers/       Storage adapter instances
  types/           Centralized TypeScript contracts
  utils/           Pure helpers (auth, encryption, sanitize)
test/              Integration tests (Vitest)
```

**Layer rules:**
- Routes call services — never write business logic in route handlers
- Services are pure functions — no `req`/`res`, no HTTP status codes
- Adapters abstract DB — services never import `pg` or `mongoose` directly
- Types are centralized in `src/types/` — no inline interface declarations in routes or services

---

## What to check

### A. Layer violations

- **Route handlers with business logic:** flag any route file with more than ~15 lines of non-routing logic (data transformations, loops, conditionals beyond a guard clause) — extract to a service.
- **Services importing from `middleware/`:** any import of `req`, `res`, `Router`, or Express types inside `src/services/` is a violation.
- **Direct DB access in routes:** any import of `pg`, `mongoose`, `Model`, or adapter types directly in a route file — must go through a service.
- **Utils with side effects:** `src/utils/` must contain pure functions only — no DB calls, no external HTTP.

### B. Naming conventions

| Context | Convention | Example |
|---|---|---|
| Route files | `kebab-case.ts` | `workflow.ts`, `ai.ts` |
| Service files | `camelCase.ts` | `pipeline.ts`, `wsHub.ts` |
| Util files | `camelCase.ts` | `encryption.ts` |
| Interfaces/types | `PascalCase` | `StorageConnection`, `UserPlan` |
| Functions | `camelCase` | `createStreamByRouter`, `emitToUser` |
| Classes | `PascalCase` | `Model<T>` |

Flag any deviation.

### C. Type safety

- Flag any `any` type in function parameters, return types, or interface fields.
- Flag missing return type annotations on exported functions.
- Flag non-null assertions (`!`) without a preceding guard — these hide runtime errors.
- Flag `as SomeType` casts that bypass proper narrowing.

### D. Error handling

- Every async route handler must have try/catch or be wrapped in an error-handling middleware.
- Services must throw typed errors (or return `Result`-style objects) — never `console.error` and return `undefined`.
- Flag any `catch (e) {}` or `catch (e) { console.log(e) }` that swallows errors silently.
- Flag missing `next(err)` calls in Express error paths.

### E. Security

- Flag any route that accepts user input without sanitization before DB queries.
- Flag any SQL query using string interpolation instead of parameterized queries.
- Flag missing auth middleware on routes that should be protected.
- Flag any secret or credential hardcoded in source (keys, tokens, passwords).
- Flag any `encryption.ts` or `auth.ts` util that uses deprecated or weak algorithms.

### F. Tests

Check for:
- `test/` directory with Vitest integration tests
- Each service with non-trivial logic has a corresponding test
- Tests cover error paths, not only the happy path

Report missing tests grouped by priority:
- **High:** Services with DB writes, auth logic, encryption/decryption
- **Medium:** Services with complex transformations or external API calls
- **Low:** Simple CRUD wrappers, utility functions

---

## Output format

For each file reviewed:

```
### src/middleware/routes/workflow.ts

Layer
✓ Calls services correctly
⚠ Lines 45–80: transformation logic inline — extract to workflowService.formatNodes()

Type safety
✓ All params typed
⚠ Line 12: return type missing on exported handler

Error handling
⚠ Line 67: catch block swallows error — add next(err) call

Security
✓ Input sanitized via sanitize.ts
⚠ Line 103: SQL string interpolation — use parameterized query

Tests
⚠ No test for workflowService.updateNodeSchema — HIGH priority (DB write)
```

---

## Remediation plan

```
## Remediation Plan

### P1 — Quick wins (low effort, high correctness impact)
- [ ] Add return type annotations to all exported service functions
- [ ] Fix swallowed catch blocks (list files + lines)
- [ ] Replace SQL string interpolation with parameterized queries (list files)
- [ ] Remove any types from interfaces (list files)

### P2 — Architecture (medium effort)
- [ ] Extract inline business logic from routes to services (list files)
- [ ] Remove direct DB imports from routes (list files)

### P3 — Security
- [ ] Add input sanitization to routes accepting user data (list)
- [ ] Add auth middleware to unprotected routes (list)

### P4 — Test coverage
- [ ] Add Vitest tests for High-priority services (list)
- [ ] Add error path coverage to existing tests
```

Show counts: total findings, by severity (P1/P2/P3/P4), by category.
