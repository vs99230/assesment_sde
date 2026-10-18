import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger("ops")

_CODE_BY_STATUS = {
    401: "UNAUTHENTICATED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "NOT_FOUND",
    409: "VERSION_CONFLICT",
    422: "VALIDATION_ERROR",
}


class ApiError(Exception):
    """Every expected failure is one of these. The handler below renders the contract's error format."""

    def __init__(self, status: int, code: str, message: str, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


def unauthenticated(message: str = "Please sign in.") -> ApiError:
    return ApiError(401, "UNAUTHENTICATED", message)


def forbidden(message: str = "You are not allowed to do that.") -> ApiError:
    return ApiError(403, "FORBIDDEN", message)


def not_found(message: str = "Not found.") -> ApiError:
    return ApiError(404, "NOT_FOUND", message)


def validation_error(fields: dict[str, str] | None = None, message: str = "Please fix the highlighted fields.") -> ApiError:
    return ApiError(422, "VALIDATION_ERROR", message, {"fields": fields} if fields else None)


def invalid_transition(message: str) -> ApiError:
    return ApiError(422, "INVALID_TRANSITION", message)


def _body(code: str, message: str, details: dict[str, Any] | None) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, "message": message}
    if details is not None:
        error["details"] = details
    return {"error": error}


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        headers = {"WWW-Authenticate": "Bearer"} if exc.status == 401 else None
        return JSONResponse(_body(exc.code, exc.message, exc.details), status_code=exc.status, headers=headers)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        fields: dict[str, str] = {}
        for err in exc.errors():
            names = [str(p) for p in err["loc"] if isinstance(p, str) and p not in ("body", "query", "path", "header")]
            name = names[-1] if names else "request"
            message = str(err.get("msg", "Invalid value")).removeprefix("Value error, ")
            fields.setdefault(name, message)
        return JSONResponse(
            _body("VALIDATION_ERROR", "Please fix the highlighted fields.", {"fields": fields}),
            status_code=422,
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _CODE_BY_STATUS.get(exc.status_code, "UNKNOWN")
        return JSONResponse(_body(code, str(exc.detail), None), status_code=exc.status_code)

    @app.exception_handler(Exception)
    async def _unexpected(_: Request, exc: Exception) -> JSONResponse:
        # Never leak internals to the client; the full traceback goes to the log.
        log.exception("Unhandled error", exc_info=exc)
        return JSONResponse(_body("UNKNOWN", "Something went wrong on the server.", None), status_code=500)
