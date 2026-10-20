# cap-jev

`cap-jev` adds an internal System One decision service to SAP CAP Node.js 10 applications on Node.js 22 or newer. It evaluates `choice`, `score`, and `noul` questions against one text or JSON state. It works with any Jev-compatible System One HTTP endpoint that accepts the same request and response schema. The package creates no OData endpoint and produces no text.

## Install and use

The package is not yet published to npm. Until publication, build a tarball from this repository and install it in your CAP application:

```sh
npm install
npm pack
# In your CAP application:
npm install /path/to/cap-jev/cap-jev-0.1.0.tgz
```

After npm publication, use `npm install cap-jev`.

CAP loads the package's `cds-plugin.js` and adds the `systemone` required service. Configure credentials in your application's `package.json`, then connect from a service handler:

```ts
import cds from '@sap/cds';
import type { SystemOneService } from 'cap-jev';

const systemOne = (await cds.connect.to('systemone')) as SystemOneService;
const result = await systemOne.decide({
  state: { message: 'I was billed twice. Please refund me.' },
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      criteria: { billing: 'Payments and refunds', technical: 'Errors and integrations' },
    },
    urgency: { type: 'score', instructions: 'How urgent?', criteria: ['Low', 'Medium', 'High'] },
    refund: { type: 'noul', instructions: 'Does the customer request a refund?' },
  },
});
console.log(result.answers.department.choice, result.answers.refund.noul);
```

The [example CAP application](examples/cap-app) shows a TypeScript action handler. Its CDS action belongs to the application; the plugin registers no annotations or handlers for application actions.

## Endpoint configuration

Set `cds.requires.systemone.credentials` in your application. `url` is the **full POST endpoint** and is required; the plugin has no default endpoint or model. Set `model` if your endpoint requires one. `token` is optional; store it in a runtime binding or environment-specific configuration, not in source control. A token is sent only to HTTPS or a loopback HTTP endpoint (`127.0.0.1`, `localhost`, or `::1`). `timeoutMs` defaults to 10,000. The configurations below are examples, not an exhaustive list of supported models or providers.

Because the service name is a single lowercase word, the token can come from an environment variable: `CDS_REQUIRES_SYSTEMONE_CREDENTIALS_TOKEN=<token>`. On Cloud Foundry, a user-provided service named `systemone` is bound automatically.

TypeSafe Jev:

```json
{
  "cds": {
    "requires": {
      "systemone": {
        "credentials": {
          "url": "https://api.typesafe.ai/v1/systemone",
          "model": "jev-latest",
          "token": "<from secret binding>"
        }
      }
    }
  }
}
```

Cloudflare Clef:

```json
{
  "cds": {
    "requires": {
      "systemone": {
        "credentials": {
          "url": "https://api.cloudflare.com/client/v4/accounts/<account-id>/ai/run/@cf/cloudflare/clef",
          "model": "clef",
          "token": "<from secret binding>",
          "responseFormat": "cloudflare"
        }
      }
    }
  }
}
```

Local Laya (no authentication and automatic model selection):

```json
{
  "cds": {
    "requires": { "systemone": { "credentials": { "url": "http://127.0.0.1:8000/v1/systemone", "model": null } } }
  }
}
```

Set `model` to `null` to omit it from the request. A configured token becomes a Bearer header. The `cloudflare` response format unwraps the REST API's `result` field. Responses must include a model identifier, one correctly typed answer per question, and usage counts. Invalid input, malformed responses, HTTP errors, and timeouts throw `SystemOneError` with `code` and, for HTTP errors, `status`. HTTP 429 and 529 are retried at most twice with backoff. Request state and credentials are never logged by this package.

## Development

```sh
npm install
npm run typecheck
npm run build
npm test
npm pack --dry-run
```

The test suite uses local HTTP servers and needs no external API key. To run one focused test: `node --test tests/transport.test.cjs`. `npm run build` emits CommonJS JavaScript and declarations in `dist/`.

## Protocol references

- [TypeSafe System One API](https://docs.typesafe.ai/api)
- [Cloudflare Clef](https://developers.cloudflare.com/workers-ai/models/clef/)
- [Laya HTTP server](https://github.com/WhoIsMrSentry/laya-system-one#self-hosting-http-server-jev-compatible)
- [CAP plugin packages](https://cap.cloud.sap/docs/node.js/cds-plugins)
