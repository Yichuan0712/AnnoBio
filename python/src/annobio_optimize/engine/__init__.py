"""AnnoBio optimization engine v2 (python/ENGINE_V2_DESIGN.md).

One implementation for the app backend, the experiment runner and the H1 console. Session holds
the Optimize panel's operations; Operator drives them with fixed rules when no person is involved.
"""
from .operator import STYLE_SETTINGS, Operator, OperatorConfig, OperatorResult, RoundSummary, suggest_style
from .demos import DemoCandidate, DemoSearchResult, search_demos
from .records import Card, Check, Decision, EngineConfig, HistoryItem, SearchRecord, SearchTrialRecord, StyleChoice
from .session import EngineStopped, Session

__all__ = ["Session", "Operator", "OperatorConfig", "OperatorResult", "RoundSummary", "EngineConfig", "Card",
           "Check", "Decision", "HistoryItem", "SearchRecord", "SearchTrialRecord", "EngineStopped", "StyleChoice",
           "STYLE_SETTINGS", "suggest_style", "search_demos", "DemoCandidate", "DemoSearchResult"]
