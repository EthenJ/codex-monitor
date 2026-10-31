"""Opt-in, read-only NVIDIA checks: CODEX_MONITOR_TEST_GPU=1 python -m unittest ..."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "codex-monitor" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from owned_process import run_owned
from watchdog_monitor import gpu_values
from test_regressions import shell_command


@unittest.skipUnless(os.environ.get("CODEX_MONITOR_TEST_GPU") == "1", "opt-in live NVIDIA GPU checks")
class LiveGpuTests(unittest.TestCase):
    def test_real_indices_uuids_and_pci_ids(self):
        inventory = run_owned(["nvidia-smi", "--query-gpu=index,uuid,pci.bus_id",
                               "--format=csv,noheader,nounits"], timeout=10)
        self.assertEqual(inventory.returncode, 0, inventory.stdout)
        devices = [tuple(part.strip() for part in row.split(",")) for row in inventory.stdout.splitlines()]
        self.assertTrue(devices)
        self.assertEqual(set(gpu_values("all")), {device[0] for device in devices})
        for index, uuid, pci in devices:
            for selector in (index, uuid, pci):
                with self.subTest(selector=selector):
                    values = gpu_values(selector)
                    self.assertEqual(set(values), {index})
                    self.assertTrue(0 <= values[index] <= 100)

    def test_real_partial_selection_cannot_pass(self):
        index = next(iter(gpu_values("all")))
        # Drivers may reject the whole query, or return a successful partial
        # result which our identity validation must reject. Both are unknown.
        with self.assertRaises((ValueError, RuntimeError)):
            gpu_values(f"{index},999999")

    def monitor(self, *args):
        result = subprocess.run([sys.executable, str(SCRIPTS / "watchdog_monitor.py"),
                                 "--gpu-util-below", "100", "--gpu-id", "all", "--gpu-match", "any",
                                 "--gpu-below-for-ms", "1", "--gpu-sample-ms", "100",
                                 "--watchdog-only", "--timeout-ms", "3000", *args],
                                capture_output=True, text=True, encoding="utf-8", timeout=10)
        records = [json.loads(line) for line in result.stdout.splitlines()]
        return result, records

    def test_real_sampling_and_dry_run(self):
        result, records = self.monitor("--codex-thread", "test", "--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertFalse(any(record.get("event_type") == "monitor_error" for record in records))
        self.assertEqual(records[-1]["reason"], "deadline")

    def test_real_low_utilization_delivers_callback(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "payload.json"
            source = "import sys,pathlib; pathlib.Path(sys.argv[1]).write_text(sys.stdin.read(),encoding='utf-8')"
            result, records = self.monitor("--max-events", "1", "--callback-command",
                                            shell_command([sys.executable, "-c", source, str(target)]))
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            if not target.exists():
                self.skipTest("all cards remained at 100%; no live low-utilization edge available")
            payload = json.loads(target.read_text(encoding="utf-8"))
            self.assertEqual(payload["event_type"], "watchdog_stalled")
            self.assertTrue(payload["conditions"]["gpu_low"]["utilization"])
            self.assertTrue(any(record["type"] == "callback" and record["ok"] for record in records))


if __name__ == "__main__":
    unittest.main()
