"""MCP wire tests with the official SDK; skipped without plugin dependencies."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import uuid

SCRIPTS = Path(__file__).resolve().parents[1] / "codex-monitor" / "scripts"


@unittest.skipUnless(importlib.util.find_spec("mcp"), "requires [plugin] dependencies")
class McpTests(unittest.IsolatedAsyncioTestCase):
    async def test_tools_registration_and_survival_across_clients(self):
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw).resolve()
            work = root / "work"
            work.mkdir()
            thread_id = str(uuid.uuid4())
            sys.path.insert(0, str(SCRIPTS))
            from plugin_runtime import ensure_broker, rpc
            # Explicit setup outside the SDK's kill-on-close job object.
            broker = ensure_broker(root / "state")
            first_launcher = rpc(broker, "status")
            self.assertEqual(ensure_broker(root / "state"), broker)
            self.assertEqual(rpc(broker, "status"), first_launcher)
            params = StdioServerParameters(command=sys.executable, args=[str(SCRIPTS / "plugin_server.py")],
                env={**os.environ, "CODEX_MONITOR_HOME": str(root / "state")})
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    names = {t.name for t in (await session.list_tools()).tools}
                    self.assertEqual(names, {"monitor_start", "monitor_status", "monitor_stop", "monitor_wait", "monitor_cancel_wait"})
                    result = await session.call_tool("monitor_start", {"thread_id": thread_id,
                        "name": "cross-client", "kind": "watchdog", "options": {
                            "cwd": str(work), "watch_file": str(work / "metrics"), "timeout_ms": 15000},
                        "instructions": "Fixture only", "notify_on": ["monitor_expired"]})
                    self.assertFalse(result.isError, result)
                    record = result.structuredContent
                    self.assertEqual(record["state"], "armed")
            # Original MCP process has exited. A second MCP client must find the same service.
            try:
                async with stdio_client(params) as (read, write):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        result = await session.call_tool("monitor_status", {"thread_id": thread_id})
                        self.assertFalse(result.isError, result)
                        self.assertEqual(result.structuredContent["monitors"][record["id"]]["state"], "armed")
                        result = await session.call_tool("monitor_stop", {"thread_id": thread_id, "monitor_id": record["id"]})
                        self.assertFalse(result.isError, result)
                        # Synchronize on the service's own stop outcome in a bounded test loop.
                        for _ in range(20):
                            result = await session.call_tool("monitor_status", {"thread_id": thread_id})
                            if result.structuredContent["monitors"][record["id"]]["state"] == "stopped":
                                break
                            await asyncio.sleep(0.05)
                        self.assertEqual(result.structuredContent["monitors"][record["id"]]["outcome"]["reason"], "cancelled")
            finally:
                # Service has no live observers; its idle deadline closes the endpoint.
                # Do not remove its state directory while the service is still running.
                sys.path.insert(0, str(SCRIPTS))
                from plugin_runtime import rpc
                try:
                    rpc(root / "state" / thread_id, "shutdown")
                    rpc(root / "state" / "broker", "shutdown")
                except (RuntimeError, OSError):
                    pass


if __name__ == "__main__":
    unittest.main()
