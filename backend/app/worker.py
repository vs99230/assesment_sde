"""Outbox worker. Run with:  python -m app.worker"""

import logging
import signal
import time

from app.config import settings
from app.db import SessionLocal
from app.services.outbox import process_batch

log = logging.getLogger("ops.worker")
_running = True


def _stop(*_: object) -> None:
    global _running
    _running = False


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    log.info("Outbox worker started (poll every %.1fs)", settings.worker_poll_seconds)

    while _running:
        try:
            with SessionLocal() as db:
                picked = process_batch(db)
        except Exception:  # noqa: BLE001 - e.g. database restarting; keep the worker alive
            log.exception("Worker loop error; retrying")
            picked = 0
            time.sleep(settings.worker_poll_seconds * 3)
        if picked == 0:
            time.sleep(settings.worker_poll_seconds)
    log.info("Outbox worker stopped")


if __name__ == "__main__":
    main()
