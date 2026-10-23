"""Loopback-only tracing fixture: real auth, DTOs, admission and feedback route."""
import socket

import uvicorn
from api import v2
from api.main import app
from utils.observability import current_correlation, diagnostic_snapshot

received = []


def feedback(events):
    context = current_correlation()
    received.append({"trace_id": context.trace_id, "span_id": context.span_id,
                     "request_id": context.request_id})
    return len(events), 0


v2._enqueue_feedback = feedback


@app.get('/api/v2/tracing-fixture')
def diagnostics():
    return {"received": received, "diagnostics": diagnostic_snapshot()}


listener = socket.socket()
listener.bind(('127.0.0.1', 0))
listener.listen(16)
print(f'CONTRACT_PORT={listener.getsockname()[1]}', flush=True)
uvicorn.Server(uvicorn.Config(app, lifespan='off', log_level='error')).run(sockets=[listener])
