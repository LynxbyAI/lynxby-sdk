# TypeScript client

`@lynxby/sdk` is the TypeScript client. Node 22.18 or newer runs it directly; there is no build step and no runtime dependency.

## Install

```bash
git clone https://github.com/s-t-dev/lynxby-sdk.git
npm install ./lynxby-sdk/packages/sdk-typescript
```

Or install a checkout by path. To avoid a package at all, copy `src/` into your project: it is two files.

## Construct

```ts
import { Lynxby } from '@lynxby/sdk'

const lynx = new Lynxby() // LYNXBY_TOKEN and LYNXBY_BASE_URL
```

```ts
const lynx = new Lynxby({
  token: 'lynx_…',
  baseUrl: 'https://lynxby.com',
  maxRetries: 2,       // extra attempts after a 429 or 5xx
  retryDelayMs: 250,   // first backoff, doubled with jitter
  fetch: customFetch,  // for a proxy or a test
})
```

A client without a token or base URL throws on the first call rather than sending an empty bearer.

## Calls

```ts
// Assistants
const assistants = await lynx.agents.list({ perPage: 25 })
const assistant = await lynx.agents.get(12)
const message = await lynx.agents.run(12, 'Summarise the contract.')
const continued = await lynx.agents.run(12, { message: 'And the annex?', session_id: message.session_id })

// Tasks
const tasks = await lynx.tasks.list()
const task = await lynx.tasks.get(8)
const run = await lynx.tasks.run(8, { text: 'A long letter.' })

// Runs
const runs = await lynx.runs.list({ perPage: 50 })
const one = await lynx.runs.get(run.id)
await lynx.runs.retry(run.id)
await lynx.runs.approve(run.id, 'Checked the amounts.')
```

Every call takes an optional third argument:

```ts
await lynx.tasks.run(8, { text: 'A long letter.' }, {
  idempotencyKey: 'order-1042',
  signal: controller.signal,
  maxRetries: 0,
})
```

## Stream

```ts
for await (const event of lynx.agents.stream(12, 'Summarise the contract.')) {
  switch (event.event) {
    case 'delta':
      process.stdout.write(event.data.delta)
      break
    case 'done':
      console.log('\n', event.data)
      break
    case 'error':
      console.error(event.data.code, event.data.message)
      break
  }
}
```

`tasks.stream(id, inputs)` has the same shape. Leaving the loop closes the request.

## Types

The package exports `Assistant`, `AssistantMessage`, `Task`, `TaskDetail`, `TaskField`, `Run`, `PageOf<T>`, `StreamEvent`, the error classes and the generated `operations` and `version`.

Responses are returned as the API sends them: snake_case fields, no mapping. `Run` and the other resource types come from the generated surface.

## Errors

```ts
import { RateLimitError, ValidationError } from '@lynxby/sdk'

try {
  await lynx.tasks.run(8, { text: 'A long letter.' })
} catch (error) {
  if (error instanceof RateLimitError) console.error(error.retryAfter)
  if (error instanceof ValidationError) console.error(error.errors)
}
```

All errors extend `ApiError` and carry `status`, `code`, `requestId`, `errors` and `retryAfter`.

## Test

```bash
cd packages/sdk-typescript
npm install
npm test
npx tsc --noEmit
```

The suite runs against a local stub server; it never calls a real tenant.
