# Authentication and scopes

Every call needs a machine token. There is no anonymous access and no separate API account.

## Where to get one

1. Sign in at <https://lynxby.com/login>. An administrator creates accounts; there is no self-service signup.
2. Open **Settings → API tokens**.
3. Create a token. Give it a name that says what uses it, choose an expiry (30 days, 90 days, a year or none) and tick only the scopes the integration needs.
4. Copy the value. It is shown once. Only the first eight characters are kept for the list.

The screen offers only scopes your own group permissions cover, and the server checks the same list again. A token can never do more than its owner.

An administrator can mint an organisation-wide token through `POST /api/v1/tokens`, including one owned by a service account. That route needs `organisation.update`.

## What a token looks like

`lynx_` followed by forty random characters. The API stores a SHA-256 hash, never the value, so a database dump contains no working credential.

Send it as a bearer header:

```http
Authorization: Bearer lynx_…
```

A missing, unknown, expired or revoked token answers `401`. A token without the scope a route needs answers `403` with `insufficient_scope` and the missing scope in the message.

## Scopes

| Scope | Allows | The owner also needs |
| --- | --- | --- |
| `assistant.read` | list and read assistants | `assistant.read` |
| `assistant.execute` | send a message, plain or streamed | `assistant.execute` |
| `task.read` | list and read tasks | `task.read` |
| `task.execute` | run a task, plain or streamed | `task.execute` |
| `run.read` | list and read runs and steps | `run.read` |
| `run.execute` | retry a run, approve a parked run | `run.execute` |
| `knowledge.read` | read collections, documents and search results; MCP knowledge tools | `document.read` |
| `connector.read` | read connector state; read-only connector actions over MCP | `connector.read` |
| `gateway.invoke` | call the model gateway | `assistant.execute` |
| `trigger.read` / `trigger.execute` | read or start triggers | matching permission |
| `budget.read` / `usage.read` | read budgets or spend | `billing.view` / `report.view` |
| `skill.read` | fetch `/skill.md` | `tool.read` |

The SDK's published calls use the first six. The other scopes are for the wider API and for harnesses.

## Expiry and revocation

`expires_at` is optional. When it passes, the token stops working. Revoking is permanent; the row stays for the audit trail and the next call answers `401`. Both are checked against the database on every request, so revocation takes effect immediately.

`last_used_at` and `last_used_ip` are written on first use and then at most once a minute.

## Handling

- Keep the token in the server environment, a secret manager or the platform's own credential store. Never in client-side code.
- Use one token per integration, so revoking one does not break another.
- Give it the smallest scope set that works.
- Rotate it on a schedule and after anyone who had access leaves.
- If a token leaks, revoke it first. Rotation and revocation are on the same screen.

## OAuth

An MCP client that supports OAuth 2.1 can skip the pasted token. It registers at `POST /oauth/register` or uses its Client ID Metadata Document URL, then follows the discovery document at `/.well-known/oauth-protected-resource`. The access token is opaque, lives thirty minutes and is bound to the `/mcp` resource.
