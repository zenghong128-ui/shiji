"""Create fictional screenshot fixtures in a NEW, explicitly supplied directory."""

import argparse
import base64
import datetime as dt
import json
from pathlib import Path
import sys

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app


def artwork(path):
    image = Image.new("RGB", (1000, 480), "#eaf2ff")
    draw = ImageDraw.Draw(image)
    draw.ellipse((765, 50, 850, 135), fill="#f6cf77")
    draw.polygon(
        [(0, 320), (200, 130), (380, 320), (620, 120), (1000, 355)], fill="#b0c9e4"
    )
    draw.polygon(
        [(0, 390), (370, 230), (680, 380), (1000, 250), (1000, 480), (0, 480)],
        fill="#7298a1",
    )
    draw.ellipse((-140, 355, 1150, 850), fill="#b9cdb4")
    draw.polygon([(370, 390), (535, 190), (700, 390)], fill="#f0ba72")
    draw.polygon([(410, 390), (535, 225), (660, 390)], fill="#3567c8")
    draw.line((535, 225, 535, 390), fill="#e9f2ff", width=5)
    draw.rounded_rectangle((35, 25, 355, 85), radius=12, fill="white")
    font_path = Path("C:/Windows/Fonts/msyh.ttc")
    font = (
        ImageFont.truetype(str(font_path), 24)
        if font_path.exists()
        else ImageFont.load_default()
    )
    draw.text((55, 40), "周末去户外 · 示例插图", font=font, fill="#315c9f")
    image.save(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    folder = args.directory.resolve()
    if (folder / "notes.db").exists():
        raise SystemExit("Refusing to overwrite an existing database")
    folder.mkdir(parents=True, exist_ok=True)
    artwork(folder / "camp.png")
    src = (
        "data:image/png;base64,"
        + base64.b64encode((folder / "camp.png").read_bytes()).decode()
    )
    app.DATA = folder
    app.init_db()
    today = dt.date.today()
    first = today.replace(day=1)
    specs = [
        dict(
            title="整理本周读书笔记",
            category="个人成长",
            date=(today - dt.timedelta(days=1)).isoformat(),
            detail="把喜欢的段落整理成三条可实践的想法。",
            time="20:30",
            completed=True,
        ),
        dict(
            title="给阳台绿植浇水",
            category="生活",
            date=(today - dt.timedelta(days=1)).isoformat(),
            detail="检查土壤湿度，给新叶拍一张照片。",
            time="08:00",
        ),
        dict(
            title="周末露营准备",
            category="生活",
            date=today.isoformat(),
            time="18:30",
            end="19:30",
            detailContent=[
                dict(type="text", text="出发前，把小事准备好。\n\n"),
                dict(type="image", src=src),
                dict(
                    type="text",
                    text="\n清单\n□ 帐篷、地垫和照明\n□ 饮水、简餐与垃圾袋\n□ 相机充电，下载离线地图\n\n这是一份虚构的展示笔记。",
                ),
            ],
        ),
        dict(
            title="留十分钟读书",
            category="个人成长",
            date=first.isoformat(),
            repeat="daily",
            time="21:00",
            detail="十分钟也很好，记录今天的一句收获。",
        ),
        dict(
            title="周五回顾与下周计划",
            category="工作",
            date=first.isoformat(),
            repeat="weekly",
            weekdays=[4],
            time="17:30",
            detail="完成了什么？下周最值得推进的一件事是什么？",
        ),
        dict(
            title="七日步行打卡",
            category="生活",
            date=today.isoformat(),
            until=(today + dt.timedelta(days=6)).isoformat(),
            repeat="range",
            time="07:30",
            detail="每天走一小段，留意沿途的变化。",
        ),
        dict(
            title="整理旅行照片",
            category="灵感",
            date=(today + dt.timedelta(days=3)).isoformat(),
            detail="挑选十二张照片，配上当时的心情。",
            time="19:00",
        ),
    ]
    with app.connect() as db:
        for index, spec in enumerate(specs):
            completed = spec.pop("completed", False)
            body = dict(
                title="",
                detail="",
                category="未分类",
                date=today.isoformat(),
                repeat="none",
                weekdays=[],
                time="",
                end="",
                remind=False,
                images=[],
            )
            body.update(spec)
            note = app.validate(body)
            nid = f"demo-{index}"
            db.execute(
                "INSERT INTO notes VALUES (?,?,?)",
                (
                    nid,
                    json.dumps(note, ensure_ascii=False),
                    f"{today}T12:00:{index:02d}",
                ),
            )
            db.execute(
                "INSERT OR IGNORE INTO categories VALUES (?)", (note["category"],)
            )
            if completed:
                db.execute("INSERT INTO completions VALUES (?,?)", (nid, note["date"]))
    print("Fictional demo data created; no reminders enabled.")


if __name__ == "__main__":
    main()
