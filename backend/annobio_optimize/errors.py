"""Public errors with a machine-readable field path and a practical repair hint."""
from __future__ import annotations


class AnnoBioError(Exception):
    """Base class for errors raised by the library itself."""


class ValidationError(AnnoBioError):
    def __init__(self, message: str, *, path: str | None = None, hint: str | None = None):
        self.message, self.path, self.hint = message, path, hint
        super().__init__(f"{path}: " if path else "")
        self.args = (self._format(),)

    def _format(self):
        return (f"{self.path}: " if self.path else "") + self.message + (f" {self.hint}" if self.hint else "")

    def at(self, path: str):
        return type(self)(self.message, path=path, hint=self.hint)


class InputTypeError(ValidationError, TypeError):
    """Wrong argument/data type; also catchable as TypeError."""


class InputValueError(ValidationError, ValueError):
    """An argument has the right type but an invalid value."""


class CallbackContractError(InputTypeError):
    """A callback is asynchronous or returns data outside its declared contract."""


class ModelResponseError(InputValueError):
    """An optimization-model response violates its JSON/data contract."""


class UnknownSuggestionError(AnnoBioError, KeyError):
    """The requested suggestion ID is absent from this review session."""


def exception_message(exc: Exception) -> str:
    """Include callback context in recorded errors as well as exception tracebacks."""
    notes = getattr(exc, "__notes__", ())
    return "\n".join([str(exc), *notes])
