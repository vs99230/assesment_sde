from fastapi import APIRouter
from sqlalchemy import func, select

from app.deps import CurrentUser, DbSession
from app.errors import unauthenticated
from app.models import User
from app.schemas import LoginIn, LoginOut, MembershipOut, TeamMemberOut, UserOut
from app.security import DUMMY_HASH, create_token, verify_password
from app.services import items as items_service

router = APIRouter()


def user_out(user: User) -> UserOut:
    return UserOut(
        id=user.id,
        name=user.name,
        email=user.email,
        memberships=[
            MembershipOut(team_id=m.team_id, team_name=m.team.name, role=m.role)  # type: ignore[arg-type]
            for m in user.memberships
        ],
    )


@router.post("/auth/login", response_model=LoginOut, tags=["auth"])
def login(body: LoginIn, db: DbSession) -> LoginOut:
    email = body.email.strip().lower()
    user = db.scalar(select(User).where(func.lower(User.email) == email))
    # Same work and same message whether the email exists or not.
    ok = verify_password(body.password, user.password_hash if user else DUMMY_HASH)
    if user is None or not ok:
        raise unauthenticated("Invalid email or password.")
    return LoginOut(token=create_token(user.id), user=user_out(user))


@router.get("/auth/me", response_model=UserOut, tags=["auth"])
def me(user: CurrentUser) -> UserOut:
    return user_out(user)


@router.get("/teams/{team_id}/members", response_model=list[TeamMemberOut], tags=["teams"])
def team_members(team_id: int, db: DbSession, user: CurrentUser) -> list[dict]:
    return items_service.team_members(db, user, team_id)
