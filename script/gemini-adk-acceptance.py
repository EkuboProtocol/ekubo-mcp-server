#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "google-adk[mcp]==2.13.0",
#     "pycryptodome==4.3.0",
# ]
# ///
"""Gemini acceptance run for an Ekubo MCP endpoint through Google ADK.

Uses ADK's McpToolset over Streamable HTTP, the client Google's agent stack
uses for remote MCP servers.

Without credentials it runs the discovery and direct-call checks: initialize
and tools/list through ADK's session, conversion of every tool to the Gemini
function declaration ADK sends (JSON Schema) and to the older OpenAPI-subset
declaration, and representative calls (a read, a malformed argument, an empty
page, an unsigned preparation and a read bundle) whose artifact references are
fetched and checked against their keccak256 integrity.

With GOOGLE_API_KEY or GEMINI_API_KEY set it also runs each scenario against a
real Gemini model. The model sees TextContent only (structuredContent is
removed, as Google Connected Apps does not consume it yet) and the server's own
initialize instructions. Wallet tools are local stand-ins declared from the
Cloud Wallet catalog snapshot (--wallet-catalog): they compare each received
reference with the envelope the producer returned and verify the stored bytes.
They never simulate, sign or send, and no send tool is offered.

    uv run script/gemini-adk-acceptance.py --out gemini-adk.json
    op run --env-file gemini.env -- uv run script/gemini-adk-acceptance.py \\
      --wallet-catalog ../cloud-wallet/apps/api/src/reference/tools.json

The API key is read by the Gemini SDK from the environment. Report and Python
console output redact both Gemini key formats (including SDK errors/logging).

AI Studio browser capture: redact AIza... and AQ.... keys AND generic long
tokens in-page before any DOM text/HTML or input values leave the browser.
Never return an unredacted key-details dialog. Prefer RSA-OAEP encrypted capture
(return ciphertext only); see docs/GOOGLE-CONNECTED-APPS.md for the operator rule.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import platform
import sys
import time
from datetime import datetime, timezone
from importlib import metadata
from pathlib import Path
from typing import Any

from gemini_redaction import install_console_redaction, redact, write_report

if __name__ == "__main__":
    install_console_redaction()

import httpx
from Crypto.Hash import keccak
from google.adk.agents import LlmAgent
from google.adk.models import Gemini
from google.adk.runners import InMemoryRunner
from google.adk.tools._gemini_schema_util import _to_gemini_schema
from google.adk.tools.base_tool import BaseTool
from google.adk.tools.mcp_tool import McpToolset, StreamableHTTPConnectionParams
from google.adk.tools.mcp_tool.mcp_tool import McpTool, _dump_mcp_model
from google.genai import types

ROOT = Path(__file__).resolve().parent.parent
ACCOUNTS = json.loads((ROOT / "test/mcp-acceptance/fixtures.json").read_text())["accounts"]
SENDER = ACCOUNTS["accounts"][0]["address"]
ACCOUNT_ID = ACCOUNTS["accounts"][0]["account_id"]
NATIVE = "0x0000000000000000000000000000000000000000"
BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
ETH_USDC_POOL = {
    "chain_id": "1",
    "core_address": "0x00000000000014aA86C5d3c41765bb24e11bd701",
    "pool_id": "0x40f28acb8adc041aa51c8db8f21a9ccac0ee359075b01e1b432c238bb4e6c7eb",
}
WALLET_TOOLS = ("wallet_list", "wallet_simulate_execution_plan", "wallet_batch_eth_call")
VERIFIED_FIELDS = ("kind", "artifact_type", "url", "bytes", "integrity")

SCENARIOS = [
    {
        "id": "read-token",
        "user": "Using Ekubo, what are the symbol and decimals of the native Ether token on Ethereum mainnet (chain 1)?",
        "producer": {"tool": ["get_token", "get_tokens", "list_tokens"], "args": {"chain_id": "1"}},
        "answer_contains": ["ETH", "18"],
    },
    {
        "id": "wrap-plan-to-wallet",
        "user": f"My wallet account is {ACCOUNT_ID}. Prepare wrapping exactly 0.0001 ETH into WETH on Base and simulate it with my wallet. Do not send.",
        "producer": {
            "tool": ["prepare_wrap_unwrap"],
            "args": {"chain_id": "8453", "sender": SENDER, "direction": "wrap", "amount": "100000000000000"},
        },
        "wallet": {"tool": "wallet_simulate_execution_plan", "chain_id": "8453", "sender": SENDER},
    },
    {
        "id": "swap-plan-to-wallet",
        "user": f"My wallet account is {ACCOUNT_ID}. Sell exactly 0.0001 ETH for USDC on Base with at most 0.3% slippage, then simulate the best executable plan with my wallet. Do not send.",
        "producer": {
            "tool": ["get_quotes_with_plans"],
            "args": {
                "chain_id": "8453",
                "token_in": NATIVE,
                "token_out": BASE_USDC,
                "quote_type": "exact_input",
                "amount": "100000000000000",
                "sender": SENDER,
                "slippage_bps": "30",
            },
        },
        "wallet": {"tool": "wallet_simulate_execution_plan", "chain_id": "8453", "sender": SENDER},
    },
    {
        "id": "pool-reads-to-wallet",
        "user": (
            f"Read the current onchain state of Ekubo pool {ETH_USDC_POOL['pool_id']} on core "
            f"{ETH_USDC_POOL['core_address']} on Ethereum mainnet. Run the pool's prepared state reads "
            "through my wallet's batch eth_call and tell me whether every call succeeded."
        ),
        "producer": {"tool": ["get_pool"], "args": ETH_USDC_POOL},
        "wallet": {"tool": "wallet_batch_eth_call", "chain_id": "1"},
    },
]
FOLLOW_UP = "Yes, go ahead. Use my wallet as described; do not send anything."


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256(value: Any) -> str:
    data = value if isinstance(value, (bytes, str)) else canonical(value)
    return hashlib.sha256(data.encode() if isinstance(data, str) else data).hexdigest()


def keccak256(data: bytes) -> str:
    digest = keccak.new(digest_bits=256)
    digest.update(data)
    return "0x" + digest.hexdigest()


def text_payload(result: dict[str, Any]) -> Any:
    texts = [part.get("text", "") for part in result.get("content", []) if part.get("type") == "text"]
    if not texts:
        return None
    try:
        return json.loads(texts[0])
    except json.JSONDecodeError:
        return texts[0]


def envelopes(value: Any) -> list[dict[str, Any]]:
    """Every artifact_reference envelope inside a parsed tool result."""
    if isinstance(value, list):
        return [found for entry in value for found in envelopes(entry)]
    if not isinstance(value, dict):
        return []
    own = [value] if value.get("kind") == "artifact_reference" else []
    return own + [found for entry in value.values() for found in envelopes(entry)]


def same_value(expected: Any, actual: Any) -> bool:
    if isinstance(expected, str) and expected.startswith("0x") and isinstance(actual, str):
        return expected.lower() == actual.lower()
    if isinstance(actual, dict) and "address" in actual:
        return same_value(expected, actual["address"])
    return str(expected) == str(actual)


async def verify_reference(
    reference: Any, produced: list[dict[str, Any]], chain_id: str, sender: str | None = None
) -> dict[str, Any]:
    """Compare a received reference with the producer's envelope, then check the stored bytes."""
    if not isinstance(reference, dict):
        return {"ok": False, "reason": "no reference object was passed"}
    source = next((env for env in produced if env.get("url") == reference.get("url")), None)
    checks: dict[str, Any] = {
        "matches_producer_envelope": source is not None
        and all(canonical(reference.get(key)) == canonical(source.get(key)) for key in VERIFIED_FIELDS),
        "instruction_retained": source is not None and reference.get("instruction") == source.get("instruction"),
    }
    async with httpx.AsyncClient(timeout=30) as http:
        response = await http.get(str(reference.get("url")))
    body = response.content
    checks["fetch_status"] = response.status_code
    checks["bytes_match"] = len(body) == reference.get("bytes")
    checks["integrity_match"] = keccak256(body) == (reference.get("integrity") or {}).get("value")
    stored = json.loads(body) if response.status_code == 200 else {}
    checks["chain_matches"] = str(stored.get("chain_id")) == chain_id
    if sender is not None:
        checks["sender_matches"] = str(stored.get("sender", "")).lower() == sender.lower()
    required = [key for key, value in checks.items() if key not in ("instruction_retained", "fetch_status")]
    checks["ok"] = response.status_code == 200 and all(checks[key] for key in required)
    return checks


def type_unions(raw: Any, converted: Any, found: dict[str, int]) -> None:
    """Count how each JSON Schema `type` array is represented after conversion."""
    if not isinstance(raw, dict) or not isinstance(converted, dict):
        return
    if isinstance(raw.get("type"), list):
        target = str(converted.get("type")) + (" nullable" if converted.get("nullable") else "")
        key = f"{'|'.join(raw['type'])} -> {target}"
        found[key] = found.get(key, 0) + 1
    for prop, sub in (raw.get("properties") or {}).items():
        type_unions(sub, (converted.get("properties") or {}).get(prop), found)
    type_unions(raw.get("items"), converted.get("items"), found)
    for index, sub in enumerate(raw.get("anyOf") or []):
        branches = converted.get("any_of") or []
        type_unions(sub, branches[index] if index < len(branches) else None, found)


def openapi_subset(tools: list[BaseTool]) -> dict[str, Any]:
    """ADK's pre-JSON-Schema declaration path: the OpenAPI subset Gemini also accepts."""
    report: dict[str, Any] = {"converted": 0, "failed": [], "type_unions": {}}
    for tool in tools:
        schema = getattr(tool.raw_mcp_tool, "input_schema", None) or getattr(tool.raw_mcp_tool, "inputSchema", None)
        try:
            parameters = _to_gemini_schema(schema)
            types.FunctionDeclaration(name=tool.name, description=tool.description, parameters=parameters)
            type_unions(schema, parameters.model_dump(mode="json", exclude_none=True), report["type_unions"])
            report["converted"] += 1
        except Exception as error:  # recorded per tool
            report["failed"].append({"tool": tool.name, "error": redact(f"{type(error).__name__}: {error}")[:300]})
    return report


async def discover(url: str) -> tuple[McpToolset, list[BaseTool], dict[str, Any], str]:
    toolset = McpToolset(connection_params=StreamableHTTPConnectionParams(url=url, timeout=60))
    tools = await toolset.get_tools()
    session = await tools[0]._mcp_session_manager.create_session()
    initialized = session.initialize_result
    instructions = initialized.instructions or ""
    declarations = [tool._get_declaration() for tool in tools]
    types.GenerateContentConfig(tools=[types.Tool(function_declarations=declarations)])
    dumped = [declaration.model_dump(mode="json", exclude_none=True) for declaration in declarations]
    keywords: dict[str, int] = {}

    def census(node: Any) -> None:
        if isinstance(node, dict):
            for key, entry in node.items():
                if key in ("anyOf", "oneOf", "allOf", "const", "enum", "pattern", "$ref", "$defs", "additionalProperties", "default", "format"):
                    keywords[key] = keywords.get(key, 0) + 1
                if key == "type" and isinstance(entry, list):
                    keywords["type[]"] = keywords.get("type[]", 0) + 1
                census(entry)
        elif isinstance(node, list):
            for entry in node:
                census(entry)

    census(dumped)
    report = {
        "protocol_version": session.protocol_version,
        "server_info": initialized.server_info.model_dump(mode="json", exclude_none=True),
        "instructions": {"chars": len(instructions), "sha256": sha256(instructions)},
        "tool_count": len(tools),
        "tool_names": [tool.name for tool in tools],
        "declaration_mode": "parameters_json_schema" if dumped and "parameters_json_schema" in dumped[0] else "parameters",
        "declarations_with_response_schema": sum(1 for entry in dumped if "response_json_schema" in entry),
        "declarations_sha256": sha256(dumped),
        "declarations_chars": len(canonical(dumped)),
        "json_schema_keywords": dict(sorted(keywords.items())),
        "generate_content_config_built": True,
        "openapi_subset_declarations": openapi_subset(tools),
    }
    return toolset, tools, report, instructions


async def direct_calls(tools: list[BaseTool]) -> list[dict[str, Any]]:
    """Representative calls through ADK's own session; each runs only if its tool is listed."""
    session = await tools[0]._mcp_session_manager.create_session()
    listed = {tool.name for tool in tools}

    async def call(name: str, arguments: dict[str, Any]) -> tuple[dict[str, Any], Any]:
        result = _dump_mcp_model(await session.call_tool(name, arguments=arguments))
        return result, text_payload(result)

    async def read_token() -> dict[str, Any]:
        result, parsed = await call("get_token", {"chain_id": "1", "address": NATIVE})
        token = parsed.get("token", {}) if isinstance(parsed, dict) else {}
        parity = parsed == result.get("structuredContent")
        return {
            "ok": not result.get("isError") and parity and token.get("symbol") == "ETH" and token.get("decimals") == 18,
            "text_equals_structured_content": parity,
            "token": {key: token.get(key) for key in ("chain_id", "address", "symbol", "decimals")},
        }

    async def malformed_chain_id() -> dict[str, Any]:
        result, parsed = await call("get_token", {"chain_id": "ethereum", "address": NATIVE})
        message = parsed if isinstance(parsed, str) else canonical(parsed)
        return {"ok": bool(result.get("isError")) and "chain_id" in message, "is_error": bool(result.get("isError")), "message": redact(message)[:400]}

    async def empty_positions_page() -> dict[str, Any]:
        result, parsed = await call("get_positions_by_owner", {"owner": SENDER})
        ok = not result.get("isError") and isinstance(parsed, dict) and parsed.get("positions") == [] and "pagination" in parsed
        return {"ok": ok, "pagination": parsed.get("pagination") if isinstance(parsed, dict) else None}

    async def tampered(envelope: dict[str, Any], chain_id: str, sender: str | None) -> dict[str, bool]:
        """Whether the stand-in check still accepts altered copies (every value must be False)."""
        variants = {
            "integrity": {**envelope, "integrity": {**envelope["integrity"], "value": "0x" + "00" * 32}},
            "bytes": {**envelope, "bytes": envelope["bytes"] + 1},
            "url": {**envelope, "url": envelope["url"].rsplit("/", 1)[0] + "/00000000-0000-4000-8000-000000000000"},
        }
        accepted = {label: (await verify_reference(variant, [envelope], chain_id, sender))["ok"] for label, variant in variants.items()}
        accepted["chain"] = (await verify_reference(envelope, [envelope], "999999", sender))["ok"]
        if sender is not None:
            accepted["sender"] = (await verify_reference(envelope, [envelope], chain_id, NATIVE))["ok"]
        return accepted

    async def reference(name: str, arguments: dict[str, Any], kind: str, sender: str | None) -> dict[str, Any]:
        result, parsed = await call(name, arguments)
        found = [env for env in envelopes(parsed) if env.get("artifact_type") == kind]
        verified = await verify_reference(found[0], found, arguments["chain_id"], sender) if found else {"ok": False}
        altered = await tampered(found[0], arguments["chain_id"], sender) if found else {}
        inline = '"execution_plan":' in canonical(parsed) or '"read_calls":' in canonical(parsed)
        parity = parsed == result.get("structuredContent")
        return {
            "ok": bool(found) and verified["ok"] and not any(altered.values()) and not inline and parity,
            "envelopes": len(found),
            "inline_payload_in_text": inline,
            "text_equals_structured_content": parity,
            "reference": {key: found[0].get(key) for key in ("artifact_type", "bytes")} if found else None,
            "verification": verified,
            "altered_copies_accepted": altered,
        }

    wrap = {"chain_id": "8453", "sender": SENDER, "direction": "wrap", "amount": "100000000000000"}
    checks = (
        ("read-token", "get_token", read_token),
        ("malformed-chain-id", "get_token", malformed_chain_id),
        ("empty-positions-page", "get_positions_by_owner", empty_positions_page),
        ("wrap-plan-reference", "prepare_wrap_unwrap", lambda: reference("prepare_wrap_unwrap", wrap, "execution_plan", SENDER)),
        ("pool-read-reference", "get_pool", lambda: reference("get_pool", ETH_USDC_POOL, "read_calls", None)),
    )
    return [{"id": check_id, "tool": name, **await check()} for check_id, name, check in checks if name in listed]


class WalletStandIn(BaseTool):
    """A Cloud Wallet tool declared from its catalog entry that only verifies references."""

    def __init__(self, entry: dict[str, Any], run: dict[str, Any]):
        super().__init__(name=entry["name"], description=entry["description"])
        self._schema = entry.get("inputSchema") or {"type": "object", "properties": {}}
        self._run = run

    def _get_declaration(self) -> types.FunctionDeclaration:
        return types.FunctionDeclaration(
            name=self.name, description=self.description, parameters_json_schema=self._schema
        )

    async def run_async(self, *, args: dict[str, Any], tool_context: Any) -> Any:
        self._run["wallet_calls"].append({"tool": self.name, "args": args})
        if self.name == "wallet_list":
            return ACCOUNTS
        expected = self._run["scenario"].get("wallet") or {}
        if self.name == "wallet_simulate_execution_plan":
            if args.get("plan") is not None:
                verification = {"ok": False, "reason": "inline plan passed instead of the producer reference"}
            else:
                verification = await verify_reference(
                    args.get("artifact_reference"), self._run["envelopes"], expected.get("chain_id", ""), expected.get("sender")
                )
        else:
            if args.get("calls"):
                verification = {"ok": False, "reason": "inline calls passed instead of the producer reference"}
            else:
                verification = await verify_reference(args.get("reference"), self._run["envelopes"], str(args.get("chain_id")))
        self._run["verifications"].append({"tool": self.name, **verification})
        status = "reference_verified" if verification["ok"] else "reference_rejected"
        return {
            "status": status,
            "verification": verification,
            "note": "Acceptance stand-in: the reference was checked against the producer's stored bytes. Nothing was simulated, signed or sent.",
        }


def strip_structured_content(tool: BaseTool, args: dict[str, Any], tool_context: Any, tool_response: Any) -> Any:
    if not isinstance(tool, McpTool) or not isinstance(tool_response, dict):
        return None
    return {key: value for key, value in tool_response.items() if key not in ("structuredContent", "structured_content")}


def producer_ok(calls: list[dict[str, Any]], expected: dict[str, Any]) -> bool:
    return any(
        call["tool"] in expected["tool"]
        and all(key in call["args"] and same_value(value, call["args"][key]) for key, value in expected["args"].items())
        for call in calls
    )


async def run_scenario(toolset: McpToolset, instructions: str, wallet_entries: list[dict[str, Any]], model: str, scenario: dict[str, Any], text_only: bool) -> dict[str, Any]:
    run: dict[str, Any] = {"scenario": scenario, "wallet_calls": [], "verifications": [], "envelopes": []}
    producer_calls: list[dict[str, Any]] = []

    def record_producer(tool: BaseTool, args: dict[str, Any], tool_context: Any, tool_response: Any) -> Any:
        if isinstance(tool, McpTool):
            producer_calls.append({"tool": tool.name, "args": args, "is_error": bool(isinstance(tool_response, dict) and tool_response.get("isError"))})
            run["envelopes"].extend(envelopes(text_payload(tool_response) if isinstance(tool_response, dict) else None))
        return strip_structured_content(tool, args, tool_context, tool_response) if text_only else None

    agent = LlmAgent(
        name="ekubo_acceptance",
        model=Gemini(model=model, retry_options=types.HttpRetryOptions(attempts=4, initial_delay=5)),
        instruction=lambda _context: instructions,
        tools=[toolset, *[WalletStandIn(entry, run) for entry in wallet_entries]],
        after_tool_callback=record_producer,
    )
    runner = InMemoryRunner(agent=agent, app_name="ekubo_acceptance")
    session = await runner.session_service.create_session(app_name="ekubo_acceptance", user_id="acceptance")
    turns, usage, texts, errors = [], {"prompt": 0, "output": 0, "total": 0}, [], []
    messages = [scenario["user"]]
    started = time.monotonic()
    while messages:
        message = messages.pop(0)
        turns.append(message)
        try:
            async for event in runner.run_async(
                user_id="acceptance", session_id=session.id,
                new_message=types.Content(role="user", parts=[types.Part(text=message)]),
            ):
                if event.usage_metadata:
                    usage["prompt"] += event.usage_metadata.prompt_token_count or 0
                    usage["output"] += event.usage_metadata.candidates_token_count or 0
                    usage["total"] += event.usage_metadata.total_token_count or 0
                for part in (event.content.parts if event.content and event.content.parts else []):
                    if part.text and event.author == agent.name and not part.thought:
                        texts.append(part.text)
        except Exception as error:  # recorded, not raised: one failing scenario must not hide the others
            errors.append(redact(f"{type(error).__name__}: {error}")[:1000])
            break
        wallet = scenario.get("wallet")
        if wallet and len(turns) == 1 and not any(call["tool"] == wallet["tool"] for call in run["wallet_calls"]):
            messages.append(FOLLOW_UP)
    answer = "\n".join(texts)
    reasons = []
    if not producer_ok(producer_calls, scenario["producer"]):
        reasons.append("expected producer call not made with the expected arguments")
    if scenario.get("wallet"):
        handoffs = [entry for entry in run["verifications"] if entry["tool"] == scenario["wallet"]["tool"]]
        if not handoffs:
            reasons.append(f"{scenario['wallet']['tool']} was not called")
        elif not any(entry["ok"] for entry in handoffs):
            reasons.append("no wallet call carried a verified producer reference")
    for needle in scenario.get("answer_contains", []):
        if needle not in answer:
            reasons.append(f"answer does not mention {needle}")
    if errors:
        reasons.append("model run raised an error")
    return {
        "id": scenario["id"],
        "model": model,
        "text_only": text_only,
        "pass": not reasons,
        "reasons": reasons,
        "turns": turns,
        "producer_calls": producer_calls,
        "wallet_calls": run["wallet_calls"],
        "wallet_verifications": run["verifications"],
        "answer": redact(answer)[:2000],
        "usage_tokens": usage,
        "seconds": round(time.monotonic() - started, 1),
        "errors": errors,
    }


def versions() -> dict[str, str]:
    return {
        "python": platform.python_version(),
        **{name: metadata.version(name) for name in ("google-adk", "google-genai", "mcp", "httpx")},
    }


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", default="https://mcp.ekubo.org/mcp/ekubo")
    parser.add_argument("--model", action="append", help="Gemini model; repeatable (default gemini-3.5-flash)")
    parser.add_argument("--wallet-catalog", default=str(ROOT.parent / "cloud-wallet/apps/api/src/reference/tools.json"))
    parser.add_argument("--only", help="comma-separated scenario ids")
    parser.add_argument("--keep-structured-content", action="store_true", help="also give the model structuredContent")
    parser.add_argument("--pause", type=float, default=5.0, help="seconds between model scenarios")
    parser.add_argument("--out", default="gemini-adk-acceptance.json")
    opts = parser.parse_args()

    report: dict[str, Any] = {
        "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "endpoint": opts.url,
        "versions": versions(),
        "client": "google.adk McpToolset over StreamableHTTPConnectionParams",
    }
    toolset, tools, report["discovery"], instructions = await discover(opts.url)
    report["direct_calls"] = await direct_calls(tools)
    has_key = bool(os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY"))
    report["model_runs"] = []
    if not has_key:
        report["model_runs_skipped"] = "GOOGLE_API_KEY or GEMINI_API_KEY is not set"
    else:
        if not Path(opts.wallet_catalog).is_file():
            parser.error(f"--wallet-catalog {opts.wallet_catalog} not found; pass a Cloud Wallet checkout's apps/api/src/reference/tools.json")
        catalog = json.loads(Path(opts.wallet_catalog).read_text())
        wallet_entries = [entry for entry in catalog if entry["name"] in WALLET_TOOLS]
        report["wallet_catalog"] = {"path": opts.wallet_catalog, "tools": [entry["name"] for entry in wallet_entries], "sha256": sha256(wallet_entries)}
        selected = set(opts.only.split(",")) if opts.only else None
        listed = set(report["discovery"]["tool_names"])
        for model in opts.model or ["gemini-3.5-flash"]:
            for scenario in SCENARIOS:
                if (selected and scenario["id"] not in selected) or not listed.intersection(scenario["producer"]["tool"]):
                    continue
                outcome = await run_scenario(toolset, instructions, wallet_entries, model, scenario, not opts.keep_structured_content)
                report["model_runs"].append(outcome)
                print(f"{model} {scenario['id']}: {'pass' if outcome['pass'] else 'FAIL ' + '; '.join(outcome['reasons'])}", file=sys.stderr)
                await asyncio.sleep(opts.pause)
    await toolset.close()
    report["finished_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    report["summary"] = {
        "direct_calls_passed": sum(1 for check in report["direct_calls"] if check["ok"]),
        "direct_calls": len(report["direct_calls"]),
        "model_runs_passed": sum(1 for outcome in report["model_runs"] if outcome["pass"]),
        "model_runs": len(report["model_runs"]),
    }
    write_report(opts.out, report)
    print(json.dumps(report["summary"]), file=sys.stderr)
    failed = report["summary"]["direct_calls_passed"] < report["summary"]["direct_calls"] or (
        report["summary"]["model_runs_passed"] < report["summary"]["model_runs"]
    )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
