"""Immutable note snapshots and standalone, script-free HTML export."""

import datetime as dt
from html import escape
import json
import secrets
import io
import re
import zipfile
import posixpath
from urllib.parse import quote

from rich_content import sanitize_markup


def initialize(db):
    db.execute(
        "CREATE TABLE IF NOT EXISTS archives(id TEXT PRIMARY KEY,title TEXT NOT NULL,created TEXT NOT NULL,body TEXT NOT NULL)"
    )


def capture(db, title="", now=None):
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
    return dict(
        id=archive_id,
        title=title,
        created=now.isoformat(timespec="seconds"),
        body=json.dumps(body, ensure_ascii=False),
    )


def current_summary(db):
    notes = [json.loads(row["body"]) for row in db.execute("SELECT body FROM notes")]
    return dict(count=len(notes), hasProtected=any(n.get("private") for n in notes))


def create(db, title="", now=None):
    row = capture(db, title, now)
    db.execute(
        "INSERT INTO archives VALUES (?,?,?,?)",
        (row["id"], row["title"], row["created"], row["body"]),
    )
    return row["id"]


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


def export_html(row, include_private=False, single=False):
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
        heading = "" if single else f"<h2>{escape(note['title'])}</h2>"
        parts.append(
            f'<article>{heading}<p class="meta">{escape(metadata)}</p><div class="body">{detail}</div><p class="meta">已完成日期：{escape("、".join(completed) or "暂无完成记录")}</p></article>'
        )
    title = escape(row["title"])
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>{title} · 拾记</title><style>body{{max-width:1000px;margin:40px auto;padding:0 22px;background:#f4f7fb;color:#243449;font:15px/1.9 system-ui,sans-serif}}h1{{font-size:28px}}article{{background:white;border:1px solid #dce5f2;border-radius:10px;padding:24px;margin:20px 0}}.meta{{font-size:12px;color:#6d809b}}.body{{white-space:pre-wrap;overflow-wrap:anywhere}}img{{display:block;max-width:100%;height:auto;margin:14px 0}}.body h1{{font-size:26px}}.body h2{{font-size:22px}}.body h3{{font-size:18px}}@media print{{body{{background:white}}article{{break-inside:avoid}}}}</style></head><body><h1>{title}</h1><p class="meta">存档时间：{escape(row["created"])} · 本次导出 {len(notes)} 条事项 · {"包含受保护内容，文件未加密" if include_private else "不包含受保护事项"}</p>{"".join(parts) or "<p>本次导出没有可显示的事项。</p>"}<footer class="meta">由拾记导出，图片已内嵌，可离线阅读。存档不会删除当前事项。</footer></body></html>"""


def safe_filename(title):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(title)).strip(" .")
    return name[:60].rstrip(" .") or "未命名事项"


def export_directory(row, include_private=False):
    """Return a portable directory manifest; never accept or write a server path."""
    data = json.loads(row["body"])
    notes = [n for n in data["notes"] if include_private or not n.get("private")]
    exported_at = dt.datetime.now().isoformat(timespec="seconds")
    timestamp = exported_at.replace("T", "_").replace(":", "-")
    directory = f"Shiji_导出_{timestamp}_{secrets.token_hex(4)}"
    category_dirs, used_dirs = {}, {"index.html"}
    for note in notes:
        category = note.get("category") or "未分类"
        if category in category_dirs:
            continue
        base = safe_filename(category)
        # Windows device names remain reserved even when followed by an extension.
        if re.fullmatch(r"CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]", base.split(".")[0], re.I):
            base = "_" + base
        name, suffix = base, 2
        while name.casefold() in used_dirs:
            name = f"{base}_{suffix}"
            suffix += 1
        used_dirs.add(name.casefold())
        category_dirs[category] = name
    filenames = [
        f"{category_dirs[n.get('category') or '未分类']}/{i:03d}_{safe_filename(n['title'])}.html"
        for i, n in enumerate(notes, 1)
    ]
    files, entries = [], {}
    for index, note in enumerate(notes):
        single = dict(
            title=note["title"],
            created=row["created"],
            body=json.dumps(
                dict(
                    notes=[note],
                    completions=[
                        c for c in data["completions"] if c["note_id"] == note["id"]
                    ],
                ),
                ensure_ascii=False,
            ),
        )
        folder = posixpath.dirname(filenames[index])
        links = ['<a href="../index.html">返回总目录</a>']
        if index:
            previous = posixpath.relpath(filenames[index - 1], folder)
            links.append(f'<a href="{quote(previous, safe="/")}">上一项</a>')
        if index + 1 < len(notes):
            following = posixpath.relpath(filenames[index + 1], folder)
            links.append(f'<a href="{quote(following, safe="/")}">下一项</a>')
        navigation = (
            '<nav style="display:flex;gap:20px;margin:18px 0">'
            + "".join(links)
            + "</nav>"
        )
        html = export_html(single, include_private, single=True).replace(
            "<body>", "<body>" + navigation, 1
        )
        files.append(dict(name=filenames[index], html=html))
        entries.setdefault(note.get("category") or "未分类", []).append(
            f'<li><a href="{quote(filenames[index], safe="/")}">{escape(note["title"])}</a><p>{escape(note.get("category", "未分类"))} · {escape(note["date"])}</p></li>'
        )
    title = escape(row["title"])
    grouped = "".join(
        f"<section><h2>{escape(category)}（{len(items)}）</h2><ol>{''.join(items)}</ol></section>"
        for category, items in entries.items()
    )
    index_html = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>{title} · 目录</title><style>body{{font:15px/1.8 system-ui,sans-serif;background:#f4f7fb;color:#243449;max-width:1000px;margin:40px auto;padding:0 22px}}h1{{font-size:28px}}ol{{padding:0;list-style:none;counter-reset:notes}}li{{background:white;border:1px solid #dce5f2;border-radius:8px;margin:12px 0;padding:18px 22px}}a{{color:#3567c8;font-size:17px;font-weight:600;overflow-wrap:anywhere}}p{{color:#6d809b;font-size:13px}}</style></head><body><h1>{title}</h1><p>存档时间：{escape(row["created"])} · 共 {len(notes)} 条事项 · {"包含受保护内容，文件未加密" if include_private else "不包含受保护事项"}</p><p>每个事项都是独立 HTML，图片内嵌，可离线阅读。点击名称查看。</p>{grouped}</body></html>"""
    # Write the index last so an interrupted export cannot look like a complete one.
    index_html = index_html.replace(
        "<p>存档时间：", f"<p>导出时间：{exported_at} · 数据时间：", 1
    )
    files.append(dict(name="index.html", html=index_html))
    return dict(
        directory=directory,
        count=len(notes),
        totalCount=len(data["notes"]),
        excludedCount=len(data["notes"]) - len(notes),
        exportedAt=exported_at,
        files=files,
    )


def export_zip(bundle):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as output:
        for item in bundle["files"]:
            output.writestr(
                bundle["directory"] + "/" + item["name"], item["html"].encode("utf-8")
            )
    return buffer.getvalue()
