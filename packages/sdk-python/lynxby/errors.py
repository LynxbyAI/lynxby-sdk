"""The error the call raises, one class per family the API can answer."""

from __future__ import annotations


class LynxbyError(Exception):
    """Anything this client raises: no token, a broken stream, a bad answer."""


class ApiError(LynxbyError):
    """A refusal from the API, with the code and the request id it carries."""

    def __init__(
        self,
        status: int,
        code: str = "http_error",
        message: str = "The request failed.",
        request_id: str = "unassigned",
        errors: dict[str, list[str]] | None = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.request_id = request_id
        self.errors = errors or {}
        self.retry_after = retry_after


class AuthenticationError(ApiError):
    """401: the token is missing, expired or revoked."""


class PermissionError(ApiError):
    """403: the token may not do this, or its owner may not."""


class NotFoundError(ApiError):
    """404: no such record in this organisation."""


class ValidationError(ApiError):
    """422: the body, the query or a header is not valid."""


class RateLimitError(ApiError):
    """429: the token is over its ceiling, after the retries ran out."""


class ServerError(ApiError):
    """5xx: something on our side failed, after the retries ran out."""
