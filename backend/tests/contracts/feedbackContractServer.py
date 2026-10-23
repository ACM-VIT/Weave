"""Loopback-only fault fixture: real provider routes, admission and Redis scripts."""
import asyncio
import json
import os
from pathlib import Path
import socket
import sys
import threading
from urllib.parse import urlsplit

root = Path(os.environ["WEAVE_ML_CONTRACT_ROOT"]).resolve()
url = urlsplit(os.environ["REDIS_URL"])
if url.scheme != "redis" or url.hostname not in {"127.0.0.1", "localhost", "::1"} or url.path != "/15":
    raise RuntimeError("Select a dedicated loopback Redis database15")
stream = os.environ["FEEDBACK_STREAM_NAME"]
if not stream.startswith("test:outbox-contract:"):
    raise RuntimeError("A unique test stream is required")
sys.path.insert(0, str(root))
os.environ["APP_ENV"] = "development"
os.environ["INTERNAL_API_SECRET"] = "local-feedback-contract-secret"

import redis
import uvicorn
from api import v2
from api.main import app
from feedback.v2 import DurableFeedbackProducer
from feedback.v2_settings import V2FeedbackSettings

client = redis.Redis.from_url(os.environ["REDIS_URL"], decode_responses=True)
client.ping()
lock = threading.Lock()
state = {"mode": "normal", "script_failure": False}


class FaultPipeline:
    def __init__(self, pipeline):
        self.pipeline = pipeline
        self.index = 0

    def eval(self, *args):
        if self.index == 1:
            self.pipeline.eval("return redis.error_reply('isolated fixture script failure')", 0)
        else:
            self.pipeline.eval(*args)
        self.index += 1
        return self

    def execute(self, **kwargs):
        return self.pipeline.execute(**kwargs)


class FaultRedis:
    def __getattr__(self, name):
        return getattr(client, name)

    def pipeline(self, **kwargs):
        pipeline = client.pipeline(**kwargs)
        with lock:
            fail = state["script_failure"]
            state["script_failure"] = False
        return FaultPipeline(pipeline) if fail else pipeline


producer = DurableFeedbackProducer(redis_client=FaultRedis(), settings=V2FeedbackSettings.from_env())
v2.producer = lambda: producer


async def response(send, status, value, headers=()):
    raw = json.dumps(value).encode()
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json"), *headers]})
    await send({"type": "http.response.body", "body": raw})


async def fixture(scope, receive, send):
    if scope["type"] != "http":
        return await app(scope, receive, send)
    secret = dict(scope["headers"]).get(b"x-internal-secret")
    if scope["path"] == "/_fixture/control":
        if secret != b"local-feedback-contract-secret":
            return await response(send, 401, {"detail": "Invalid fixture secret"})
        chunks = bytearray()
        while True:
            message = await receive()
            chunks.extend(message.get("body", b""))
            if len(chunks) > 1024:
                return await response(send, 413, {})
            if not message.get("more_body"):
                break
        mode = json.loads(chunks)["mode"]
        if mode not in {"normal", "partial", "delay", "429"}:
            return await response(send, 400, {})
        with lock:
            state["mode"] = mode
        return await response(send, 200, {"mode": mode})
    if scope["path"] != "/api/v2/feedback/batch" or secret != b"local-feedback-contract-secret":
        return await app(scope, receive, send)
    with lock:
        mode = state["mode"]
        state["mode"] = "normal"
        if mode == "partial":
            state["script_failure"] = True
    if mode == "429":
        return await response(send, 429, {"detail": "Isolated downstream backpressure"}, [(b"retry-after", b"2")])
    if mode != "delay":
        return await app(scope, receive, send)
    messages = []

    async def capture(message):
        messages.append(message)

    await app(scope, receive, capture)
    # Redis acceptance is complete, but the caller's shorter HTTP deadline expires.
    await asyncio.sleep(0.25)
    for message in messages:
        await send(message)


listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen(128)
print(f"CONTRACT_PORT={listener.getsockname()[1]}", flush=True)
try:
    uvicorn.Server(uvicorn.Config(fixture, lifespan="off", log_level="error")).run(sockets=[listener])
finally:
    client.close()
