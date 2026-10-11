from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WRAPPER = ROOT / "agents" / "lib" / "github-cli.sh"


class GitHubCliWrapperTest(unittest.TestCase):
    def _run_stub(self, extra_env: dict[str, str]) -> dict[str, str]:
        with tempfile.TemporaryDirectory() as temp_dir:
            stub_dir = Path(temp_dir)
            stub = stub_dir / "gh"
            stub.write_text(
                "#!/usr/bin/env bash\n"
                "printf 'GH_TOKEN=%s\\n' \"${GH_TOKEN-<unset>}\"\n"
                "printf 'GITHUB_TOKEN=%s\\n' \"${GITHUB_TOKEN-<unset>}\"\n"
                "printf 'HTTP_PROXY=%s\\n' \"${HTTP_PROXY-<unset>}\"\n"
                "printf 'HTTPS_PROXY=%s\\n' \"${HTTPS_PROXY-<unset>}\"\n"
                "printf 'http_proxy=%s\\n' \"${http_proxy-<unset>}\"\n"
                "printf 'https_proxy=%s\\n' \"${https_proxy-<unset>}\"\n"
            )
            stub.chmod(0o755)
            env = os.environ.copy()
            env.update(
                {
                    "PATH": f"{stub_dir}:{env.get('PATH', '')}",
                    "GH_TOKEN": "ambient-token",
                    "GITHUB_TOKEN": "ambient-token",
                    "HTTP_PROXY": "http://proxy",
                    "HTTPS_PROXY": "http://proxy",
                    "http_proxy": "http://proxy",
                    "https_proxy": "http://proxy",
                }
            )
            env.update(extra_env)
            output = subprocess.check_output([str(WRAPPER), "api", "user"], env=env, text=True)
            return dict(line.split("=", 1) for line in output.splitlines())

    def test_strips_ambient_tokens_and_proxies(self):
        result = self._run_stub({})
        self.assertEqual(result["GH_TOKEN"], "<unset>")
        self.assertEqual(result["GITHUB_TOKEN"], "<unset>")
        for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
            self.assertEqual(result[key], "<unset>")

    def test_passes_only_explicit_token(self):
        result = self._run_stub({"OPENCLAW_GH_TOKEN": "explicit-token"})
        self.assertEqual(result["GH_TOKEN"], "explicit-token")
        self.assertEqual(result["GITHUB_TOKEN"], "<unset>")


if __name__ == "__main__":
    unittest.main()
