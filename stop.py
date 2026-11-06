"""兼容原有启动脚本，使用本机认证接口关闭本项目后台。"""

from pathlib import Path
import subprocess
import sys

if __name__ == "__main__":
    subprocess.run(
        [sys.executable, str(Path(__file__).resolve().parent / "app.py"), "--stop"],
        check=False,
    )
