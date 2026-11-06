"""Immutable note snapshots and standalone, script-free HTML export."""

import datetime as dt
from html import escape
import json
import secrets

from rich_content import sanitize_markup


def initialize(db):
    db.execute(
        "CREATE TABLE IF NOT EXISTS archives(id TEXT PRIMARY KEY,title TEXT NOT NULL,created TEXT NOT NULL,body TEXT NOT NULL)"
    )


def create(db, title="", now=None):
    now = now or dt.datetime.now()
    notes = [
        dict(json.loads(row["body"]), id=row["id"], updated=row["updated"])
        for row in db.execute("SELECT * FROM notes ORDER BY updated DESC")
    ]
    body = dict(
        notes=notes,
        completions=[dict(row) for row in db.execute("SELECT * FROM completions")],
    )
    archive_id = secrets.token_hex(12)
    title = str(title).strip()[:100] or "总体事项存档 " + now.strftime("%Y-%m-%d %H:%M")
    db.execute(
        "INSERT INTO archives VALUES (?,?,?,?)",
        (
            archive_id,
            title,
            now.isoformat(timespec="seconds"),
            json.dumps(body, ensure_ascii=False),
        ),
    )
    return archive_id


def list_archives(db):
    result = []
    for row in db.execute("SELECT * FROM archives ORDER BY created DESC, id DESC"):
        notes = json.loads(row["body"])["notes"]
        result.append(
            dict(
                id=row["id"],
                title=row["title"],
                created=row["created"],
                count=len(notes),
                hasProtected=any(n.get("private") for n in notes),
            )
        )
    return result


def period(frequency, now):
    if frequency == "monthly":
        return now.strftime("%Y-%m")
    year, week, _ = now.isocalendar()
    return f"{year}-W{week:02d}"


def schedule(db):
    row = db.execute(
        "SELECT value FROM settings WHERE key='archive_schedule'"
    ).fetchone()
    return json.loads(row["value"]) if row else {"frequency": "off", "lastPeriod": ""}


def configure(db, frequency, now=None):
    if frequency not in ("off", "weekly", "monthly"):
        raise ValueError("请选择关闭、每周或每月存档")
    old = schedule(db)
    config = dict(
        frequency=frequency,
        lastPeriod=old.get("lastPeriod", "")
        if old["frequency"] == frequency
        else period(frequency, now or dt.datetime.now()),
    )
    db.execute(
        "INSERT OR REPLACE INTO settings VALUES ('archive_schedule',?)",
        (json.dumps(config),),
    )


def run_scheduled(db, now=None):
    now = now or dt.datetime.now()
    config = schedule(db)
    if config["frequency"] == "off":
        return None
    current = period(config["frequency"], now)
    if config.get("lastPeriod") == current:
        return None
    archive_id = create(db, f"自动总体存档 {current}", now)
    config["lastPeriod"] = current
    db.execute(
        "INSERT OR REPLACE INTO settings VALUES ('archive_schedule',?)",
        (json.dumps(config),),
    )
    return archive_id


def export_html(row, include_private=False):
    data = json.loads(row["body"])
    notes = [n for n in data["notes"] if include_private or not n.get("private")]
    parts = []
    for note in notes:
        images = note.get("images", [])
        if "detailHtml" in note:
            detail = sanitize_markup(note["detailHtml"], images, embed=True)
        else:
            blocks = note.get("detailContent") or (
                [dict(type="text", text=note.get("detail", ""))]
                + [dict(type="image", src=src) for src in images]
            )
            detail = "".join(
                escape(block["text"])
                if block["type"] == "text"
                else f'<img alt="事项插图" src="{escape(block["src"], quote=True)}">'
                for block in blocks
            )
        completed = [
            c["day"] for c in data["completions"] if c["note_id"] == note["id"]
        ]
        repeat = {
            "none": "单次",
            "daily": "每天",
            "weekly": "每周",
            "range": "指定日期范围",
        }.get(note["repeat"], "")
        if note["repeat"] == "weekly":
            repeat += " " + "、".join(
                "周" + "一二三四五六日"[i] for i in note["weekdays"]
            )
        metadata = (
            f"{note.get('category', '未分类')} | {note['date']}"
            + (f" 至 {note['until']}" if note.get("until") else "")
            + f" | {repeat} | {note.get('time', '')}"
            + (f"–{note['end']}" if note.get("end") else "")
        )
        parts.append(
            f'<article><h2>{escape(note["title"])}</h2><p class="meta">{escape(metadata)}</p><div class="body">{detail}</div><p class="meta">已完成日期：{escape("、".join(completed) or "暂无完成记录")}</p></article>'
        )
    title = escape(row["title"])
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>{title} · 拾记</title><style>body{{max-width:1000px;margin:40px auto;padding:0 22px;background:#f4f7fb;color:#243449;font:15px/1.9 system-ui,sans-serif}}h1{{font-size:28px}}article{{background:white;border:1px solid #dce5f2;border-radius:10px;padding:24px;margin:20px 0}}.meta{{font-size:12px;color:#6d809b}}.body{{white-space:pre-wrap;overflow-wrap:anywhere}}img{{display:block;max-width:100%;height:auto;margin:14px 0}}.body h1{{font-size:26px}}.body h2{{font-size:22px}}.body h3{{font-size:18px}}@media print{{body{{background:white}}article{{break-inside:avoid}}}}</style></head><body><h1>{title}</h1><p class="meta">存档时间：{escape(row["created"])} · 本次导出 {len(notes)} 条事项 · {"包含受保护内容，文件未加密" if include_private else "不包含受保护事项"}</p>{"".join(parts) or "<p>本次导出没有可显示的事项。</p>"}<footer class="meta">由拾记导出，图片已内嵌，可离线阅读。存档不会删除当前事项。</footer></body></html>"""
