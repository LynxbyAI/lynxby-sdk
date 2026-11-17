# Python client

`lynxby` is the Python client. It uses the standard library only: `urllib`, no requests, no httpx. Python 3.11 or newer.

## Install

```bash
pip install "git+https://github.com/LynxbyAI/lynxby-sdk.git#subdirectory=packages/sdk-python"
```

Or from a checkout: `pip install ./lynxby-sdk/packages/sdk-python`. You can also copy the `lynxby/` directory into your project.

## Construct

```python
from lynxby import Lynxby

lynx = Lynxby()  # LYNXBY_TOKEN and LYNXBY_BASE_URL
```

```python
lynx = Lynxby(
    token="lynx_…",
    base_url="https://lynxby.com",
    max_retries=2,
    retry_delay=0.25,
    timeout=60.0,
)
```

A client without a token or base URL raises on the first call rather than sending an empty bearer.

## Calls

```python
# Assistants
assistants = lynx.agents.list(per_page=25)
assistant = lynx.agents.get(12)
message = lynx.agents.run(12, "Summarise the contract.")
continued = lynx.agents.run(12, "And the annex?", session_id=message["session_id"])

# Tasks
tasks = lynx.tasks.list()
task = lynx.tasks.get(8)
run = lynx.tasks.run(8, {"text": "A long letter."})

# Runs
runs = lynx.runs.list(per_page=50)
one = lynx.runs.get(run["id"])
lynx.runs.retry(run["id"])
lynx.runs.approve(run["id"], "Checked the amounts.")
```

Responses are dictionaries, exactly as the API sends them: snake_case keys, no mapping. Each call accepts `idempotency_key` and `retries`.

## Stream

```python
stream = lynx.agents.stream(12, "Summarise the contract.")

try:
    for event in stream:
        if event["event"] == "delta":
            print(event["data"]["delta"], end="", flush=True)
        elif event["event"] == "done":
            print("\n", event["data"])
        elif event["event"] == "error":
            print(f"\n{event['data']['code']}: {event['data']['message']}")
finally:
    stream.close()
```

`tasks.stream(task_id, inputs)` has the same shape. Closing the iterator, or breaking out of the loop, closes the request.

## Errors

```python
from lynxby import RateLimitError, ValidationError

try:
    lynx.tasks.run(8, {"text": "A long letter."})
except RateLimitError as error:
    print(error.retry_after)
except ValidationError as error:
    print(error.errors)
```

All errors extend `ApiError` and carry `status`, `code`, `message`, `request_id`, `errors` and `retry_after`.

## Test

```bash
cd packages/sdk-python
python3 -m unittest discover -s tests
```

The suite runs against a local stub server; it never calls a real tenant.
