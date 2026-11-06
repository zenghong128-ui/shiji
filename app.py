"""拾记：本地 SQLite、桌面窗口和可选局域网访问，无第三方依赖。"""

import argparse
import archives
from rich_content import sanitize_markup
import ctypes
from contextlib import contextmanager
import datetime as dt
import hmac
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parent
DEFAULT_DATA = (
    (Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Shiji")
    if getattr(sys, "frozen", False)
    else ROOT / "data"
)
DATA = Path(os.environ.get("SHIJI_DATA", str(DEFAULT_DATA)))
LOCK = threading.RLock()
PRIVACY_GRANTS = {}
PRIVACY_FAILURES = {}
VISIBILITY_GRANTS = {}


def visibility_remaining(handler):
    grant = VISIBILITY_GRANTS.get(handler.headers.get("X-Visibility-Token", ""))
    config = privacy_config()
    if not grant or not config or grant[:2] != (str(DATA), config["hash"]):
        return 0
    return max(0, min(900, grant[2] - time.monotonic()))


class PrivacyError(Exception):
    pass


def privacy_config():
    with connect() as db:
        row = db.execute("SELECT value FROM settings WHERE key='privacy'").fetchone()
    return json.loads(row["value"]) if row else None


def check_password(password, client):
    key = (str(DATA), client)
    with LOCK:
        failures = [
            t for t in PRIVACY_FAILURES.get(key, []) if time.monotonic() - t < 60
        ]
        if len(failures) >= 5:
            raise PrivacyError("尝试次数过多，请一分钟后再试")
        config = privacy_config()
        digest = (
            hashlib.pbkdf2_hmac(
                "sha256", str(password).encode(), bytes.fromhex(config["salt"]), 600000
            ).hex()
            if config
            else ""
        )
        if not config or not hmac.compare_digest(digest, config["hash"]):
            PRIVACY_FAILURES[key] = failures + [time.monotonic()]
            raise PrivacyError("隐私密码不正确")
        PRIVACY_FAILURES.pop(key, None)
        return config


def require_private_access(handler, note_id):
    if not visibility_remaining(handler):
        raise PrivacyError("显示开关已关闭，请验证密码后重新开启")
    grant = PRIVACY_GRANTS.get(handler.headers.get("X-Privacy-Token", ""))
    config = privacy_config()
    if (
        not grant
        or not config
        or grant[:3] != (str(DATA), note_id, config["hash"])
        or grant[3] < time.monotonic()
    ):
        raise PrivacyError("请重新输入隐私密码后操作")


@contextmanager
def connect():
    DATA.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DATA / "notes.db", timeout=15)
    db.row_factory = sqlite3.Row
    try:
        with db:
            yield db
    finally:
        db.close()


def init_db():
    with connect() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY, body TEXT NOT NULL, updated TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS completions(note_id TEXT, day TEXT, PRIMARY KEY(note_id,day));
        CREATE TABLE IF NOT EXISTS alerts(key TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS categories(name TEXT PRIMARY KEY);
        """)
        archives.initialize(db)
        for row in db.execute("SELECT body FROM notes"):
            note = json.loads(row["body"])
            db.execute(
                "INSERT OR IGNORE INTO categories VALUES (?)",
                (note.get("category") or "未分类",),
            )


def occurs(note, day):
    if note["repeat"] == "none":
        return note["date"] == day.isoformat()
    if day.isoformat() < note["date"]:
        return False
    if note.get("until") and day.isoformat() > note["until"]:
        return False
    return note["repeat"] in ("daily", "range") or day.weekday() in note["weekdays"]


def validate(body):
    if not isinstance(body, dict):
        raise ValueError("事项格式不正确")
    title = str(body.get("title", "")).strip()
    if not title or len(title) > 160:
        raise ValueError("请填写名称，最多160字")
    date = dt.date.fromisoformat(str(body.get("date", ""))).isoformat()
    repeat = body.get("repeat", "none")
    if repeat not in ("none", "daily", "weekly", "range"):
        raise ValueError("重复方式不正确")
    until = str(body.get("until") or "") if repeat != "none" else ""
    if repeat == "range" and not until:
        raise ValueError("请选择日期范围的结束日期")
    if until:
        until = dt.date.fromisoformat(until).isoformat()
        if until < date:
            raise ValueError("结束日期不能早于开始日期")
    weekdays = body.get("weekdays", [])
    if not isinstance(weekdays, list) or any(
        type(x) is not int or x not in range(7) for x in weekdays
    ):
        raise ValueError("星期不正确")
    if repeat == "weekly" and not weekdays:
        raise ValueError("请至少选择一个星期")
    if repeat == "weekly" and until:
        start_day = dt.date.fromisoformat(date)
        span = min(7, (dt.date.fromisoformat(until) - start_day).days + 1)
        if not any(
            (start_day + dt.timedelta(days=i)).weekday() in weekdays
            for i in range(span)
        ):
            raise ValueError("所选日期范围内没有勾选的星期，请调整日期或星期")
    start, end = str(body.get("time", "")), str(body.get("end", ""))
    for value in (start, end):
        if value:
            dt.time.fromisoformat(value)
            if len(value) != 5:
                raise ValueError("时间格式应为时:分")
    if end and (not start or end <= start):
        raise ValueError("结束时间必须晚于开始时间；跨天事项请分开记录")
    if body.get("remind") and not start:
        raise ValueError("开启提醒时请设置时间")
    content = body.get("detailContent")
    if content is not None:
        if not isinstance(content, list) or len(content) > 1000:
            raise ValueError("详细信息格式不正确")
        normalized = []
        for block in content:
            if not isinstance(block, dict):
                raise ValueError("详细信息格式不正确")
            if block.get("type") == "text" and isinstance(block.get("text"), str):
                normalized.append(dict(type="text", text=block["text"]))
            elif block.get("type") == "image" and isinstance(block.get("src"), str):
                normalized.append(dict(type="image", src=block["src"]))
            else:
                raise ValueError("详细信息仅支持文字和图片")
        detail = "".join(b["text"] for b in normalized if b["type"] == "text")
        if len(detail) > 20000:
            raise ValueError("详细信息最多20000字")
        images = [b["src"] for b in normalized if b["type"] == "image"]
    else:
        detail = str(body.get("detail", ""))[:20000]
        images = body.get("images", [])
    if not isinstance(images, list) or len(images) > 6:
        raise ValueError("每条事项最多6张图片")
    for img in images:
        if (
            not isinstance(img, str)
            or len(img) > 4_000_000
            or not img.startswith(
                (
                    "data:image/png;base64,",
                    "data:image/jpeg;base64,",
                    "data:image/webp;base64,",
                    "data:image/gif;base64,",
                )
            )
        ):
            raise ValueError("图片格式或大小不正确")
    note = dict(
        title=title,
        detail=detail,
        private=bool(body.get("private", False)),
        category=str(body.get("category", "未分类")).strip()[:40] or "未分类",
        date=date,
        until=until,
        repeat=repeat,
        weekdays=sorted(set(weekdays)),
        time=start,
        end=end,
        remind=bool(body.get("remind")),
        images=images,
    )
    if content is not None:
        note["detailContent"] = normalized
    if "detailHtml" in body:
        note["detailHtml"] = sanitize_markup(body["detailHtml"], images)
    return note


def snapshot(public=False, show_private=True):
    with connect() as db:
        notes = [
            dict(json.loads(r["body"]), id=r["id"], updated=r["updated"])
            for r in db.execute("SELECT * FROM notes ORDER BY updated DESC")
        ]
        done = [dict(r) for r in db.execute("SELECT * FROM completions")]
        categories = [
            r["name"] for r in db.execute("SELECT name FROM categories ORDER BY name")
        ]
    if public:
        if not show_private:
            notes = [n for n in notes if not n.get("private")]
        private_ids = {n["id"] for n in notes if n.get("private")}
        done = [c for c in done if c["note_id"] not in private_ids]
        notes = [
            dict(
                id=n["id"],
                title=n["title"],
                private=True,
                date=n["date"],
                until=n.get("until", ""),
                repeat=n["repeat"],
                weekdays=n["weekdays"],
                time="",
                end="",
                category=n.get("category") or "未分类",
                detail="",
                images=[],
            )
            if n.get("private")
            else n
            for n in notes
        ]
    return dict(notes=notes, completions=done, categories=categories)


def due_alerts(now):
    state = snapshot()
    done = {(x["note_id"], x["day"]) for x in state["completions"]}
    result = []
    for note in state["notes"]:
        if (
            not note["remind"]
            or not occurs(note, now.date())
            or (note["id"], now.date().isoformat()) in done
        ):
            continue
        for kind, value in [("开始", note["time"]), ("结束", note["end"])]:
            if not value:
                continue
            scheduled = dt.datetime.combine(now.date(), dt.time.fromisoformat(value))
            # 恢复运行后补发当天已到时提醒，数据库去重避免重启重复通知。
            if now < scheduled:
                continue
            key = f"{note['id']}:{scheduled.isoformat()}:{kind}"
            with connect() as db:
                inserted = db.execute(
                    "INSERT OR IGNORE INTO alerts VALUES (?)", (key,)
                ).rowcount
            if inserted:
                result.append(
                    "有一项受保护事项到时，请在应用中验证查看"
                    if note.get("private")
                    else f"{note['title']}\n{kind}时间：{value}\n{note['detail'][:180]}"
                )
    return result


def reminder_loop():
    while True:
        try:
            with LOCK, connect() as db:
                archives.run_scheduled(db)
            alerts = due_alerts(dt.datetime.now())
            if alerts and os.name == "nt":
                message = "\n\n".join(alerts)
                threading.Thread(
                    target=lambda m=message: ctypes.windll.user32.MessageBoxW(
                        0, m, "拾记 · 事项提醒", 0x40 | 0x1000
                    ),
                    daemon=True,
                ).start()
        except Exception:
            import logging

            logging.exception("提醒检查失败")
        time.sleep(15)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, status, value, mime="application/json; charset=utf-8", cookie=None):
        payload = (
            json.dumps(value, ensure_ascii=False).encode()
            if mime.startswith("application/json")
            else value
        )
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(payload)

    def authorized(self):
        from http.cookies import SimpleCookie

        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
            actual = cookie["shiji"].value if "shiji" in cookie else ""
            return hmac.compare_digest(actual, self.server.token)
        except Exception:
            return False

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path.startswith("/api/"):
            if not self.authorized():
                return self.send(401, {"error": "请使用桌面端提供的连接码登录"})
            if path == "/api/state":
                remaining = visibility_remaining(self)
                state = snapshot(public=True, show_private=remaining > 0)
                # Completion rows must never reveal omitted protected records.
                visible_ids = {n["id"] for n in state["notes"]}
                state["completions"] = [
                    c for c in state["completions"] if c["note_id"] in visible_ids
                ]
                state["visibility"] = {
                    "enabled": remaining > 0,
                    "remainingSeconds": remaining,
                }
                return self.send(200, state)
            if path == "/api/archives":
                with connect() as db:
                    return self.send(
                        200,
                        {
                            "archives": archives.list_archives(db),
                            "schedule": archives.schedule(db),
                        },
                    )
            if path == "/api/privacy/settings":
                return self.send(200, {"configured": bool(privacy_config())})
            if path == "/api/connection":
                addresses = sorted(
                    set(socket.gethostbyname_ex(socket.gethostname())[2])
                )
                return self.send(
                    200,
                    dict(
                        lan=self.server.lan,
                        urls=[
                            f"http://{ip}:{self.server.server_port}/#token={self.server.token}"
                            for ip in addresses
                            if not ip.startswith("127.")
                        ],
                        token=self.server.token,
                    ),
                )
            return self.send(404, {"error": "接口不存在"})
        files = {
            "/": ("index.html", "text/html; charset=utf-8"),
            "/app.js": ("app.js", "text/javascript; charset=utf-8"),
            "/enhancements.js": ("enhancements.js", "text/javascript; charset=utf-8"),
            "/detail-editor.js": ("detail-editor.js", "text/javascript; charset=utf-8"),
            "/style.css": ("style.css", "text/css; charset=utf-8"),
        }
        if path not in files:
            return self.send(404, {"error": "页面不存在"})
        file, mime = files[path]
        self.send(200, (ROOT / "static" / file).read_bytes(), mime)

    def do_POST(self):
        try:
            # 防止跨站页面使用本机接口。
            origin = self.headers.get("Origin")
            if origin and origin != "http://" + self.headers.get("Host", ""):
                return self.send(403, {"error": "不允许跨站请求"})
            length = int(self.headers.get("Content-Length", 0))
            if length > 25_000_000 or length < 1:
                return self.send(413, {"error": "请求过大或为空"})
            body = json.loads(self.rfile.read(length))
            path = urllib.parse.urlsplit(self.path).path
            if path == "/api/login":
                if not hmac.compare_digest(
                    str(body.get("token", "")), self.server.token
                ):
                    return self.send(401, {"error": "连接码不正确"})
                return self.send(
                    200,
                    {"ok": True},
                    cookie=f"shiji={self.server.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000",
                )
            if not self.authorized():
                return self.send(401, {"error": "请先连接"})
            if path == "/api/shutdown":
                if self.client_address[0] not in ("127.0.0.1", "::1"):
                    return self.send(403, {"error": "仅能从本机关闭应用"})
                self.send(200, {"ok": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            if path == "/api/privacy/password":
                with LOCK:
                    if privacy_config():
                        check_password(
                            body.get("currentPassword", ""), self.client_address[0]
                        )
                    password = body.get("newPassword", "")
                    if not isinstance(password, str) or not 6 <= len(password) <= 128:
                        raise ValueError("隐私密码请设置为6至128个字符")
                    salt = secrets.token_bytes(16)
                    config = dict(
                        salt=salt.hex(),
                        hash=hashlib.pbkdf2_hmac(
                            "sha256", password.encode(), salt, 600000
                        ).hex(),
                    )
                    with connect() as db:
                        db.execute(
                            "INSERT OR REPLACE INTO settings VALUES ('privacy',?)",
                            (json.dumps(config),),
                        )
                    PRIVACY_GRANTS.clear()
                    VISIBILITY_GRANTS.clear()
                return self.send(200, {"ok": True})
            if path == "/api/privacy/visibility/open":
                with LOCK:
                    config = check_password(
                        body.get("password", ""), self.client_address[0]
                    )
                    now = time.monotonic()
                    for key in list(VISIBILITY_GRANTS):
                        if VISIBILITY_GRANTS[key][2] <= now:
                            del VISIBILITY_GRANTS[key]
                    token = secrets.token_urlsafe(32)
                    VISIBILITY_GRANTS[token] = (str(DATA), config["hash"], now + 900)
                return self.send(
                    200, {"visibilityToken": token, "remainingSeconds": 900}
                )
            if path == "/api/privacy/visibility/close":
                VISIBILITY_GRANTS.pop(self.headers.get("X-Visibility-Token", ""), None)
                return self.send(200, {"ok": True})
            if path == "/api/privacy/open":
                with LOCK:
                    if not visibility_remaining(self):
                        raise PrivacyError("请先开启显示开关")
                    config = check_password(
                        body.get("password", ""), self.client_address[0]
                    )
                    with connect() as db:
                        row = db.execute(
                            "SELECT * FROM notes WHERE id=?", (body.get("id", ""),)
                        ).fetchone()
                        completed_days = [
                            r["day"]
                            for r in db.execute(
                                "SELECT day FROM completions WHERE note_id=?",
                                (body.get("id", ""),),
                            )
                        ]
                    if not row:
                        raise ValueError("事项已不存在")
                    note = dict(
                        json.loads(row["body"]), id=row["id"], updated=row["updated"]
                    )
                    token = secrets.token_urlsafe(32)
                    now = time.monotonic()
                    for key in list(PRIVACY_GRANTS):
                        if PRIVACY_GRANTS[key][3] < now:
                            del PRIVACY_GRANTS[key]
                    PRIVACY_GRANTS[token] = (
                        str(DATA),
                        note["id"],
                        config["hash"],
                        now + 600,
                    )
                return self.send(
                    200,
                    {
                        "note": note,
                        "accessToken": token,
                        "completedDays": completed_days,
                    },
                )
            if path == "/api/privacy/close":
                PRIVACY_GRANTS.pop(self.headers.get("X-Privacy-Token", ""), None)
                return self.send(200, {"ok": True})
            with LOCK, connect() as db:
                if path == "/api/archives/create":
                    archive_id = archives.create(db, body.get("title", ""))
                    db.commit()
                    return self.send(200, {"ok": True, "id": archive_id})
                elif path == "/api/archives/schedule":
                    archives.configure(db, body.get("frequency", "off"))
                elif path == "/api/archives/export":
                    row = db.execute(
                        "SELECT * FROM archives WHERE id=?", (body.get("id", ""),)
                    ).fetchone()
                    if not row:
                        raise ValueError("存档不存在")
                    include_private = bool(body.get("includePrivate", False))
                    if include_private:
                        if not visibility_remaining(self):
                            raise PrivacyError("请先开启显示开关，再导出受保护内容")
                        check_password(body.get("password", ""), self.client_address[0])
                    return self.send(
                        200,
                        {
                            "filename": "shiji-" + row["id"] + ".html",
                            "html": archives.export_html(row, include_private),
                        },
                    )
                elif path == "/api/categories":
                    name = body.get("name", "")
                    if (
                        not isinstance(name, str)
                        or not name.strip()
                        or len(name.strip()) > 40
                    ):
                        raise ValueError("分类名称请填写1至40个字符")
                    db.execute(
                        "INSERT OR IGNORE INTO categories VALUES (?)", (name.strip(),)
                    )
                elif path == "/api/save":
                    note = validate(body)
                    nid = str(body.get("id") or secrets.token_hex(12))
                    row = db.execute(
                        "SELECT updated,body FROM notes WHERE id=?", (nid,)
                    ).fetchone()
                    if row and json.loads(row["body"]).get("private"):
                        require_private_access(self, nid)
                    if note["private"] and not privacy_config():
                        raise PrivacyError("请先在隐私设置中设置总体隐私密码")
                    if body.get("id") and (
                        not row or row["updated"] != body.get("updated")
                    ):
                        return self.send(
                            409, {"error": "此事项已在其他窗口修改或删除，请刷新后重试"}
                        )
                    updated = dt.datetime.now().isoformat(timespec="microseconds")
                    db.execute(
                        "INSERT OR REPLACE INTO notes VALUES (?,?,?)",
                        (nid, json.dumps(note, ensure_ascii=False), updated),
                    )
                    db.execute(
                        "INSERT OR IGNORE INTO categories VALUES (?)",
                        (note["category"],),
                    )
                elif path == "/api/complete":
                    nid, day = body["id"], body["day"]
                    dt.date.fromisoformat(day)
                    row = db.execute(
                        "SELECT body FROM notes WHERE id=?", (nid,)
                    ).fetchone()
                    if not row or not occurs(
                        json.loads(row["body"]), dt.date.fromisoformat(day)
                    ):
                        raise ValueError("当天没有该事项")
                    if json.loads(row["body"]).get("private"):
                        require_private_access(self, nid)
                    if body["done"]:
                        db.execute(
                            "INSERT OR IGNORE INTO completions VALUES (?,?)", (nid, day)
                        )
                    else:
                        db.execute(
                            "DELETE FROM completions WHERE note_id=? AND day=?",
                            (nid, day),
                        )
                elif path == "/api/delete":
                    row = db.execute(
                        "SELECT body FROM notes WHERE id=?", (body["id"],)
                    ).fetchone()
                    if row and json.loads(row["body"]).get("private"):
                        require_private_access(self, body["id"])
                    db.execute("DELETE FROM notes WHERE id=?", (body["id"],))
                    db.execute("DELETE FROM completions WHERE note_id=?", (body["id"],))
                else:
                    return self.send(404, {"error": "接口不存在"})
            return self.send(200, {"ok": True})
        except PrivacyError as exc:
            self.send(403, {"error": str(exc)})
        except (ValueError, KeyError, TypeError) as exc:
            self.send(400, {"error": str(exc)})
        except Exception:
            import logging

            logging.exception("请求失败")
            self.send(500, {"error": "保存失败，请检查磁盘空间后重试"})


def open_desktop(url):
    edge = (
        Path(os.environ.get("ProgramFiles(x86)", "C:/Program Files (x86)"))
        / "Microsoft/Edge/Application/msedge.exe"
    )
    if edge.exists():
        subprocess.Popen([str(edge), f"--app={url}", "--window-size=1280,860"])
    else:
        import webbrowser

        webbrowser.open(url)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--lan", action="store_true")
    parser.add_argument("--no-window", action="store_true")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--stop", action="store_true", help="关闭本机运行中的拾记后台")
    args = parser.parse_args()
    if args.stop:
        import urllib.request

        try:
            token = (DATA / "connection.key").read_text().strip()
            request = urllib.request.Request(
                f"http://127.0.0.1:{args.port}/api/shutdown",
                data=b"{}",
                headers={
                    "Cookie": f"shiji={token}",
                    "Content-Type": "application/json",
                },
            )
            with urllib.request.urlopen(request, timeout=5):
                pass
        except (OSError, ValueError):
            pass
        return
    init_db()
    import logging

    logging.basicConfig(
        filename=DATA / "app.log", level=logging.WARNING, encoding="utf-8"
    )
    secret = DATA / "connection.key"
    if not secret.exists():
        secret.write_text(secrets.token_urlsafe(32))
    token = secret.read_text().strip()
    url = f"http://127.0.0.1:{args.port}/#token={token}"
    try:
        server = ThreadingHTTPServer(
            ("0.0.0.0" if args.lan else "127.0.0.1", args.port), Handler
        )
    except OSError:
        import urllib.request

        try:
            request = urllib.request.Request(
                f"http://127.0.0.1:{args.port}/api/state",
                headers={"Cookie": f"shiji={token}"},
            )
            with urllib.request.urlopen(request, timeout=3) as response:
                if response.status != 200:
                    raise ValueError("端口已占用")
            if not args.no_window:
                open_desktop(url)
        except Exception:
            logging.exception("启动失败：端口 %s 已被占用", args.port)
            if os.name == "nt" and not args.no_window:
                ctypes.windll.user32.MessageBoxW(
                    0,
                    f"端口 {args.port} 已被其他程序占用，无法启动拾记。",
                    "拾记",
                    0x10,
                )
        return
    server.token, server.lan = token, args.lan
    threading.Thread(target=reminder_loop, daemon=True).start()
    if not args.no_window:
        open_desktop(url)
    if os.name == "nt":

        def hotkey():
            user = ctypes.windll.user32
            if user.RegisterHotKey(None, 1, 0x0002 | 0x0004 | 0x4000, 0x20):
                from ctypes import wintypes

                msg = wintypes.MSG()
                while user.GetMessageW(ctypes.byref(msg), None, 0, 0):
                    if msg.message == 0x0312:
                        open_desktop(url)

        threading.Thread(target=hotkey, daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
