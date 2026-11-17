# lynxby

The Lynxby API client for Python. Assistants, tasks and runs, with server-sent events, retries and typed errors. It uses the standard library only: `urllib`, no requests, no httpx.

Full documentation, including where to get a token, is in the [Lynxby SDK repository](https://github.com/s-t-dev/lynxby-sdk).

The generated surface in `lynxby/generated.py` comes from the API's OpenAPI document. Do not edit it by hand; it is regenerated in the platform repository with `php artisan sdk:generate` and copied here. The version here always equals the API version.

## Install

```bash
pip install "git+https://github.com/s-t-dev/lynxby-sdk.git#subdirectory=packages/sdk-python"
```

Or copy the `lynxby/` directory into your project. A registry release is not published yet.

## Use

```python
from lynxby import Lynxby

lynx = Lynxby()  # LYNXBY_TOKEN and LYNXBY_BASE_URL
run = lynx.tasks.run(8, {"text": "A long letter."})
print(run["answer"])
```

```python
stream = lynx.agents.stream(12, "Summarise the contract.")

try:
    for event in stream:
        if event["event"] == "delta":
            print(event["data"]["delta"], end="", flush=True)
finally:
    stream.close()
```

A `429` and every `5xx` are retried twice with jitter and then surfaced as `RateLimitError` or `ServerError`. `status`, `code`, `request_id` and `errors` are on every `ApiError`. Closing the iterator, or `break`ing out of the loop, closes the request.

## Test

```bash
python3 -m unittest discover -s tests
```

The full contract, the scope per call, pagination and idempotency are in the [repository docs](https://github.com/s-t-dev/lynxby-sdk#readme).
