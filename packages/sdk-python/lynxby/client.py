"""The API client, on the standard library alone.

The paths, the methods, the scopes and the streaming flags come from
`generated.py`, which `php artisan sdk:generate` renders from the OpenAPI
document. A route this client calls cannot describe an endpoint the API no
longer has: the regenerated file changes and the test suite fails.
"""

from __future__ import annotations

import json
import os
import random
import re
import time
import uuid
from typing import Any, Iterator
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .errors import (
    ApiError,
    AuthenticationError,
    LynxbyError,
    NotFoundError,
    PermissionError,
    RateLimitError,
    ServerError,
    ValidationError,
)
from .generated import OPERATIONS

RETRYABLE = (429,)


StreamEvent = dict[str, Any]
"""One server-sent event: `event` is the name, `data` the payload."""


class Lynxby:
    """The client. `token` and `base_url` fall back to the environment."""

    def __init__(
        self,
        token: str | None = None,
        base_url: str | None = None,
        max_retries: int = 2,
        retry_delay: float = 0.25,
        timeout: float = 60.0,
    ) -> None:
        self.token = token if token is not None else os.environ.get("LYNXBY_TOKEN", "")
        self.base_url = (base_url if base_url is not None else os.environ.get("LYNXBY_BASE_URL", "")).rstrip("/")
        self.max_retries = max_retries
        self.retry_delay = retry_delay
        self.timeout = timeout
        self.agents = _Agents(self)
        self.tasks = _Tasks(self)
        self.runs = _Runs(self)

    # -- the wire ---------------------------------------------------------

    def _url(self, operation: dict[str, Any], path: dict[str, Any], query: dict[str, Any]) -> str:
        if not self.base_url:
            raise LynxbyError("No base URL: pass base_url or set LYNXBY_BASE_URL.")

        path_str = re.sub(r"{(\w+)}", lambda match: str(path[match.group(1)]), operation["path"])
        search = urlencode({key: value for key, value in query.items() if value is not None})

        return self.base_url + path_str + (f"?{search}" if search else "")

    def _open(
        self,
        operation_id: str,
        path: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
        body: Any = None,
        idempotency_key: str | None = None,
        retries: int | None = None,
    ) -> Any:
        if not self.token:
            raise LynxbyError("No token: pass token or set LYNXBY_TOKEN.")

        operation = OPERATIONS[operation_id]
        url = self._url(operation, path or {}, query or {})
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "text/event-stream" if operation["stream"] else "application/json",
        }
        data = None

        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"

        if operation["method"] == "post":
            # Every creating call carries a key, so a retry is the same call
            # rather than a second message or run.
            headers["Idempotency-Key"] = idempotency_key or str(uuid.uuid4())

        attempts = self.max_retries if retries is None else retries

        for attempt in range(attempts + 1):
            request = Request(url, data=data, headers=headers, method=operation["method"].upper())

            try:
                return urlopen(request, timeout=self.timeout)
            except HTTPError as error:
                failure = _error_from(error)
                error.close()

                if not _retryable(error.code) or attempt >= attempts:
                    raise failure from None

                time.sleep(_backoff(self.retry_delay, attempt, failure.retry_after))
            except URLError as error:
                raise LynxbyError(str(error.reason)) from None

        raise LynxbyError("The retry loop ended without an answer.")

    def _json(self, operation_id: str, **kwargs: Any) -> Any:
        response = self._open(operation_id, **kwargs)

        try:
            return json.loads(response.read() or b"null")
        finally:
            response.close()

    def _events(self, operation_id: str, **kwargs: Any) -> Iterator[StreamEvent]:
        response = self._open(operation_id, **kwargs)
        name = "message"
        data: list[str] = []

        try:
            for raw in response:
                line = raw.decode("utf-8").rstrip("\r\n")

                if line == "":
                    if data:
                        event = _event(name, data)

                        if event is not None:
                            yield event

                    name = "message"
                    data = []
                elif line.startswith("event:"):
                    name = line[6:].strip()
                elif line.startswith("data:"):
                    data.append(line[5:].lstrip())
        finally:
            # Leaving the loop early, or breaking out of it, closes the
            # connection so the server stops writing.
            response.close()


class _Agents:
    def __init__(self, client: Lynxby) -> None:
        self._client = client

    def list(self, cursor: str | None = None, per_page: int | None = None) -> dict[str, Any]:
        return self._client._json("api.v1.assistants.index", query={"cursor": cursor, "per_page": per_page})

    def get(self, assistant_id: int | str) -> dict[str, Any]:
        return self._client._json("api.v1.assistants.show", path={"id": assistant_id})

    def run(
        self,
        assistant_id: int | str,
        message: str,
        session_id: str | None = None,
        idempotency_key: str | None = None,
        retries: int | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"message": message}

        if session_id is not None:
            body["session_id"] = session_id

        return self._client._json(
            "api.v1.assistants.messages",
            path={"id": assistant_id},
            body=body,
            idempotency_key=idempotency_key,
            retries=retries,
        )

    def stream(
        self,
        assistant_id: int | str,
        message: str,
        session_id: str | None = None,
        idempotency_key: str | None = None,
        retries: int | None = None,
    ) -> Iterator[StreamEvent]:
        body: dict[str, Any] = {"message": message}

        if session_id is not None:
            body["session_id"] = session_id

        return self._client._events(
            "api.v1.assistants.messages.stream",
            path={"id": assistant_id},
            body=body,
            idempotency_key=idempotency_key,
            retries=retries,
        )


class _Tasks:
    def __init__(self, client: Lynxby) -> None:
        self._client = client

    def list(self, cursor: str | None = None, per_page: int | None = None) -> dict[str, Any]:
        return self._client._json("api.v1.tasks.index", query={"cursor": cursor, "per_page": per_page})

    def get(self, task_id: int | str) -> dict[str, Any]:
        return self._client._json("api.v1.tasks.show", path={"id": task_id})

    def run(
        self,
        task_id: int | str,
        inputs: dict[str, str] | None = None,
        idempotency_key: str | None = None,
        retries: int | None = None,
    ) -> dict[str, Any]:
        return self._client._json(
            "api.v1.tasks.runs",
            path={"id": task_id},
            body={"inputs": inputs or {}},
            idempotency_key=idempotency_key,
            retries=retries,
        )

    def stream(
        self,
        task_id: int | str,
        inputs: dict[str, str] | None = None,
        idempotency_key: str | None = None,
        retries: int | None = None,
    ) -> Iterator[StreamEvent]:
        return self._client._events(
            "api.v1.tasks.runs.stream",
            path={"id": task_id},
            body={"inputs": inputs or {}},
            idempotency_key=idempotency_key,
            retries=retries,
        )


class _Runs:
    def __init__(self, client: Lynxby) -> None:
        self._client = client

    def list(self, cursor: str | None = None, per_page: int | None = None) -> dict[str, Any]:
        return self._client._json("api.v1.runs.index", query={"cursor": cursor, "per_page": per_page})

    def get(self, run_id: int | str) -> dict[str, Any]:
        return self._client._json("api.v1.runs.show", path={"id": run_id})

    def retry(self, run_id: int | str, idempotency_key: str | None = None) -> dict[str, Any]:
        return self._client._json("api.v1.runs.retry", path={"id": run_id}, idempotency_key=idempotency_key)

    def approve(self, run_id: int | str, note: str | None = None, idempotency_key: str | None = None) -> dict[str, Any]:
        return self._client._json(
            "api.v1.approvals.runs.approve",
            path={"id": run_id},
            body={} if note is None else {"note": note},
            idempotency_key=idempotency_key,
        )


def _event(name: str, data: list[str]) -> StreamEvent | None:
    try:
        return {"event": name, "data": json.loads("\n".join(data))}
    except ValueError:
        # A frame that is not JSON is a comment or a keep-alive, not a turn.
        return None


def _retryable(status: int) -> bool:
    return status in RETRYABLE or status >= 500


def _backoff(base: float, attempt: int, retry_after: float | None) -> float:
    if retry_after is not None:
        return retry_after

    return base * (2**attempt) * (0.5 + random.random() / 2)


def _error_from(error: HTTPError) -> ApiError:
    try:
        body = json.loads(error.read() or b"{}")
    except ValueError:
        body = {}

    retry_after = None

    if error.headers is not None and error.headers.get("Retry-After") is not None:
        try:
            retry_after = float(error.headers["Retry-After"])
        except ValueError:
            retry_after = None

    status = error.code
    classes = {
        401: AuthenticationError,
        403: PermissionError,
        404: NotFoundError,
        422: ValidationError,
        429: RateLimitError,
    }
    error_class = classes.get(status, ServerError if status >= 500 else ApiError)

    return error_class(
        status,
        body.get("code", "http_error"),
        body.get("message", "The request failed."),
        body.get("request_id", "unassigned"),
        body.get("errors"),
        retry_after,
    )
