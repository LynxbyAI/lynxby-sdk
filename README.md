# Lynxby SDK

TypeScript and Python clients for the Lynxby API, plus the setup guide for the MCP endpoint. Assistants, tasks and runs, with server-sent events, retries and typed errors. No runtime dependencies.

[Lynxby](https://lynxby.com) is a sovereign AI platform: your documents, your models, your audit ledger. The API runs the same assistants, tasks and triggers the interface shows, from your own backend.

| Package | Runtime | Directory |
| --- | --- | --- |
| `@lynxby/sdk` | Node 22.18 or newer | [`packages/sdk-typescript`](packages/sdk-typescript) |
| `lynxby` | Python 3.11 or newer | [`packages/sdk-python`](packages/sdk-python) |

Both clients are generated from the API's OpenAPI document. They cannot describe an endpoint the API does not serve.

## Get an API key

1. Sign in to your Lynxby organisation at <https://lynxby.com/login>. An account is created by an administrator; there is no anonymous sandbox token.
2. Open **Settings → API tokens**.
3. Create a token, give it a name, choose an expiry and tick the scopes you need.
4. Copy the value. It is shown once; afterwards only the first eight characters are visible.

A token belongs to one person and one organisation. The person's group permissions still apply, so a token with `task.execute` only runs a task its owner may run. For a machine identity, an administrator can mint a token for a service account.

Minimum scopes:

| You want to | Scope |
| --- | --- |
| List and read assistants | `assistant.read` |
| Send a message, plain or streamed | `assistant.execute` |
| List and read tasks | `task.read` |
| Run a task, plain or streamed | `task.execute` |
| List and read runs | `run.read` |
| Retry a run or approve a parked run | `run.execute` |
| Use the MCP endpoint | `knowledge.read` |
| Call a read-only connector action over MCP | `connector.read` |

Set the token and the base URL in the environment of the server that calls the API. Never put a token in browser code, a mobile bundle or a commit.

```bash
export LYNXBY_TOKEN=lynx_…
export LYNXBY_BASE_URL=https://lynxby.com
```

## Install

### TypeScript

```bash
git clone https://github.com/LynxbyAI/lynxby-sdk.git
npm install ./lynxby-sdk/packages/sdk-typescript
```

Or install from any checkout by path, and copy `src/` into your project if you prefer no package at all. Node 22.18 or newer runs the TypeScript directly; there is no build step.

### Python

```bash
pip install "git+https://github.com/LynxbyAI/lynxby-sdk.git#subdirectory=packages/sdk-python"
```

Or install from a checkout: `pip install ./lynxby-sdk/packages/sdk-python`. The client uses the standard library only.

Neither package is on npm or PyPI yet. Install from this repository.

## First call

```ts
import { Lynxby } from '@lynxby/sdk'

const lynx = new Lynxby() // reads LYNXBY_TOKEN and LYNXBY_BASE_URL

const tasks = await lynx.tasks.list({ perPage: 10 })
const run = await lynx.tasks.run(tasks.data[0].id, { text: 'A long letter.' })

console.log(run.answer)
```

```python
from lynxby import Lynxby

lynx = Lynxby()  # reads LYNXBY_TOKEN and LYNXBY_BASE_URL

tasks = lynx.tasks.list(per_page=10)
run = lynx.tasks.run(tasks["data"][0]["id"], {"text": "A long letter."})

print(run["answer"])
```

An assistant works the same way: `lynx.agents.run(12, 'Summarise the contract.')`. Pass `session_id` (TypeScript: `session_id` in the second argument) to continue a conversation.

## Streaming

`agents.stream` and `tasks.stream` hand you the server-sent events in the order the server writes them.

```ts
const controller = new AbortController()

for await (const event of lynx.agents.stream(12, 'Summarise the contract.', { signal: controller.signal })) {
  if (event.event === 'delta') process.stdout.write(event.data.delta)
  if (event.event === 'error') console.error(event.data.code, event.data.message)
  if (event.event === 'done') console.log('\n\n', event.data)
}
```

```python
stream = lynx.agents.stream(12, "Summarise the contract.")

try:
    for event in stream:
        if event["event"] == "delta":
            print(event["data"]["delta"], end="", flush=True)
        elif event["event"] == "error":
            print(f"\n{event['data']['code']}: {event['data']['message']}")
finally:
    stream.close()
```

Aborting the signal, or leaving the loop, closes the request. The server stops writing and stores no half-written answer.

Events: `start`, `thinking`, `tool`, `delta`, `done`, `error`. The `done` payload is the ordinary assistant-message or run response.

## Errors and retries

A `429` and every `5xx` are retried twice with exponential backoff and jitter. A `Retry-After` header wins over the backoff. The idempotency key is created once per call and reused by the retries, so a retried `POST` cannot become a second message or run.

| Class | Status | Meaning |
| --- | --- | --- |
| `AuthenticationError` | 401 | token missing, expired or revoked |
| `PermissionError` | 403 | the token or its owner may not do this |
| `NotFoundError` | 404 | no such record in this organisation |
| `ValidationError` | 422 | the body, query or header is wrong |
| `RateLimitError` | 429 | the ceiling was hit; `retryAfter` says how long |
| `ServerError` | 5xx | the server failed |

Every error carries `status`, `code`, `message`, `requestId` (Python: `request_id`) and, on validation, `errors`. Pass `maxRetries` (TypeScript) or `max_retries` (Python) to change the retry count.

## Pagination and idempotency

`agents.list`, `tasks.list` and `runs.list` take a cursor and a page size and answer `data`, `next_cursor` and `has_more`. Send the cursor back unchanged; `null` marks the end.

```ts
const page = await lynx.runs.list({ perPage: 50 })
const next = page.next_cursor === null ? null : await lynx.runs.list({ cursor: page.next_cursor, perPage: 50 })
```

Every creating `POST` carries an `Idempotency-Key`, generated when you do not pass one. Pass `idempotencyKey` (Python: `idempotency_key`) when the key must survive a process restart.

## MCP

You do not need this SDK to connect an agent harness. Lynxby also exposes one MCP endpoint:

```
https://lynxby.com/mcp
```

Point Claude Code, Claude Desktop, Copilot, OpenCode, Codex or another streamable-HTTP client at it with a bearer token. The default exposure profile offers `ask_lynxby`; enable more tools on **Settings → MCP exposure**.

The full setup, including client configuration and the tool list, is in [`docs/mcp.md`](docs/mcp.md).

## Documentation

- [Authentication and scopes](docs/authentication.md)
- [TypeScript client](docs/typescript.md)
- [Python client](docs/python.md)
- [MCP setup](docs/mcp.md)
- [API reference](https://lynxby.com/api/docs)
- [OpenAPI 3.1 document](https://lynxby.com/api/v1/openapi.json)
- [Lynxby API page](https://lynxby.com/api)

## Development

```bash
cd packages/sdk-typescript
npm install
npm test
npx tsc --noEmit

cd ../sdk-python
python3 -m unittest discover -s tests
```

The generated files (`src/generated.ts`, `lynxby/generated.py`) come from the platform's OpenAPI document. Do not edit them by hand. They are regenerated in the platform repository with `php artisan sdk:generate` and copied here.

## License

MIT. See [LICENSE](LICENSE).
