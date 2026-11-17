# Independent audit tests

These tests are separate from the main test suite (`pnpm test`, `pnpm smoke`). They write nothing to the project and use only synthetic data.

| File | What it does | How to run |
|---|---|---|
| `run-privacy-harness.mjs` + `privacy-harness/` | Privacy pixel tests: time range, cuts, zoom, camera, 4 formats, moving area. Also a leak check on exported MP4/WebM frames and a performance measurement. Two different synthetic "secrets" are used; on hidden frames the output must be byte-for-byte identical. | `node tests/audit/run-privacy-harness.mjs` |
| `persist.audit.test.ts` | Whether a complex project, once saved and opened, is exactly the same and draws the same. | `npx vitest run --config tests/audit/vitest.audit.config.ts` |

