# MCP setup

Lynxby speaks the Model Context Protocol at one endpoint:

```
https://lynxby.com/mcp
```

It is JSON-RPC 2.0 over streamable HTTP, one message per request. Point an MCP-capable client at it with a Lynxby token and it can ask this organisation's knowledge, run tasks and assistants, list and decide parked runs, propose a write and run read-only connector actions.

The endpoint carries tool calls, not model traffic. A harness that keeps its own provider key never sends its prompts through Lynxby. Use the [model gateway](https://lynxby.com/api/docs) if you want those accounted for too.

## Before you connect

1. Sign in at <https://lynxby.com/login>.
2. Open **Settings → API tokens** and create a token with `knowledge.read`. Add `connector.read` for read-only connector actions, `task.execute` to run tasks, `assistant.execute` to message assistants, `run.read`/`run.execute` to list and decide parked runs, and `knowledge.write` to propose a document or a change to one.
3. Open **Settings → MCP exposure** and enable the tools the token should see. The default profile offers the three knowledge tools, the four that run work and the two that propose a write. A tool that is not in the profile is absent from `tools/list`; it is not refused at call time.
4. Keep the token outside the client configuration file where the client supports an environment variable.

The token's owner must also hold the matching permission: `document.read` for the knowledge tools, `task.execute` for tasks, `assistant.execute` for assistants, `run.view` to list runs and `task.execute` to decide them, and `connector.read` for connector actions.

## Test it with curl

```bash
curl -s https://lynxby.com/mcp \
  -H "Authorization: Bearer $LYNXBY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

```bash
curl -s https://lynxby.com/mcp \
  -H "Authorization: Bearer $LYNXBY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

```bash
curl -s https://lynxby.com/mcp \
  -H "Authorization: Bearer $LYNXBY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ask_lynxby","arguments":{"question":"What is the notice period in the supplier contract?"}}}'
```

`initialize` answers with the protocol version, the server name, and the caller's own capability skill as `instructions`. The skill describes the rule sets, tools, collections and connectors that person can reach. It is an affordance, not an authorisation check; every call is checked again.

Supported protocol revisions: `2025-06-18`, `2025-11-25`, `2026-07-28`. A client that asks for one of them gets it back; anything else is offered the newest.

## Clients

### Claude Code

```bash
claude mcp add --transport http lynxby https://lynxby.com/mcp \
  --header "Authorization: Bearer $LYNXBY_TOKEN"
```

Add `--scope user` to make it available in every project. Claude Code also accepts model traffic at `https://lynxby.com/api` with `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and a token that carries `gateway.invoke`.

### Claude.ai and Claude Desktop

Open **Settings → Connectors → Add custom connector** and enter `https://lynxby.com/mcp`. The sign-in is OAuth, so there is no token to paste. Claude connects from its own cloud, so the address must be publicly reachable.

### Copilot in VS Code

Save this as `~/.copilot/mcp-config.json`, or as `.mcp.json` at the workspace root to share it with the repository:

```json
{
  "mcpServers": {
    "lynxby": {
      "type": "http",
      "url": "https://lynxby.com/mcp",
      "headers": { "Authorization": "Bearer ${LYNXBY_TOKEN}" },
      "tools": ["*"]
    }
  }
}
```

Export `LYNXBY_TOKEN` in the environment that runs Copilot. The file does not read a secret store.

### Copilot CLI

```bash
copilot mcp add --transport http \
  --header "Authorization: Bearer $LYNXBY_TOKEN" \
  lynxby https://lynxby.com/mcp
```

### OpenCode

In `opencode.json`, in the project or the global config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "lynxby": {
        "type": "remote",
        "url": "https://lynxby.com/mcp",
        "oauth": false,
        "headers": { "Authorization": "Bearer {env:LYNXBY_TOKEN}" }
      }
    }
  }
}
```

OpenCode also accepts the gateway as an OpenAI-compatible provider. See the [API reference](https://lynxby.com/api/docs).

### Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.lynxby]
url = "https://lynxby.com/mcp"
bearer_token_env_var = "LYNXBY_TOKEN"
```

### Anything else

Use the endpoint with a bearer header. Send one JSON-RPC object per POST and `Content-Type: application/json`. `GET` and `DELETE` answer `405`; nothing is served as a stream.

If the client speaks OAuth 2.1, point it at `https://lynxby.com/.well-known/oauth-protected-resource`. The access token is opaque, lives thirty minutes and is bound to `/mcp`.

## Tools

| Tool | What it does | Scope |
| --- | --- | --- |
| `ask_lynxby` | Answer a question from indexed documents, with citations | `knowledge.read` |
| `search_knowledge` | Return the matching passages instead of an answer | `knowledge.read` |
| `get_document` | Read one document a page at a time, redacted | `knowledge.read` |
| `run_task` | Run one task with its form inputs and return the run, its status and its answer | `task.execute` |
| `ask_assistant` | Send one message to an assistant and return its reply | `assistant.execute` |
| `list_parked_runs` | List the runs waiting for a person to decide them | `run.read` |
| `decide_run` | Approve or reject a parked run, with an optional note | `run.execute` |
| `add_document` | Propose a new text document in a collection | `knowledge.write` |
| `propose_context` | Propose a complete new text for a text document | `knowledge.write` |
| `<connector>_<tool>` | Run a read-only connector action | `connector.read` |

`ask_lynxby(question, project_id?)` returns `structuredContent.citations` with the segment, document, quote, score, URL and answering model. `structuredContent.actions` names the read-only connector actions the answer used.

`search_knowledge(query, limit)` returns up to ten passages. `get_document(document_id, offset, limit)` returns at most 8,000 characters per page and a `next_offset`.

`run_task(task_id, inputs)` runs one task and returns the run, its status and its answer. `inputs` is the task's form keyed by field key; a field the form marks required has to be present.

`ask_assistant(assistant_id, message, session_id?)` sends one message and returns the reply. Pass the `session_id` from the previous reply back to continue the same conversation.

`list_parked_runs()` lists the runs waiting for a person, with the task, the reason and how long each has waited.

`decide_run(run_id, decision, note?)` approves or rejects a parked run; `decision` is `approve` or `reject` and the note is optional. A harness cannot decide its own person's run: `decide_run` refuses it and `list_parked_runs` leaves those runs out, because approving or rejecting your own run belongs on the approval screen, to a person.

`add_document(collection_id, name, content)` and `propose_context(document_id, text)` propose a new document or a new text for one. Nothing is stored or indexed; the proposal waits on the approval screen.

Write, send and delete connector actions are not exposed, and neither write tool writes directly: a proposal is the only way a harness's text becomes a document. A tool that fails returns a normal result with `isError: true`.

## Limits and errors

- One JSON-RPC message per request. Batches are refused.
- Body cap 1 MB; deeper than 64 levels of JSON nesting is a parse error.
- 60 requests per minute per token and 600 per minute per organisation by default. Both answer `429` with `Retry-After`.
- The endpoint is stateless. `Mcp-Session-Id` is issued at `initialize` and echoed later, but nothing depends on it.
- A request is written to the audit ledger: the tool, the status, the duration, the client name and version, and a hash of the body. Never the body or the answer.
- Connector output is fenced as untrusted data, not instructions.

| Code | When |
| --- | --- |
| `-32700` | body is not JSON |
| `-32600` | not a JSON-RPC request, or a batch |
| `-32601` | unknown method |
| `-32602` | missing tool name or arguments, or a tool outside the profile |
| `-32603` | server failure |

## Skill file

The capability skill is also served as Markdown at `GET /skill.md`, with an `ETag`, `Cache-Control: private, no-store` and `X-Lynxby-Skill-Version`. It needs the `skill.read` scope. A matching `If-None-Match` answers `304`.
