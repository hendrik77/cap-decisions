# cap-jev project review

Reviewed on 2026-10-19 at commit `1ca4d34`. Typecheck, all 9 tests and `npm pack --dry-run` pass; the package is 6.5 kB with 12 files.

## What's good

- **Small, clear layout.** Each file has one job: `types.ts` for the types, `validation.ts` for checking data, `transport.ts` for HTTP, and `index.ts` for the CAP wiring. There are no runtime dependencies beyond the `@sap/cds` peer dependency, and the code uses native `fetch` and `AbortSignal.timeout`.
- **Typed answers.** `Answers<Q>` gives each question the right answer type, so `result.answers.department.choice` is checked by the compiler without casts.
- **Strict response validation.** One answer per question with a matching `type`, choices must be among the sent labels, probabilities must sum to about 1, and score range and legend keys are checked. Bad model answers fail loudly instead of reaching business logic.
- **Bad requests fail before any network call** (`validateRequest`).
- **Careful with secrets.** HTTP errors don't include the response body, the token never appears in a message, and a test proves the response body isn't leaked.
- **Realistic integration test.** It packs the tarball, installs it into a copy of the example app and runs `cds.connect.to('systemone')`, which catches packaging and plugin-discovery bugs unit tests miss.
- **Good docs.** The README is short and covers all three providers. AGENTS.md exists, and `.gitignore` covers CAP-specific secret files (`.cdsrc-private.*`, `default-env.json`).

## What could be better

### Correctness and robustness

1. **Response bodies aren't released before a retry or error** (`src/transport.ts:38-42`). Node's `fetch` keeps the connection busy until the body is read. Add `await response.body?.cancel()` before `continue` and before throwing `HTTP_ERROR`.
2. **The timeout applies to each attempt, not the whole call.** With the 10 s default, one `decide()` can take about 30 s. Either document this or use a single overall deadline.
3. **Retry policy is narrow.**
   - It ignores the `Retry-After` header.
   - It doesn't retry 502, 503, 504 or connection resets.
   - The fixed 100/200 ms delays have no jitter.
   - 429 on a rate-limited API usually needs more than 300 ms.
4. **The original error is discarded.** `NETWORK_ERROR` and `INVALID_RESPONSE` don't keep the underlying error, so DNS, TLS and connection-refused failures look identical. Pass `{ cause: error }`; it stays inside the process.
5. **Callers can't cancel a request.** Accept an optional `signal` and combine it with the timeout via `AbortSignal.any`, so a request can be cancelled along with its CAP request.

### CAP integration

6. **`decide` is a plain method, not a CAP event.** Apps can't add `before`/`after` handlers, mock it in tests via `cds.requires.systemone.impl`, or get CAP tracing. The CAP-style pattern is to register `on('decide', …)` in `init()` and have `decide()` call `this.send('decide', …)`.
7. **Configuration is checked on every call, not at startup.** `src/index.ts:8` creates a new `SystemOneTransport` and re-validates URL, timeout and format on each call. Doing it once in `init()` makes a bad config fail at startup.
8. **No logging.** A `cds.log('systemone')` debug line with latency, attempt count, model and token usage (never the state) would help in production.
9. **The `module.exports = Object.assign(SystemOneService, module.exports)` workaround** (`src/index.ts:23`) copies named exports onto the class and drops `__esModule`. It works but is fragile; a small CommonJS entry file would keep the TypeScript module clean.
10. **Defaults are defined twice.** The URL and `jev-latest` appear in both `package.json` → `cds.requires` and `src/transport.ts:4,22`, so they can drift. Keep one source.

### Types and build

11. **Questions defined in a variable lose their typing.** `type: 'choice'` widens to `string` and fails to type-check. The README should show `satisfies Questions` or `as const`.
12. **`tsconfig.json`:**
    - `"lib": ["DOM"]` isn't needed (Node 22 types include `fetch`) and lets browser globals type-check.
    - `moduleResolution: "Node"` is the legacy resolver; use `Node16`/`NodeNext`.
13. **`package.json` lacks an `exports` map,** plus `repository`, `keywords` and `author`, before npm publication.

### Tests and tooling

14. **Untested paths:**
    - invalid `url`, `timeoutMs` or `responseFormat`
    - `NETWORK_ERROR` (server closed)
    - invalid JSON
    - Cloudflare response without `result`
    - invalid score answers (out of range, bad legend)
    - noul `criteria` validation
    - choice criteria above 255 entries, score criteria outside 2–10

    AGENTS.md asks for a failure case per behavior, so these are worth adding.
15. **The integration test depends on the local machine.** `npm install --offline` needs a warm npm cache and will fail in a fresh CI run. It also has no timeout.
16. **No CI, linter or formatter.** A GitHub Actions workflow running typecheck, test and pack on Node 22/24, plus ESLint and Prettier, would cover it.
17. **Request limits are undocumented.** The enforced API limits (choice ≤255 labels, score 2–10 criteria) aren't in the README. *Merged into item 23.*

## Provider integration and API key handling

Researched against the provider docs and the CAP docs (sources below).

### Already correct

- **Bearer header.** TypeSafe, Cloudflare and Laya all expect `Authorization: Bearer <key>` (Laya only when `LAYA_API_KEY` is set), which matches `src/transport.ts:25`.
- **Key under `credentials`.** On Cloud Foundry and Kyma, CAP copies the fields of a matching service binding into `cds.requires.<srv>.credentials`, so a user-provided service named after the service works without code changes.
- **No key in errors or logs.**
- **Cloudflare envelope.** Unwrapping `{ result, success, errors, messages }` matches the docs.
- **Retrying 429/529** matches TypeSafe's documented guidance ("retry after a short delay").

### Problems

18. **The key can be sent over plain HTTP.** `src/transport.ts:15` accepts `http:` for any host and still attaches the token. Send a token only over `https:`, or over `http:` to loopback addresses (`127.0.0.1`, `localhost`, `::1`); otherwise throw `INVALID_CONFIG`.
19. **Data goes to an external service without configuration.** The plugin's `package.json` defaults to `https://api.typesafe.ai/...`. An unconfigured app sends `state` (often customer data) without a token to an external US provider; it gets a 401, but the data has already left. Fail closed: either drop the default URL, or refuse to send to a known cloud host when no token is set.
20. **Secret injection is undocumented.** *Status: rename done; documentation partly done.* The README showed the token as a placeholder in `package.json`; CAP explicitly advises against static environment-specific settings. Recommended sources:

    | Environment | Recommended way |
    |---|---|
    | Local | `.cdsrc-private.json` (not committed) or `cds bind` |
    | Cloud Foundry | User-provided service named `systemone` |
    | Kyma/K8s | Secret as servicebinding.io binding (`SERVICE_BINDING_ROOT`) |
    | Any | `CDS_CONFIG` with JSON, or `CDS_REQUIRES_SYSTEMONE_CREDENTIALS_TOKEN` |

    **Done:** the service was renamed from `system-one` to `systemone`. The hyphen made single environment variables impractical. The name is all lowercase because CAP lowercases all-uppercase variable names (`node_modules/@sap/cds/lib/env/cds-env.js:245`), so a camelCase `systemOne` would not match. The README now documents the variable and the Cloud Foundry binding.
21. **The provider is selected only implicitly.** Jev, Clef or Laya follows from the combination of `url`, `model` (including the `null` special case) and `responseFormat`, and Cloudflare users must assemble the account URL themselves. CAP's idiom for this is **`kinds`**, as used by `@cap-js/sqlite`:

    ```json
    "cds": { "requires": {
      "systemone": { "kind": "systemone-typesafe" },
      "kinds": {
        "systemone-typesafe":   { "impl": "cap-jev", "provider": "typesafe",   "credentials": { "model": "jev-latest" } },
        "systemone-cloudflare": { "impl": "cap-jev", "provider": "cloudflare", "credentials": { "model": "clef" } },
        "systemone-laya":       { "impl": "cap-jev", "provider": "laya",       "credentials": { "url": "http://127.0.0.1:8000/v1/systemone" } }
      }
    }}
    ```

    - Apps set only `kind`, the token and, for Cloudflare, `accountId`; the plugin builds the URL.
    - Profiles work directly, for example `"[development]": { "kind": "systemone-laya" }`.
    - `responseFormat` and `model: null` disappear as settings users must know.
    - Each provider gets its own logic for unwrapping, limits and error parsing.
22. **Cloudflare responses are checked too loosely.** Only the presence of `result` is checked. Check `success === true`, map the code from `errors[]` (without the message text), and unwrap `result` only on success.
23. **Request limits are global but differ by provider.** Validation allows up to 255 `choice` options and 2–10 `score` criteria, but Laya accepts at most 100 options per question and Clef 1–64 questions per request. Make the limits per provider, or leave them to the server.
24. **No SAP BTP destination support.** On BTP, the Destination service is the usual way to manage external API credentials centrally; a static key fits a `NoAuthentication` destination with the property `URL.headers.Authorization`. Because the plugin calls `fetch` directly, it can't use one. An option is `credentials.destination`, resolved via `@sap-cloud-sdk/connectivity` as an optional peer dependency. Worth it only if BTP is a target.
25. **Minor:**
    - The README should say the Cloudflare token must be a separate, account-owned token with only "Workers AI – Read" and "Workers AI – Edit" (least privilege).
    - TypeSafe returns a JSON error body; passing on a machine-readable field such as `error.type` would help and stay safe as long as no free text is copied.

### Sources

- [TypeSafe System One API](https://docs.typesafe.ai/api)
- [Cloudflare Clef](https://developers.cloudflare.com/workers-ai/models/clef/)
- [Workers AI REST API – token permissions and response envelope](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)
- [Cloudflare: account-owned token template](https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/)
- [Laya System One – self-hosting](https://github.com/WhoIsMrSentry/laya-system-one)
- [CAP: cds.env – configuration sources and private files](https://cap.cloud.sap/docs/node.js/cds-env)
- [CAP: cds.connect – service bindings, vcap matching, K8s](https://cap.cloud.sap/docs/node.js/cds-connect)
- [CAP: plugins and `kinds`](https://cap.cloud.sap/docs/node.js/cds-plugins)
- [How to integrate external REST APIs in SAP CAP](https://otvsvn.substack.com/p/how-to-integrate-external-rest-apis)
- [Using the Destination service in Node.js locally](https://blogs.sap.com/2020/05/28/use-the-destination-service-in-nodejs-locally/)


## Implementation brief

This section is the work order for a coding agent. The findings above explain *why*; this section decides *what* to build. Where the two differ, this section wins. Line numbers above refer to commit `1ca4d34` and will drift; locate code by function name.

### Ground rules

- Read `AGENTS.md` first and follow it: strict TypeScript, two-space indentation, CommonJS `.cjs` tests with `node:test`, local HTTP servers only, no external API keys.
- **Breaking changes are allowed** (version 0.x, not yet published). Bump the version to `0.2.0` and add a `CHANGELOG.md` that lists every breaking change with a migration note.
- **New dependencies are allowed** when an item needs one. Prefer optional peer dependencies for features not every app uses.
- Every behaviour change gets a test, including at least one failure case.
- Keep the README in sync with each change. Never put a real token or account ID in any file.
- After every commit, `npm run lint`, `npm run typecheck`, `npm test` and `npm pack --dry-run` must pass.
- One focused commit per step below, with a short imperative subject (see `AGENTS.md`).
- When an item is done, mark it in this file with *Done in `<commit>`*.
- If the code contradicts an assumption here, or a design choice can't be implemented as described, stop and report instead of guessing.

### Decisions

| Topic | Decision |
|---|---|
| Fail-closed (19) | No default endpoint. Without a configured `url`, Cloudflare `accountId` or `destination`, the service throws `INVALID_CONFIG`. |
| Token transport (18) | Send a token only over `https:`, or over `http:` to `127.0.0.1`, `localhost` or `::1`. Anything else throws `INVALID_CONFIG`. |
| Provider model (21) | CAP `kinds`: a generic base kind `systemone` for any Jev-compatible endpoint (also local servers), plus presets `systemone-typesafe`, `systemone-cloudflare`, `systemone-laya`. |
| CAP event (6) | `decide()` becomes a CAP event; the call signature `decide({ state, questions })` stays. |
| Timeout and retry (2, 3) | `timeoutMs` is one deadline for the whole call. Retry 429, 502, 503, 504, 529 and network errors, at most 2 retries, honour `Retry-After` capped by the remaining deadline, exponential backoff with jitter otherwise. |
| BTP destinations (24) | Optional support via `credentials.destination`, resolved with `@sap-cloud-sdk/connectivity` as an optional peer dependency. |
| Tooling | ESLint, Prettier and the `tsconfig` modernisation are in scope. |
| Out of scope | CI workflow (16, CI part) and the `--offline` dependency of the integration test (15). |

### Steps

**Step 1 – Tooling (items 12, 16 lint part)**
- Add ESLint (flat config, `typescript-eslint`) and Prettier as dev dependencies; add `lint` and `format` scripts.
- Prettier: single quotes, semicolons, two spaces, `printWidth` 120.
- `tsconfig.json`: remove `"DOM"` from `lib`; switch to `module`/`moduleResolution` `Node16`. Fix any resulting type errors.
- Commit the formatter run **separately** from the config so the reformatting diff is reviewable on its own.
- *Acceptance:* `npm run lint` passes; no code behaviour changes; all tests pass.

**Step 2 – Security (items 18, 19)**
- Implement the token-transport rule and remove the default URL and default model from `src/transport.ts` and the plugin's `package.json`.
- *Acceptance:* tests for token over `http://example.com` → `INVALID_CONFIG`; token over `http://127.0.0.1` → sent; no URL configured → `INVALID_CONFIG` and no request reaches the test server.

**Step 3 – Transport robustness (items 1–5, 22, 25)**
- Cancel the response body before every retry and before throwing on a non-OK status.
- Overall deadline and retry policy as decided above. Retries must stop when the deadline is reached.
- Keep the original error as `cause` on every `SystemOneError`.
- Accept an optional caller `AbortSignal` and combine it with the deadline (`AbortSignal.any`). An abort by the caller gets its own code `ABORTED`.
- Cloudflare: require `success === true`; on failure, put the first `errors[].code` into a new optional `SystemOneError.providerCode`. Never copy message text from a provider response.
- TypeSafe and other Jev-compatible endpoints: if the error body is JSON with a machine-readable type field, put it into `providerCode` as well.
- *Acceptance:* tests for: body cancel (the connection is reused, or no socket leak with many failing calls), `Retry-After` honoured and capped, retry on 503 and on a closed connection, deadline across retries, caller abort, `cause` set, Cloudflare `success: false` with `providerCode`, invalid JSON, missing `result`.

**Step 4 – CAP integration (items 6–10, 13)**
- `SystemOneService.init()` reads and validates the configuration once and registers `this.on('decide', …)`. `decide(request, options?)` calls `this.send`. Pass the optional `AbortSignal` through to the handler; choose a mechanism that works with `cds.Request` and cover it with a test.
- An invalid configuration must make `cds.connect.to('systemone')` reject with `INVALID_CONFIG`.
- Add `cds.log('systemone')` debug logging: latency, attempt count, model, token usage. Never log `state`, questions, answers, URL query strings or tokens.
- Keep every default in exactly one place (the `kinds` presets from step 5); the TypeScript code must not repeat them.
- Remove the `module.exports = Object.assign(…)` workaround. CAP's service factory accepts a module object with a `default` class export (`node_modules/@sap/cds/lib/srv/factory.js`, `impl[name] || impl.default`); verify this with the integration test.
- `package.json`: add an `exports` map with `"."` (types + default), `"./package.json"` and `"./cds-plugin.js"`, plus `repository`, `keywords` and `author` (Hendrik Neumann). Check that CAP still discovers the plugin.
- *Acceptance:* integration test still passes; new tests show that a `before('decide')` handler runs and can modify the request, that an app can replace the implementation for tests, and that log output contains no request data.

**Step 5 – Provider kinds (items 10, 17, 21, 23)**
- In the plugin's `package.json`, declare `cds.requires.systemone` with `"kind": "systemone"` and these kinds:
  - `systemone`: `impl: "cap-jev"`; generic Jev-compatible endpoint; `credentials.url` required; `model` optional and omitted from the request when not set; direct response format; structural validation only, no count limits.
  - `systemone-typesafe`: based on `systemone`; URL `https://api.typesafe.ai/v1/systemone`, model `jev-latest`; token required; current limits (choice ≤255 options, score 2–10 criteria).
  - `systemone-cloudflare`: based on `systemone`; model `clef`; builds the URL from `credentials.accountId`; Cloudflare envelope; token required; 1–64 questions per request.
  - `systemone-laya`: based on `systemone`; URL `http://127.0.0.1:8000/v1/systemone`; no model; token optional; at most 100 choice options per question.
- CAP links nested kinds (`node_modules/@sap/cds/lib/env/cds-env.js`, `_link_required_services`), so presets can use `"kind": "systemone"`; verify with a test.
- Keep non-secret settings (`provider`, `model`, `timeoutMs`) at service level and secrets (`url`, `token`, `accountId`, `destination`) in `credentials`, so cloud bindings only have to carry secrets. Remove `responseFormat` and the `model: null` special case.
- Selecting the TypeSafe preset is an explicit choice and therefore does not violate the fail-closed rule; the bare base kind without a URL must still fail.
- Update `examples/cap-app` to `"kind": "systemone-laya"` and adjust the integration test.
- README: rewrite "Endpoint configuration" around the kinds, including an example for a local or other Jev-compatible server on the base kind, a `[development]` profile example, the secret-injection table from item 20, the per-provider limits, the Cloudflare least-privilege token note (item 25) and `satisfies Questions` for questions held in variables (item 11).
- *Acceptance:* tests per kind (URL, model, auth header, limits, response unwrapping); a Cloudflare kind without `accountId` → `INVALID_CONFIG`; the base kind with a custom URL works without a model.

**Step 6 – BTP destinations (item 24)**
- Support `credentials.destination: "<name>"`. Resolve URL and headers with `@sap-cloud-sdk/connectivity`, declared under `peerDependencies` with `peerDependenciesMeta.<name>.optional: true`. Load it lazily; if it is missing, throw `INVALID_CONFIG` with an install hint.
- Include headers from the destination's `URL.headers.*` properties, so a `NoAuthentication` destination can carry the bearer key. The rule from step 2 also applies to destination URLs.
- Do not cache resolved destinations yourself; rely on the SDK's caching.
- *Acceptance:* tests with a stubbed resolver (no real BTP access): URL and auth header taken from the destination; missing SDK → `INVALID_CONFIG`; a destination with plain `http:` to a non-loopback host and a token → `INVALID_CONFIG`.

**Step 7 – Remaining tests (item 14)**
- Cover every path in item 14 that the earlier steps did not already cover.

### Definition of done

- Every item in scope is marked done in this file; out-of-scope items stay unmarked.
- README, `CHANGELOG.md` and `examples/cap-app` match the new behaviour.
- `npm run lint`, `npm run typecheck`, `npm test` and `npm pack --dry-run` pass on Node 22.
