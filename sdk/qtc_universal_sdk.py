# -*- coding: utf-8 -*-
"""
QTC Universal Agent Telemetry SDK (Zero-Interference Drop-in Reporter)
======================================================================
Allows any custom Python AI Agent (LangGraph, AutoGen, CrewAI, local pipelines)
to passively append completed session (Q, T, C) telemetry into QTC Observatory.
All file operations fail silently so host agent execution is never affected.
"""
import os
import json
import time

DROPIN_FILE = os.path.expanduser(
    "~/.gemini/config/plugins/qtc-observatory/.data/dropin/python_sdk_ingest.jsonl"
)

def record_agent_session(
    session_id: str,
    platform: str = "custom-python-agent",
    model: str = "custom-model",
    title: str = "",
    planner_turns: int = 1,
    input_tokens: int = 0,
    cache_read_tokens: int = 0,
    output_tokens: int = 0,
    llm_infer_sec: float = 0.0,
    sync_tool_sec: float = 0.0,
    bg_wait_sec: float = 0.0,
    tool_calls: int = 0,
    cmd_total: int = 0,
    cmd_failed: int = 0,
    file_edits: int = 0,
    compactions: int = 0,
    neg_feedback_turns: int = 0,
    cwd: str = "",
) -> bool:
    try:
        os.makedirs(os.path.dirname(DROPIN_FILE), exist_ok=True)
        now = time.time()
        payload = {
            "session_id": str(session_id),
            "platform": str(platform),
            "model": str(model),
            "title": str(title or session_id)[:140],
            "started_at": now - (llm_infer_sec + sync_tool_sec + bg_wait_sec),
            "ended_at": now,
            "cwd": cwd or os.getcwd(),
            "planner_turns": int(planner_turns),
            "input_tokens": int(input_tokens),
            "cache_read_tokens": int(cache_read_tokens),
            "output_tokens": int(output_tokens),
            "llm_infer_sec": float(llm_infer_sec),
            "sync_tool_sec": float(sync_tool_sec),
            "bg_wait_sec": float(bg_wait_sec),
            "tool_calls": int(tool_calls),
            "cmd_total": int(cmd_total),
            "cmd_failed": int(cmd_failed),
            "file_edits": int(file_edits),
            "compactions": int(compactions),
            "neg_feedback_turns": int(neg_feedback_turns),
            "token_accuracy": "exact",
        }
        with open(DROPIN_FILE, "a", encoding="utf-8") as fp:
            fp.write(json.dumps(payload, ensure_ascii=False) + "\n")
        return True
    except Exception:
        return False
