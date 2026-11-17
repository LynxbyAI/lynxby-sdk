"""The client against a stub that speaks the same frames and error envelope.

Standard library only: http.server in a thread, unittest for the assertions.
"""

from __future__ import annotations

import json
import os
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from lynxby import Lynxby, NotFoundError, RateLimitError, ValidationError
from lynxby.errors import LynxbyError

MESSAGE = {
    "id": 41,
    "session_id": "session-1",
    "role": "assistant",
    "content": "Hello",
    "citations": [],
    "reasoning": None,
    "review": None,
    "model": "test-model",
    "provider": "test",
    "prompt_tokens": 3,
    "completion_tokens": 1,
    "cost": 0.001,
    "currency": "EUR",
    "created_at": "2026-11-14T10:00:00+00:00",
}


def frame(name: str, data: object) -> str:
    return f"event: {name}\ndata: {json.dumps(data)}\n\n"


class Stub:
    """A server on a free port, answering through the responder you set."""

    def __init__(self) -> None:
        stub = self
        self.seen: list[dict[str, object]] = []
        self.responder = lambda request, response: None  # noqa: E731
        self.probe_closed = False

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_GET(self) -> None:  # noqa: N802
                stub.dispatch(self)

            def do_POST(self) -> None:  # noqa: N802
                stub.dispatch(self)

            def log_message(self, *args: object) -> None:
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def dispatch(self, request: BaseHTTPRequestHandler) -> None:
        length = int(request.headers.get("Content-Length") or 0)
        record: dict[str, object] = {
            "method": request.command,
            "url": request.path,
            "headers": {key.lower(): value for key, value in request.headers.items()},
            "body": request.rfile.read(length).decode() if length else "",
            "closed": False,
        }
        self.seen.append(record)
        self.responder(request, record)

    def send(self, request: BaseHTTPRequestHandler, record: dict[str, object], text: str) -> bool:
        try:
            request.wfile.write(text.encode())
            request.wfile.flush()

            return True
        except (BrokenPipeError, ConnectionResetError):
            record["closed"] = True

            return False

    def stream(self, request: BaseHTTPRequestHandler, record: dict[str, object], *frames: str, delay: float = 0.0) -> None:
        request.send_response(200)
        request.send_header("Content-Type", "text/event-stream")
        request.send_header("Connection", "close")
        request.end_headers()

        for text in frames:
            if not self.send(request, record, text):
                return

            if delay:
                time.sleep(delay)

        if self.probe_closed:
            # A closed peer reads as end-of-stream, which a small write into
            # the kernel buffer does not always raise.
            try:
                request.connection.settimeout(0.5)
                record["closed"] = request.connection.recv(1) == b""
            except (TimeoutError, OSError):
                record["closed"] = False


    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def __enter__(self) -> "Stub":
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


def json_response(request: BaseHTTPRequestHandler, record: dict[str, object], status: int, payload: object) -> None:
    request.send_response(status)
    request.send_header("Content-Type", "application/json")
    request.send_header("Connection", "close")
    request.end_headers()
    record["closed"] = True
    request.wfile.write(json.dumps(payload).encode())


class ClientTest(unittest.TestCase):
    def test_a_chat_stream_yields_the_frames_in_order(self) -> None:
        with Stub() as stub:
            stub.responder = lambda request, record: stub.stream(
                request,
                record,
                frame("start", {"model": "test-model", "session_id": "session-1"}),
                frame("delta", {"delta": "Hel"}),
                frame("delta", {"delta": "lo"}),
                frame("done", MESSAGE),
            )
            client = Lynxby(token="lynx_test", base_url=stub.base_url)
            events = list(client.agents.stream(12, "What is the notice period?"))

            self.assertEqual([event["event"] for event in events], ["start", "delta", "delta", "done"])
            self.assertEqual(events[-1]["data"]["content"], "Hello")
            self.assertEqual(stub.seen[0]["headers"]["authorization"], "Bearer lynx_test")
            self.assertEqual(stub.seen[0]["url"], "/api/v1/assistants/12/messages/stream")
            self.assertEqual(json.loads(str(stub.seen[0]["body"])), {"message": "What is the notice period?"})
            self.assertTrue(stub.seen[0]["headers"]["idempotency-key"])

    def test_a_task_run_streams_its_start_and_its_done(self) -> None:
        run = {"id": 9, "task_id": 8, "status": "completed", "answer": "done"}

        with Stub() as stub:
            stub.responder = lambda request, record: stub.stream(
                request,
                record,
                frame("start", {"model": "test-model", "task_id": 8}),
                frame("done", run),
            )
            events = list(Lynxby(token="lynx_test", base_url=stub.base_url).tasks.stream(8, {"text": "A long letter."}))

            self.assertEqual(events[-1]["data"]["status"], "completed")
            self.assertEqual(json.loads(str(stub.seen[0]["body"])), {"inputs": {"text": "A long letter."}})

    def test_breaking_out_of_a_stream_closes_the_request(self) -> None:
        with Stub() as stub:
            stub.probe_closed = True
            stub.responder = lambda request, record: stub.stream(
                request,
                record,
                frame("start", {"model": "test-model"}),
                frame("delta", {"delta": "Hel"}),
                frame("delta", {"delta": "lo"}),
                frame("done", MESSAGE),
                delay=0.05,
            )
            stream = Lynxby(token="lynx_test", base_url=stub.base_url).agents.stream(12, "Hello")
            first = next(stream)
            self.assertEqual(first["event"], "start")
            stream.close()

            time.sleep(0.3)
            rows = [row for row in stub.seen if row["method"] == "POST"]
            self.assertTrue(rows[0]["closed"], "the server saw the client go away")

    def test_a_rate_limit_is_retried_and_then_typed(self) -> None:
        with Stub() as stub:
            stub.responder = lambda request, record: json_response(
                request,
                record,
                429,
                {"code": "rate_limited", "message": "Too many requests.", "request_id": "req-1"},
            )
            client = Lynxby(token="lynx_test", base_url=stub.base_url, retry_delay=0.001)

            with self.assertRaises(RateLimitError) as caught:
                client.agents.list()

            self.assertEqual(caught.exception.status, 429)
            self.assertEqual(caught.exception.code, "rate_limited")
            self.assertEqual(caught.exception.request_id, "req-1")
            self.assertEqual(len(stub.seen), 3, "the original call and two retries")

    def test_a_server_error_is_retried_and_the_next_answer_is_used(self) -> None:
        calls = {"count": 0}

        def responder(request: BaseHTTPRequestHandler, record: dict[str, object]) -> None:
            calls["count"] += 1

            if calls["count"] == 1:
                json_response(request, record, 503, {"code": "server_error", "message": "Try again.", "request_id": "req-2"})

                return

            json_response(request, record, 200, {"data": [{"id": 3}], "next_cursor": None, "has_more": False})

        with Stub() as stub:
            stub.responder = responder
            page = Lynxby(token="lynx_test", base_url=stub.base_url, retry_delay=0.001).agents.list()

            self.assertEqual(page["data"], [{"id": 3}])
            self.assertEqual(calls["count"], 2)

    def test_a_validation_failure_and_a_missing_record_keep_their_type(self) -> None:
        def responder(request: BaseHTTPRequestHandler, record: dict[str, object]) -> None:
            missing = "/runs/" in request.path
            json_response(
                request,
                record,
                404 if missing else 422,
                {
                    "code": "not_found" if missing else "validation_failed",
                    "message": "The body is not valid.",
                    "request_id": "req-3",
                    "errors": {"inputs": ["The text field is required."]},
                },
            )

        with Stub() as stub:
            stub.responder = responder
            client = Lynxby(token="lynx_test", base_url=stub.base_url)

            with self.assertRaises(ValidationError) as caught:
                client.tasks.run(8, {})

            self.assertEqual(caught.exception.errors, {"inputs": ["The text field is required."]})

            with self.assertRaises(NotFoundError):
                client.runs.get(999)

            self.assertEqual(len(stub.seen), 2, "a 422 and a 404 are not retried")

    def test_lists_carry_the_cursor_and_the_page_size(self) -> None:
        with Stub() as stub:
            stub.responder = lambda request, record: json_response(
                request, record, 200, {"data": [], "next_cursor": "next", "has_more": True}
            )
            page = Lynxby(token="lynx_test", base_url=stub.base_url).runs.list(cursor="abc", per_page=2)

            self.assertEqual(page["next_cursor"], "next")
            self.assertEqual(stub.seen[0]["url"], "/api/v1/runs?cursor=abc&per_page=2")

    def test_approving_a_parked_run_posts_the_note(self) -> None:
        with Stub() as stub:
            stub.responder = lambda request, record: json_response(request, record, 200, {"id": 7, "status": "running"})
            run = Lynxby(token="lynx_test", base_url=stub.base_url).runs.approve(7, "Send it.")

            self.assertEqual(run["status"], "running")
            self.assertEqual(stub.seen[0]["url"], "/api/v1/approvals/runs/7/approve")
            self.assertEqual(json.loads(str(stub.seen[0]["body"])), {"note": "Send it."})

    def test_the_token_and_the_base_url_come_from_the_environment(self) -> None:
        with Stub() as stub:
            stub.responder = lambda request, record: json_response(
                request, record, 200, {"data": [], "next_cursor": None, "has_more": False}
            )
            saved = {key: os.environ.get(key) for key in ("LYNXBY_TOKEN", "LYNXBY_BASE_URL")}

            try:
                os.environ["LYNXBY_TOKEN"] = "lynx_from_env"
                os.environ["LYNXBY_BASE_URL"] = stub.base_url
                Lynxby().tasks.list()

                self.assertEqual(stub.seen[0]["headers"]["authorization"], "Bearer lynx_from_env")
            finally:
                for key, value in saved.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value

    def test_a_client_without_a_token_says_so(self) -> None:
        with self.assertRaises(LynxbyError):
            Lynxby(token="", base_url="http://127.0.0.1:1").agents.get(1)


if __name__ == "__main__":
    unittest.main()
