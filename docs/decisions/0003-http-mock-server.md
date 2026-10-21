# 3. HTTP mock server in the same package

**Date:** 2026-10-21
**Status:** Accepted (0.7.0)

## Context

[ADR 0002](0002-in-process-mock-provider.md) added an in-process mock and deferred an HTTP mock server (its option A) as "useful later for the HTTP path and non-CAP clients".

The in-process mock skips the HTTP transport, which has the most failure handling in `cap-jev`: retries for 429, 502, 503, 504 and 529, `Retry-After`, the call deadline, network failures, the Cloudflare envelope and destinations. These paths are tested only against small fake servers written inside the tests. A developer who wants to try `systemone-laya`, `systemone-cloudflare` or a client outside CAP needs a Laya server or a provider token.

The mock's answer engine and fixture rules import no CAP code. The code that combines them (settings checks, fixture loading, the order of `fail`, rules and engine) sits in `MockService`.

## Options considered

| Option | Outcome | Verdict |
| --- | --- | --- |
| **A.** No HTTP server; keep fake servers inside the tests | No new public surface, but the HTTP path stays untestable for applications, and every test writes its own server | Rejected |
| **B.** A separate package (`cap-jev-mock-server`) | Its own release, CI and version; it would have to import the engine from `cap-jev` anyway, or copy it | Rejected: two packages for one engine |
| **C.** A `bin` and a `cap-jev/mock-server` entry point in `cap-jev`, sharing a mock core with `MockService` | One engine, one release; `npx cap-jev-mock` works wherever `cap-jev` is installed; the core has no CAP imports, so the server runs without CAP | **Selected** |
| **D.** Run Laya in Docker as the local server | A real model, but a large download, no deterministic answers and no simulated failures | Kept as a later, documented option |

## Decision

1. **A shared mock core** (`src/providers/mock-core.ts`) holds the settings checks, fixture loading and the decision order. `MockService` and the server both use it, so the same request, settings and fixtures give the same answer in-process and over HTTP.
2. **`startMockServer()`** (`cap-jev/mock-server`) runs on `node:http` and imports no CAP code. **`cap-jev-mock`** is its command line, with defaults that match `systemone-laya` (`http://127.0.0.1:8000/v1/systemone`).
3. **Failures are simulated on the HTTP level**: a status code, a closed connection, no answer, an invalid body, or the Cloudflare error envelope. The client's own transport then produces the error code, so retries and timeouts are exercised.
4. **`--format cloudflare`** wraps answers in the Cloudflare envelope, so `systemone-cloudflare` can be tried locally with `credentials.url`.
5. **Loopback by default.** The server binds to `127.0.0.1`. Another host prints a warning. An optional token protects it.
6. The server and its command line are **experimental** until 1.0.0, like the subclass hooks.

## Consequences

- `npx cap-jev-mock` together with `CDS_REQUIRES_SYSTEMONE_KIND=systemone-laya` runs an application over HTTP without Laya, a token or network access.
- Tests of the HTTP path can use one documented server instead of writing their own.
- The package gains a `bin` and an entry point. Both are part of the public surface and must stay compatible after 1.0.0.
- The mock core's behaviour is a contract for two consumers; changes are tested through both.

## References

- [Plan](../plans/http-mock-server-and-release-automation.md), tasks R1–R3
- [ADR 0002: In-process mock provider](0002-in-process-mock-provider.md)
- Node.js: [`http.createServer`](https://nodejs.org/api/http.html#httpcreateserveroptions-requestlistener), [`util.parseArgs`](https://nodejs.org/api/util.html#utilparseargsconfig)
