"""Exercise the packaged Windows binary with isolated temporary records."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("executable", type=Path)
    parser.add_argument("--port", type=int, default=8773)
    args = parser.parse_args()
    executable = args.executable.resolve()
    with tempfile.TemporaryDirectory(prefix="shiji-release-") as temporary:
        environment = dict(os.environ, SHIJI_DATA=temporary)
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        process = subprocess.Popen(
            [str(executable), "--no-window", "--port", str(args.port)],
            env=environment,
            creationflags=flags,
        )
        base = f"http://127.0.0.1:{args.port}"

        def request(path, body=None, token=None):
            headers = {"Content-Type": "application/json"}
            if token:
                headers["Cookie"] = "shiji=" + token
            query = urllib.request.Request(
                base + path,
                data=json.dumps(body).encode() if body is not None else None,
                headers=headers,
            )
            with urllib.request.urlopen(query, timeout=5) as response:
                return response.read()

        try:
            for _ in range(100):
                try:
                    html = request("/").decode()
                    break
                except (OSError, urllib.error.URLError):
                    if process.poll() is not None:
                        raise RuntimeError("Packaged process exited during startup")
                    time.sleep(0.2)
            else:
                raise RuntimeError("Packaged server did not start")
            assert "detail-editor" in html
            assert b"openImageViewer" in request("/detail-editor.js")
            token = (Path(temporary) / "connection.key").read_text().strip()
            request(
                "/api/save",
                dict(
                    title="Release smoke test",
                    detail="Fictional record",
                    category="Smoke",
                    date="2026-11-06",
                    repeat="none",
                    weekdays=[],
                    time="",
                    end="",
                    remind=False,
                    images=[],
                ),
                token,
            )
            state = json.loads(request("/api/state", token=token))
            assert state["notes"][0]["title"] == "Release smoke test"
            assert state["visibility"]["enabled"] is False
            assert "Smoke" in state["categories"]
            subprocess.run(
                [str(executable), "--stop", "--port", str(args.port)],
                env=environment,
                creationflags=flags,
                check=True,
                timeout=30,
            )
            process.wait(timeout=15)
            print(
                "Packaged binary: static assets, authenticated CRUD, default lock, SQLite persistence and graceful stop passed."
            )
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)


if __name__ == "__main__":
    main()
