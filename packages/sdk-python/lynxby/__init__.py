"""The Lynxby API client: assistants, tasks and runs, with server-sent events."""

from .client import Lynxby
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
from .generated import VERSION, OPERATIONS

__all__ = [
    "VERSION",
    "OPERATIONS",
    "ApiError",
    "AuthenticationError",
    "Lynxby",
    "LynxbyError",
    "NotFoundError",
    "PermissionError",
    "RateLimitError",
    "ServerError",
    "ValidationError",
]
