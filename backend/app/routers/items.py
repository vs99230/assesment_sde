from typing import Annotated

from fastapi import APIRouter, Header, Query
from fastapi.responses import JSONResponse

from app.deps import CurrentUser, DbSession
from app.errors import validation_error
from app.schemas import (
    ActivityOut,
    ActivityPage,
    CommentIn,
    CreateItemIn,
    DashboardOut,
    DashboardView,
    ItemPage,
    ItemType,
    Priority,
    Status,
    TransitionIn,
    UpdateItemIn,
    WorkItemOut,
)
from app.services import items as svc

router = APIRouter(tags=["items"])


@router.get("/dashboard", response_model=DashboardOut)
def get_dashboard(db: DbSession, user: CurrentUser) -> DashboardOut:
    return svc.dashboard(db, user)


@router.get("/items", response_model=ItemPage)
def list_items(
    db: DbSession,
    user: CurrentUser,
    status: Status | None = None,
    priority: Priority | None = None,
    type: ItemType | None = None,
    team_id: Annotated[int | None, Query(alias="teamId")] = None,
    assignee: Annotated[str | None, Query(pattern=r"^(me|unassigned|\d+)$")] = None,
    q: Annotated[str | None, Query(max_length=200)] = None,
    view: DashboardView | None = None,
    cursor: Annotated[str | None, Query(max_length=32)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> ItemPage:
    filters = svc.ItemFilters(
        status=status, priority=priority, type=type, team_id=team_id, assignee=assignee, q=q, view=view
    )
    items, next_cursor = svc.list_items(db, user, filters, cursor, limit)
    return ItemPage(items=[WorkItemOut.model_validate(i) for i in items], next_cursor=next_cursor)


@router.post("/items", status_code=201, response_model=WorkItemOut)
def create_item(
    body: CreateItemIn,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> JSONResponse:
    key = (idempotency_key or "").strip()
    if not key:
        raise validation_error({"Idempotency-Key": "The Idempotency-Key header is required."})
    if len(key) > 255:
        raise validation_error({"Idempotency-Key": "The Idempotency-Key header is too long."})
    # The service returns the JSON that was (or had earlier been) sent for this key.
    return JSONResponse(svc.create_item(db, user, body, key), status_code=201)


@router.get("/items/{item_id}", response_model=WorkItemOut)
def get_item(item_id: int, db: DbSession, user: CurrentUser) -> WorkItemOut:
    item, _ = svc.get_item_for_user(db, user, item_id)
    return WorkItemOut.model_validate(item)


@router.patch("/items/{item_id}", response_model=WorkItemOut)
def update_item(item_id: int, body: UpdateItemIn, db: DbSession, user: CurrentUser) -> WorkItemOut:
    return WorkItemOut.model_validate(svc.update_item(db, user, item_id, body))


@router.post("/items/{item_id}/claim", response_model=WorkItemOut)
def claim_item(item_id: int, db: DbSession, user: CurrentUser) -> WorkItemOut:
    return WorkItemOut.model_validate(svc.claim_item(db, user, item_id))


@router.post("/items/{item_id}/transition", response_model=WorkItemOut)
def transition_item(item_id: int, body: TransitionIn, db: DbSession, user: CurrentUser) -> WorkItemOut:
    return WorkItemOut.model_validate(svc.transition_item(db, user, item_id, body))


@router.get("/items/{item_id}/activity", response_model=ActivityPage)
def list_activity(
    item_id: int,
    db: DbSession,
    user: CurrentUser,
    cursor: Annotated[str | None, Query(max_length=32)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> ActivityPage:
    events, next_cursor = svc.list_activity(db, user, item_id, cursor, limit)
    return ActivityPage(items=[svc.activity_out(e) for e in events], next_cursor=next_cursor)


@router.post("/items/{item_id}/comments", response_model=ActivityOut, status_code=201)
def add_comment(item_id: int, body: CommentIn, db: DbSession, user: CurrentUser) -> ActivityOut:
    return svc.activity_out(svc.add_comment(db, user, item_id, body), actor=user)
