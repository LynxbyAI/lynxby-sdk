import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { Lynxby, NotFoundError, RateLimitError, ValidationError } from '../src/index.ts'

/**
 * The client is exercised against a stub that speaks the same frames and the
 * same error envelope as the API, so a retry, a stream or an abort is a local
 * test rather than a call to a real tenant.
 */

interface Seen {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: string
  closed: boolean
}

type Handler = (request: IncomingMessage, response: ServerResponse, seen: Seen) => void

async function stub(handler: Handler): Promise<{ baseUrl: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = []

  const server = createServer((request, response) => {
    let body = ''
    const record: Seen = {
      method: request.method ?? '',
      url: request.url ?? '',
      headers: request.headers,
      body,
      closed: false,
    }

    seen.push(record)
    request.on('data', (chunk) => {
      body += chunk
      record.body = body
    })
    request.on('close', () => {
      record.closed = true
    })
    response.on('error', () => undefined)

    request.on('end', () => handler(request, response, record))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

const frame = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`

const message = {
  id: 41,
  session_id: 'session-1',
  role: 'assistant',
  content: 'Hello',
  citations: [],
  reasoning: null,
  review: null,
  model: 'test-model',
  provider: 'test',
  prompt_tokens: 3,
  completion_tokens: 1,
  cost: 0.001,
  currency: 'EUR',
  created_at: '2026-11-14T10:00:00+00:00',
}

test('a chat stream yields the frames in order and sends the token and a key', async () => {
  const server = await stub((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write(frame('start', { model: 'test-model', session_id: 'session-1' }))
    response.write(frame('delta', { delta: 'Hel' }))
    response.write(frame('delta', { delta: 'lo' }))
    response.write(frame('done', message))
    response.end()
  })

  try {
    const client = new Lynxby({ token: 'lynx_test', baseUrl: server.baseUrl })
    const events = []

    for await (const event of client.agents.stream(12, 'What is the notice period?')) {
      events.push(event)
    }

    assert.deepEqual(
      events.map((event) => event.event),
      ['start', 'delta', 'delta', 'done'],
    )
    assert.equal((events[3].data as typeof message).content, 'Hello')
    assert.equal(server.seen[0].headers.authorization, 'Bearer lynx_test')
    assert.equal(server.seen[0].headers.accept, 'text/event-stream')
    assert.match(String(server.seen[0].headers['idempotency-key']), /^[0-9a-f-]{36}$/)
    assert.equal(server.seen[0].method, 'POST')
    assert.equal(server.seen[0].url, '/api/v1/assistants/12/messages/stream')
    assert.deepEqual(JSON.parse(server.seen[0].body), { message: 'What is the notice period?' })
  } finally {
    await server.close()
  }
})

test('a task run streams its start and its done', async () => {
  const run = { id: 9, task_id: 8, status: 'completed', answer: 'done', model: 'test-model', cost: 0.001, currency: 'EUR', created_at: null }

  const server = await stub((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write(frame('start', { model: 'test-model', task_id: 8 }))
    response.write(frame('done', run))
    response.end()
  })

  try {
    const client = new Lynxby({ token: 'lynx_test', baseUrl: server.baseUrl })
    const events = []

    for await (const event of client.tasks.stream(8, { text: 'A long letter.' })) {
      events.push(event)
    }

    assert.equal(events.at(-1)?.event, 'done')
    assert.equal((events.at(-1)?.data as { status: string }).status, 'completed')
    assert.deepEqual(JSON.parse(server.seen[0].body), { inputs: { text: 'A long letter.' } })
  } finally {
    await server.close()
  }
})

test('aborting a stream closes the request and never reaches done', async () => {
  const server = await stub((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write(frame('start', { model: 'test-model', session_id: 'session-1' }))
    response.write(frame('delta', { delta: 'Hel' }))
    // The rest arrives late: an abort in between means the client never sees it.
    setTimeout(() => {
      if (response.writableEnded) {
        return
      }

      response.write(frame('delta', { delta: 'lo' }))
      response.write(frame('done', message))
      response.end()
    }, 50)
  })

  try {
    const client = new Lynxby({ token: 'lynx_test', baseUrl: server.baseUrl })
    const controller = new AbortController()
    const events: string[] = []

    await assert.rejects(async () => {
      for await (const event of client.agents.stream(12, 'Hello', { signal: controller.signal })) {
        events.push(event.event)

        if (event.event === 'delta') {
          controller.abort()
        }
      }
    }, (error: Error) => error.name === 'AbortError')

    assert.deepEqual(events, ['start', 'delta'])

    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(server.seen[0].closed, true, 'the server saw the client go away')
  } finally {
    await server.close()
  }
})

test('breaking out of a stream closes the request too', async () => {
  const server = await stub((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write(frame('start', { model: 'test-model' }))
    response.write(frame('delta', { delta: 'Hel' }))
    setTimeout(() => response.end(), 50)
  })

  try {
    const client = new Lynxby({ token: 'lynx_test', baseUrl: server.baseUrl })

    for await (const event of client.agents.stream(12, 'Hello')) {
      assert.equal(event.event, 'start')
      break
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(server.seen[0].closed, true)
  } finally {
    await server.close()
  }
})

test('a rate limit is retried and then surfaces a typed error', async () => {
  const server = await stub((_request, response) => {
    response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' })
    response.end(JSON.stringify({ code: 'rate_limited', message: 'Too many requests.', request_id: 'req-1' }))
  })

  try {
    const client = new Lynxby({ token: 'lynx_test', baseUrl: server.baseUrl, retryDelayMs: 1 })

    await assert.rejects(
      client.agents.list(),
      (error: unknown) => {
        assert.ok(error instanceof RateLimitError)
        assert.equal(error.status, 429)
        assert.equal(error.code, 'rate_limited')
        assert.equal(error.requestId, 'req-1')
        assert.equal(error.retryAfter, 0)

        return true
      },
    )

    assert.equal(server.seen.length, 3, 'the original call and two retries')
  } finally {
    await server.close()
  }
})

test('a server error is retried and the next answer is used', async () => {
  let calls = 0

  const server = await stub((_request, response) => {
    calls++

    if (calls === 1) {
      response.writeHead(503, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ code: 'server_error', message: 'Try again.', request_id: 'req-2' }))

      return
    }

    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 3, name: 'Contract reviewer', slug: 'contract-reviewer' }], next_cursor: null, has_more: false }))
  })

  try {
    const client = new Lynxby({ token: 'lynx_test', baseUrl: server.baseUrl, retryDelayMs: 1 })
    const assistants = await client.agents.list()

    assert.equal(assistants.data.length, 1)
    assert.equal(calls, 2)
  } finally {
    await server.close()
  }
})

test('a validation failure and a missing record keep their own error type', async () => {
  const server = await stub((request, response) => {
    response.writeHead(request.url?.includes('/runs/') === true ? 404 : 422, { 'Content-Type': 'application/json' })
    response.end(
      JSON.stringify({
        code: request.url?.includes('/runs/') === true ? 'not_found' : 'validation_failed',
        message: 'The body is not valid.',
        request_id: 'req-3',
        errors: { inputs: ['The text field is required.'] },
      }),
    )
  })

  try {
    const client = new Lynxby({ token: 'lynx_test', baseUrl: server.baseUrl })

    await assert.rejects(client.tasks.run(8, {}), (error: unknown) => {
      assert.ok(error instanceof ValidationError)
      assert.deepEqual(error.errors, { inputs: ['The text field is required.'] })

      return true
    })

    await assert.rejects(client.runs.get(999), (error: unknown) => error instanceof NotFoundError)
    assert.equal(server.seen.length, 2, 'a 422 and a 404 are not retried')
  } finally {
    await server.close()
  }
})

test('lists carry the cursor and the page size', async () => {
  const server = await stub((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data: [], next_cursor: 'next', has_more: true }))
  })

  try {
    const client = new Lynxby({ token: 'lynx_test', baseUrl: server.baseUrl })
    const page = await client.runs.list({ cursor: 'abc', perPage: 2 })

    assert.equal(page.next_cursor, 'next')
    assert.equal(server.seen[0].url, '/api/v1/runs?cursor=abc&per_page=2')
  } finally {
    await server.close()
  }
})

test('approving a parked run posts the note to the approvals route', async () => {
  const server = await stub((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ id: 7, status: 'running' }))
  })

  try {
    const client = new Lynxby({ token: 'lynx_test', baseUrl: server.baseUrl })
    const run = await client.runs.approve(7, 'Send it.')

    assert.equal(run.status, 'running')
    assert.equal(server.seen[0].url, '/api/v1/approvals/runs/7/approve')
    assert.deepEqual(JSON.parse(server.seen[0].body), { note: 'Send it.' })
    assert.ok(server.seen[0].headers['idempotency-key'])
  } finally {
    await server.close()
  }
})

test('the token and the base URL come from the environment by default', async () => {
  const server = await stub((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data: [], next_cursor: null, has_more: false }))
  })

  const saved = { token: process.env.LYNXBY_TOKEN, baseUrl: process.env.LYNXBY_BASE_URL }

  try {
    process.env.LYNXBY_TOKEN = 'lynx_from_env'
    process.env.LYNXBY_BASE_URL = server.baseUrl

    await new Lynxby().tasks.list()

    assert.equal(server.seen[0].headers.authorization, 'Bearer lynx_from_env')
  } finally {
    process.env.LYNXBY_TOKEN = saved.token
    process.env.LYNXBY_BASE_URL = saved.baseUrl
    await server.close()
  }
})

test('a client without a token says so instead of sending an empty bearer', async () => {
  const client = new Lynxby({ token: '', baseUrl: 'http://127.0.0.1:1' })

  await assert.rejects(client.agents.get(1), /No token/)
})
