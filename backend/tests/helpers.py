import threading
from collections.abc import Callable
from typing import Any

from sqlalchemy import func, select

from app.db import SessionLocal
from app.models import ActivityEvent, WorkItem


def race(*calls: Callable[[], Any]) -> list[Any]:
    """Runs the callables in separate threads, released at the same instant. Returns their results in order."""
    barrier = threading.Barrier(len(calls))
    results: list[Any] = [None] * len(calls)
    errors: list[BaseException] = []

    def run(i: int, fn: Callable[[], Any]) -> None:
        try:
            barrier.wait(timeout=10)
            results[i] = fn()
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=run, args=(i, fn)) for i, fn in enumerate(calls)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    if errors:
        raise errors[0]
    return results


def fetch_item(item_id: int) -> WorkItem:
    with SessionLocal() as db:
        item = db.get(WorkItem, item_id)
        assert item is not None
        db.expunge(item)
        return item


def count_events(item_id: int, type_: str | None = None) -> int:
    with SessionLocal() as db:
        stmt = select(func.count()).select_from(ActivityEvent).where(ActivityEvent.item_id == item_id)
        if type_:
            stmt = stmt.where(ActivityEvent.type == type_)
        return db.scalar(stmt) or 0
