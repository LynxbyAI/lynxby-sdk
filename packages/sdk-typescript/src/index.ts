import { operations, version } from './generated.ts'
import type { OperationId, Page, Run } from './generated.ts'

export { operations, version }
export type { OperationId, Page, Run }

/**
 * The two clients share one surface: the path, the method, the scope and the
 * streaming flag come from `generated.ts`, which `php artisan sdk:generate`
 * renders from the OpenAPI document. A route change that lands without a
 * regeneration is a failing test, not a 404 in someone's integration.
 */

/** A response object, as the API returns it. */
export interface Assistant {
  id: number
  name: string
  slug: string
  role: string | null
  model: string | null
  created_at: string | null
}

export interface AssistantMessage {
  id: number
  session_id: string
  role: 'user' | 'assistant'
  content: string
  citations: unknown[]
  reasoning: string | null
  review: unknown
  model: string | null
  provider: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  cost: number
  currency: string | null
  created_at: string | null
}

export interface Task {
  id: number
  name: string
  slug: string
  summary: string | null
  assistant_id: number | null
  requires_approval: boolean
  created_at: string | null
}

export interface TaskDetail extends Task {
  instructions: string | null
  fields: TaskField[]
}

export interface TaskField {
  key: string
  label: string
  type: string
  required: boolean
}

export interface PageOf<T> {
  data: T[]
  next_cursor: string | null
  has_more: boolean
}

/** The frames the chat screen reads, in the order the server writes them. */
export type StreamEvent =
  | { event: 'start'; data: { model: string; session_id?: string; task_id?: number } }
  | { event: 'thinking'; data: { delta: string } }
  | { event: 'tool'; data: { tool: string } }
  | { event: 'delta'; data: { delta: string } }
  | { event: 'done'; data: AssistantMessage | Run }
  | { event: 'error'; data: { code: string; message: string } }

export class LynxbyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
  }
}

/** Every failed call carries the machine code, the request id and the status. */
export class ApiError extends LynxbyError {
  readonly status: number
  readonly code: string
  readonly requestId: string
  readonly errors: Record<string, string[]> | undefined
  /** Seconds from the Retry-After header, when the call was rate limited. */
  readonly retryAfter: number | undefined

  constructor(
    status: number,
    body: { code?: string; message?: string; request_id?: string; errors?: Record<string, string[]> },
    retryAfter?: number,
  ) {
    super(body.message ?? `The API answered ${status}.`)
    this.status = status
    this.code = body.code ?? 'http_error'
    this.requestId = body.request_id ?? 'unassigned'
    this.errors = body.errors
    this.retryAfter = retryAfter
  }
}

export class AuthenticationError extends ApiError {}
export class PermissionError extends ApiError {}
export class NotFoundError extends ApiError {}
export class ValidationError extends ApiError {}
export class RateLimitError extends ApiError {}
export class ServerError extends ApiError {}

export interface ClientOptions {
  /** Defaults to LYNXBY_TOKEN. Never hard-code a token in a browser bundle. */
  token?: string
  /** The origin, such as https://your-host. Defaults to LYNXBY_BASE_URL. */
  baseUrl?: string
  /** Extra attempts after a 429 or a 5xx. Defaults to 2. */
  maxRetries?: number
  /** First backoff in milliseconds, doubled per attempt with jitter. Defaults to 250. */
  retryDelayMs?: number
  /** Swap the HTTP implementation, for a proxy or a test. */
  fetch?: typeof fetch
}

export interface CallOptions {
  /** Reuse one key across a retry, or pass your own. Generated when omitted. */
  idempotencyKey?: string
  /** Stops the call and closes a stream. */
  signal?: AbortSignal
  maxRetries?: number
}

export interface ListOptions {
  cursor?: string
  perPage?: number
}

export interface MessageInput {
  message: string
  session_id?: string
}

const RETRYABLE = (status: number): boolean => status === 429 || status >= 500

export class Lynxby {
  readonly agents: {
    list: (options?: ListOptions) => Promise<PageOf<Assistant>>
    get: (id: string | number) => Promise<Assistant>
    run: (id: string | number, message: string | MessageInput, options?: CallOptions) => Promise<AssistantMessage>
    stream: (id: string | number, message: string | MessageInput, options?: CallOptions) => AsyncGenerator<StreamEvent>
  }

  readonly tasks: {
    list: (options?: ListOptions) => Promise<PageOf<Task>>
    get: (id: string | number) => Promise<TaskDetail>
    run: (id: string | number, inputs: Record<string, string>, options?: CallOptions) => Promise<Run>
    stream: (id: string | number, inputs: Record<string, string>, options?: CallOptions) => AsyncGenerator<StreamEvent>
  }

  readonly runs: {
    list: (options?: ListOptions) => Promise<PageOf<Run>>
    get: (id: string | number) => Promise<Run>
    retry: (id: string | number, options?: CallOptions) => Promise<Run>
    approve: (id: string | number, note?: string, options?: CallOptions) => Promise<Run>
  }

  #token: string
  #baseUrl: string
  #maxRetries: number
  #retryDelayMs: number
  #fetch: typeof fetch

  constructor(options: ClientOptions = {}) {
    this.#token = options.token ?? environment('LYNXBY_TOKEN') ?? ''
    this.#baseUrl = (options.baseUrl ?? environment('LYNXBY_BASE_URL') ?? '').replace(/\/+$/, '')
    this.#maxRetries = options.maxRetries ?? 2
    this.#retryDelayMs = options.retryDelayMs ?? 250
    this.#fetch = options.fetch ?? fetch

    this.agents = {
      list: (options) => this.#json<PageOf<Assistant>>('api.v1.assistants.index', pageFields(options)),
      get: (id) => this.#json<Assistant>('api.v1.assistants.show', { id }),
      run: (id, message, options) => this.#json<AssistantMessage>('api.v1.assistants.messages', { id }, message_(message), options),
      stream: (id, message, options) => this.#stream('api.v1.assistants.messages.stream', { id }, message_(message), options),
    }

    this.tasks = {
      list: (options) => this.#json<PageOf<Task>>('api.v1.tasks.index', pageFields(options)),
      get: (id) => this.#json<TaskDetail>('api.v1.tasks.show', { id }),
      run: (id, inputs, options) => this.#json<Run>('api.v1.tasks.runs', { id }, { inputs }, options),
      stream: (id, inputs, options) => this.#stream('api.v1.tasks.runs.stream', { id }, { inputs }, options),
    }

    this.runs = {
      list: (options) => this.#json<PageOf<Run>>('api.v1.runs.index', pageFields(options)),
      get: (id) => this.#json<Run>('api.v1.runs.show', { id }),
      retry: (id, options) => this.#json<Run>('api.v1.runs.retry', { id }, undefined, options),
      approve: (id, note, options) =>
        this.#json<Run>('api.v1.approvals.runs.approve', { id }, note === undefined ? {} : { note }, options),
    }
  }

  async #json<T>(
    id: OperationId,
    fields: Record<string, string | number | undefined>,
    body?: unknown,
    options: CallOptions = {},
  ): Promise<T> {
    const response = await this.#send(id, fields, body, options)

    return (await response.json()) as T
  }

  async *#stream(
    id: OperationId,
    fields: Record<string, string | number>,
    body: unknown,
    options: CallOptions = {},
  ): AsyncGenerator<StreamEvent> {
    const response = await this.#send(id, fields, body, options)

    if (response.body === null) {
      throw new LynxbyError('The API answered without a stream body.')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      for (;;) {
        const { done, value } = await reader.read()

        if (done) {
          break
        }

        buffer += decoder.decode(value, { stream: true })

        for (let edge = buffer.indexOf('\n\n'); edge !== -1; edge = buffer.indexOf('\n\n')) {
          const frame = buffer.slice(0, edge)
          buffer = buffer.slice(edge + 2)
          const event = parseFrame(frame)

          if (event !== null) {
            yield event
          }
        }
      }
    } finally {
      // Leaving the loop early must close the socket, so the server stops
      // writing and stores nothing half-written.
      await reader.cancel().catch(() => undefined)
    }
  }

  async #send(
    id: OperationId,
    fields: Record<string, string | number | undefined>,
    body: unknown,
    options: CallOptions,
  ): Promise<Response> {
    const operation = operations[id]
    const url = this.#url(operation.path, fields)
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#token}`,
      Accept: operation.stream ? 'text/event-stream' : 'application/json',
    }

    if (this.#token === '') {
      throw new LynxbyError('No token: pass `token` or set LYNXBY_TOKEN.')
    }

    const payload = body === undefined ? undefined : JSON.stringify(body)

    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    if (operation.method === 'post') {
      // Every creating call carries a key, so a retry here is the same call
      // rather than a second message or run.
      headers['Idempotency-Key'] = options.idempotencyKey ?? crypto.randomUUID()
    }

    const attempts = options.maxRetries ?? this.#maxRetries

    for (let attempt = 0; ; attempt++) {
      const response = await this.#fetch(url, {
        method: operation.method.toUpperCase(),
        headers,
        body: payload,
        signal: options.signal,
      })

      if (response.ok) {
        return response
      }

      const error = await apiError(response)

      if (!RETRYABLE(response.status) || attempt >= attempts) {
        throw error
      }

      await sleep(backoff(this.#retryDelayMs, attempt, error.retryAfter), options.signal)
    }
  }

  #url(path: string, fields: Record<string, string | number | undefined>): string {
    if (this.#baseUrl === '') {
      throw new LynxbyError('No base URL: pass `baseUrl` or set LYNXBY_BASE_URL.')
    }

    const used = new Set<string>()
    const filled = path.replace(/\{(\w+)\}/g, (_, name: string) => {
      used.add(name)

      return encodeURIComponent(String(fields[name]))
    })
    const query = new URLSearchParams()

    for (const [key, value] of Object.entries(fields)) {
      if (!used.has(key) && value !== undefined) {
        query.set(key, String(value))
      }
    }

    const search = query.toString()

    return this.#baseUrl + filled + (search === '' ? '' : `?${search}`)
  }
}

const message_ = (message: string | MessageInput): MessageInput =>
  typeof message === 'string' ? { message } : message

const pageFields = (options?: ListOptions): Record<string, string | number | undefined> => ({
  cursor: options?.cursor,
  per_page: options?.perPage,
})

function environment(name: string): string | undefined {
  const holder = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process

  return holder?.env?.[name]
}

/** One SSE frame as the server writes it: an `event:` line and a `data:` line. */
function parseFrame(frame: string): StreamEvent | null {
  let name = 'message'
  const data: string[] = []

  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      name = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).trimStart())
    }
  }

  if (data.length === 0) {
    return null
  }

  try {
    return { event: name, data: JSON.parse(data.join('\n')) } as StreamEvent
  } catch {
    // A frame that is not JSON is a comment or a keep-alive, not a turn.
    return null
  }
}

async function apiError(response: Response): Promise<ApiError> {
  const retryAfter = Number.parseInt(response.headers.get('Retry-After') ?? '', 10)
  let body: Record<string, unknown> = {}

  try {
    body = (await response.json()) as Record<string, unknown>
  } catch {
    body = {}
  }

  const args = [
    response.status,
    {
      code: typeof body.code === 'string' ? body.code : undefined,
      message: typeof body.message === 'string' ? body.message : undefined,
      request_id: typeof body.request_id === 'string' ? body.request_id : undefined,
      errors: body.errors as Record<string, string[]> | undefined,
    },
    Number.isNaN(retryAfter) ? undefined : retryAfter,
  ] as const

  switch (response.status) {
    case 401:
      return new AuthenticationError(...args)
    case 403:
      return new PermissionError(...args)
    case 404:
      return new NotFoundError(...args)
    case 422:
      return new ValidationError(...args)
    case 429:
      return new RateLimitError(...args)
    default:
      return response.status >= 500 ? new ServerError(...args) : new ApiError(...args)
  }
}

/** The Retry-After header wins; otherwise exponential backoff with jitter. */
function backoff(baseMs: number, attempt: number, retryAfter?: number): number {
  if (retryAfter !== undefined) {
    return retryAfter * 1000
  }

  return Math.round(baseMs * 2 ** attempt * (0.5 + Math.random() / 2))
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException('The call was aborted.', 'AbortError'))

      return
    }

    const stop = (): void => {
      clearTimeout(timer)
      reject(new DOMException('The call was aborted.', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop)
      resolve()
    }, ms)

    signal?.addEventListener('abort', stop, { once: true })
  })
}
