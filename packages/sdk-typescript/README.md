# @lynxby/sdk

The Lynxby API client for TypeScript. Assistants, tasks and runs, with server-sent events, retries and typed errors. No dependencies: it uses `fetch`, and Node 22.18 or newer runs the TypeScript directly.

Full documentation, including where to get a token, is in the [Lynxby SDK repository](https://github.com/LynxbyAI/lynxby-sdk).

The generated surface in `src/generated.ts` comes from the API's OpenAPI document. Do not edit it by hand; it is regenerated in the platform repository with `php artisan sdk:generate` and copied here. The version here always equals the API version.

## Install

```bash
git clone https://github.com/LynxbyAI/lynxby-sdk.git
npm install ./lynxby-sdk/packages/sdk-typescript
```

Or copy `src/` into your project: it is two files and there is nothing to build. A registry release is not published yet.

## Use

```ts
import { Lynxby } from '@lynxby/sdk'

const lynx = new Lynxby() // LYNXBY_TOKEN and LYNXBY_BASE_URL
const run = await lynx.tasks.run(8, { text: 'A long letter.' })
console.log(run.answer)
```

```ts
const controller = new AbortController()

for await (const event of lynx.agents.stream(12, 'Summarise the contract.', { signal: controller.signal })) {
  if (event.event === 'delta') process.stdout.write(event.data.delta)
}
```

A `429` and every `5xx` are retried twice with jitter and then surfaced as `RateLimitError` or `ServerError`. `status`, `code`, `requestId` and `errors` are on every `ApiError`. Aborting the signal, or `break`ing out of the loop, closes the request.

## Test

```bash
npm test          # both stub-server suites
npm run typecheck
```

The full contract, the scope per call, pagination and idempotency are in the [repository docs](https://github.com/LynxbyAI/lynxby-sdk#readme).
