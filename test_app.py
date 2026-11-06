import datetime as dt
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.request
import urllib.error

import app


class NotesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.visibility_token = ""
        self.old_data = app.DATA
        app.DATA = Path(self.temp.name)
        app.init_db()
        self.server = app.ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        self.server.token, self.server.lan = "test-secret", False
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        app.DATA = self.old_data
        self.temp.cleanup()

    def request(
        self, path, body=None, auth=True, privacy_token=None, visibility_token=None
    ):
        headers = {"Content-Type": "application/json"}
        if auth:
            headers["Cookie"] = "shiji=test-secret"
        if privacy_token:
            headers["X-Privacy-Token"] = privacy_token
        visible_token = (
            self.visibility_token if visibility_token is None else visibility_token
        )
        if visible_token:
            headers["X-Visibility-Token"] = visible_token
        req = urllib.request.Request(
            self.url + "/api/" + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers=headers,
        )
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)

    def enable_visibility(self, password="secret123"):
        code, result = self.request("privacy/visibility/open", {"password": password})
        self.assertEqual(code, 200)
        self.visibility_token = result["visibilityToken"]

    def test_shutdown_requires_authenticated_local_request(self):
        self.assertEqual(self.request("shutdown", {}, auth=False)[0], 401)
        self.assertEqual(self.request("shutdown", {})[0], 200)

    def note(self, **kw):
        return dict(
            title="项目评审",
            detail="带设计图",
            category="工作",
            date="2026-11-05",
            repeat="daily",
            weekdays=[],
            time="09:00",
            end="10:00",
            remind=True,
            images=[],
            **kw,
        )

    def test_crud_completion_and_conflict(self):
        self.assertEqual(self.request("save", self.note())[0], 200)
        note = self.request("state")[1]["notes"][0]
        self.assertEqual(
            self.request("complete", dict(id=note["id"], day="2026-11-05", done=True))[
                0
            ],
            200,
        )
        state = self.request("state")[1]
        self.assertEqual(len(state["completions"]), 1)
        self.assertFalse(any(x["day"] == "2026-11-06" for x in state["completions"]))
        self.assertEqual(self.request("save", dict(note, title="更新"))[0], 200)
        self.assertEqual(self.request("save", dict(note, title="过期修改"))[0], 409)
        self.assertEqual(self.request("delete", dict(id=note["id"]))[0], 200)
        self.assertEqual(
            self.request("state")[1],
            {
                "notes": [],
                "completions": [],
                "categories": ["工作"],
                "visibility": {"enabled": False, "remainingSeconds": 0},
            },
        )

    def test_category_registry_reuses_names_and_includes_private_categories(self):
        self.assertEqual(self.request("categories", {"name": "研发工作"})[0], 200)
        self.assertEqual(self.request("categories", {"name": "  研发工作  "})[0], 200)
        self.assertEqual(self.request("categories", {"name": ""})[0], 400)
        self.request("save", dict(self.note(), category="会议"))
        nid = self.request("state")[1]["notes"][0]["id"]
        self.request("delete", {"id": nid})
        self.assertEqual(self.request("state")[1]["categories"], ["会议", "研发工作"])
        self.request("privacy/password", {"newPassword": "secret123"})
        self.request("save", dict(self.note(), private=True, category="私有分类"))
        self.assertIn("私有分类", self.request("state")[1]["categories"])

    def test_privacy_defaults_password_and_redaction(self):
        self.assertEqual(self.request("privacy/settings")[1], {"configured": False})
        self.assertEqual(self.request("save", self.note())[0], 200)
        self.assertFalse(self.request("state")[1]["notes"][0]["private"])
        self.assertEqual(self.request("save", dict(self.note(), private=True))[0], 403)
        self.assertEqual(
            self.request("privacy/password", {"newPassword": "abc"})[0], 400
        )
        self.assertEqual(
            self.request("privacy/password", {"newPassword": "secret123"})[0], 200
        )
        self.enable_visibility()
        self.assertNotIn("secret123", json.dumps(app.privacy_config()))
        self.request(
            "save",
            dict(
                self.note(),
                title="Visible name",
                detail="HIDDEN BODY",
                category="Visible category",
                images=["data:image/png;base64,iVBORw0KGgo="],
                private=True,
            ),
        )
        state = self.request("state")[1]
        summary = next(n for n in state["notes"] if n["private"])
        self.assertEqual(summary["title"], "Visible name")
        self.assertEqual(summary["category"], "Visible category")
        self.assertEqual(summary["images"], [])
        self.assertNotIn("HIDDEN", json.dumps(state))
        self.assertNotIn("iVBOR", json.dumps(state))
        self.assertEqual(summary["time"], "")
        self.assertEqual(
            self.request("privacy/open", {"id": summary["id"], "password": "wrong"})[0],
            403,
        )
        code, unlocked = self.request(
            "privacy/open", {"id": summary["id"], "password": "secret123"}
        )
        self.assertEqual(code, 200)
        self.assertEqual(unlocked["note"]["detail"], "HIDDEN BODY")
        self.assertNotIn("HIDDEN", json.dumps(self.request("state")[1]))

    def test_private_write_grants_scope_close_and_password_change(self):
        self.request("privacy/password", {"newPassword": "secret123"})
        self.enable_visibility()
        self.request("save", dict(self.note(), private=True))
        summary = self.request("state")[1]["notes"][0]
        nid = summary["id"]
        self.assertEqual(self.request("delete", {"id": nid})[0], 403)
        self.assertEqual(
            self.request("complete", dict(id=nid, day="2026-11-05", done=True))[0], 403
        )
        unlocked = self.request("privacy/open", {"id": nid, "password": "secret123"})[1]
        token = unlocked["accessToken"]
        modified = dict(unlocked["note"], detail="new secret")
        self.assertEqual(self.request("save", modified)[0], 403)
        self.assertEqual(self.request("save", modified, privacy_token=token)[0], 200)
        self.assertEqual(
            self.request(
                "complete",
                dict(id=nid, day="2026-11-05", done=True),
                privacy_token=token,
            )[0],
            200,
        )
        self.assertEqual(self.request("state")[1]["completions"], [])
        self.request("privacy/close", {}, privacy_token=token)
        self.assertEqual(
            self.request("delete", {"id": nid}, privacy_token=token)[0], 403
        )
        token = self.request("privacy/open", {"id": nid, "password": "secret123"})[1][
            "accessToken"
        ]
        self.assertEqual(
            self.request(
                "privacy/password",
                {"currentPassword": "wrong", "newPassword": "updated123"},
            )[0],
            403,
        )
        self.assertEqual(
            self.request(
                "privacy/password",
                {"currentPassword": "secret123", "newPassword": "updated123"},
            )[0],
            200,
        )
        self.assertEqual(
            self.request("delete", {"id": nid}, privacy_token=token)[0], 403
        )
        self.assertEqual(
            self.request("privacy/open", {"id": nid, "password": "secret123"})[0], 403
        )
        self.enable_visibility("updated123")
        self.assertEqual(
            self.request("privacy/open", {"id": nid, "password": "updated123"})[0], 200
        )

    def test_private_reminder_and_rate_limit(self):
        self.request("privacy/password", {"newPassword": "secret123"})
        self.enable_visibility()
        self.request("save", dict(self.note(), title="Private name", private=True))
        self.assertEqual(
            app.due_alerts(dt.datetime(2026, 11, 5, 10)),
            ["有一项受保护事项到时，请在应用中验证查看"] * 2,
        )
        nid = self.request("state")[1]["notes"][0]["id"]
        for _ in range(5):
            self.request("privacy/open", {"id": nid, "password": "wrong"})
        code, result = self.request(
            "privacy/open", {"id": nid, "password": "secret123"}
        )
        self.assertEqual(code, 403)
        self.assertIn("一分钟", result["error"])

    def test_visibility_gate_default_close_scope_and_fifteen_minute_expiry(self):
        self.request("privacy/password", {"newPassword": "secret123"})
        self.request("save", dict(self.note(), title="Hidden title", private=True))
        locked = self.request("state")[1]
        self.assertEqual(locked["notes"], [])
        self.assertFalse(locked["visibility"]["enabled"])
        self.assertEqual(
            self.request("privacy/visibility/open", {"password": "wrong"})[0], 403
        )
        self.enable_visibility()
        visible = self.request("state")[1]
        self.assertEqual(visible["notes"][0]["title"], "Hidden title")
        self.assertTrue(visible["visibility"]["enabled"])
        self.assertLessEqual(visible["visibility"]["remainingSeconds"], 900)
        self.assertEqual(self.request("state", visibility_token="")[1]["notes"], [])
        nid = visible["notes"][0]["id"]
        self.assertEqual(
            self.request(
                "privacy/open",
                {"id": nid, "password": "secret123"},
                visibility_token="",
            )[0],
            403,
        )
        expiry = app.VISIBILITY_GRANTS[self.visibility_token][2]
        with patch.object(app.time, "monotonic", return_value=expiry - 450):
            self.assertAlmostEqual(
                self.request("state")[1]["visibility"]["remainingSeconds"], 450
            )
        with patch.object(app.time, "monotonic", return_value=expiry + 1):
            self.assertEqual(self.request("state")[1]["notes"], [])
            self.assertFalse(self.request("state")[1]["visibility"]["enabled"])
        self.enable_visibility()
        grant = self.request("privacy/open", {"id": nid, "password": "secret123"})[1][
            "accessToken"
        ]
        self.request("privacy/visibility/close", {})
        self.assertEqual(self.request("state")[1]["notes"], [])
        self.assertEqual(
            self.request("delete", {"id": nid}, privacy_token=grant)[0], 403
        )

    def test_rich_text_sanitizes_markup_and_retains_formatting(self):
        image = "data:image/png;base64,iVBORw0KGgo="
        body = dict(
            self.note(),
            images=[image],
            detailHtml='<h2 onclick="bad()">会议事项</h2><p><b>重点</b>与正文<img data-image-index="0" onerror="bad()"><script>bad()</script><img src="https://example.invalid/private.png"></p>',
        )
        self.assertEqual(self.request("save", body)[0], 200)
        markup = self.request("state")[1]["notes"][0]["detailHtml"]
        self.assertIn("<h2>会议事项</h2>", markup)
        self.assertIn("<strong>重点</strong>", markup)
        self.assertIn('data-image-index="0"', markup)
        self.assertNotIn("bad()", markup)
        self.assertNotIn("https://", markup)

    def test_archive_snapshot_is_independent_and_exports_offline_html(self):
        image = "data:image/png;base64,iVBORw0KGgo="
        body = dict(
            self.note(),
            title="Archived <meeting>",
            detail="Before change",
            images=[image],
            detailHtml='<h1>会议标题</h1><p><strong>Before change</strong></p><img data-image-index="0">',
        )
        self.request("save", body)
        note = self.request("state")[1]["notes"][0]
        archive_id = self.request("archives/create", {})[1]["id"]
        self.request(
            "save", dict(note, detail="After change", detailHtml="<p>After change</p>")
        )
        exported = self.request("archives/export", {"id": archive_id})[1]["html"]
        self.assertIn("Before change", exported)
        self.assertNotIn("After change", exported)
        self.assertIn("Archived &lt;meeting&gt;", exported)
        self.assertIn("<h1>会议标题</h1>", exported)
        self.assertIn("data:image/png;base64,", exported)
        self.assertIn("Content-Security-Policy", exported)
        self.assertEqual(len(self.request("state")[1]["notes"]), 1)
        self.assertEqual(self.request("archives")[1]["archives"][0]["count"], 1)

    def test_archive_protected_export_requires_both_display_and_password(self):
        self.request("privacy/password", {"newPassword": "secret123"})
        self.request(
            "save",
            dict(
                self.note(),
                title="Protected archive name",
                detail="Protected archive body",
                private=True,
            ),
        )
        archive_id = self.request("archives/create", {})[1]["id"]
        public_html = self.request("archives/export", {"id": archive_id})[1]["html"]
        self.assertNotIn("Protected archive", public_html)
        self.assertEqual(
            self.request(
                "archives/export",
                {"id": archive_id, "includePrivate": True, "password": "secret123"},
            )[0],
            403,
        )
        self.enable_visibility()
        self.assertEqual(
            self.request(
                "archives/export",
                {"id": archive_id, "includePrivate": True, "password": "wrong"},
            )[0],
            403,
        )
        code, result = self.request(
            "archives/export",
            {"id": archive_id, "includePrivate": True, "password": "secret123"},
        )
        self.assertEqual(code, 200)
        self.assertIn("Protected archive body", result["html"])

    def test_scheduled_archives_once_per_month_or_week(self):
        with app.connect() as db:
            app.archives.configure(db, "monthly", dt.datetime(2026, 11, 6))
            self.assertIsNone(app.archives.run_scheduled(db, dt.datetime(2026, 11, 30)))
            self.assertIsNotNone(
                app.archives.run_scheduled(db, dt.datetime(2026, 12, 1))
            )
            self.assertIsNone(app.archives.run_scheduled(db, dt.datetime(2026, 12, 2)))
            app.archives.configure(db, "weekly", dt.datetime(2026, 12, 28))
            self.assertIsNone(app.archives.run_scheduled(db, dt.datetime(2027, 1, 3)))
            self.assertIsNotNone(
                app.archives.run_scheduled(db, dt.datetime(2027, 1, 4))
            )
            self.assertEqual(len(app.archives.list_archives(db)), 2)
            app.archives.configure(db, "off")
            self.assertIsNone(app.archives.run_scheduled(db, dt.datetime(2028, 1, 1)))

    def test_recurrence(self):
        note = self.note()
        note["repeat"], note["weekdays"] = "weekly", [0, 3]
        self.assertTrue(app.occurs(note, dt.date(2026, 11, 5)))
        self.assertFalse(app.occurs(note, dt.date(2026, 11, 6)))
        self.assertFalse(app.occurs(note, dt.date(2026, 11, 2)))
        note["repeat"] = "none"
        self.assertTrue(app.occurs(note, dt.date(2026, 11, 5)))
        self.assertFalse(app.occurs(note, dt.date(2026, 11, 12)))

    def test_alerts_persist_dedupe_and_completed(self):
        self.request("save", self.note())
        self.assertEqual(len(app.due_alerts(dt.datetime(2026, 11, 5, 8))), 0)
        self.assertEqual(len(app.due_alerts(dt.datetime(2026, 11, 5, 9))), 1)
        self.assertEqual(len(app.due_alerts(dt.datetime(2026, 11, 5, 9, 1))), 0)
        self.assertEqual(len(app.due_alerts(dt.datetime(2026, 11, 5, 10))), 1)
        n = self.request("state")[1]["notes"][0]
        self.request("complete", dict(id=n["id"], day="2026-11-06", done=True))
        self.assertEqual(app.due_alerts(dt.datetime(2026, 11, 6, 10)), [])
        self.assertEqual(len(app.due_alerts(dt.datetime(2026, 11, 7, 10))), 2)

    def test_date_range_inclusive_and_validation(self):
        body = dict(self.note(), date="2026-08-01", until="2026-08-08", repeat="range")
        self.assertEqual(self.request("save", body)[0], 200)
        note = self.request("state")[1]["notes"][0]
        for day in range(1, 9):
            self.assertTrue(app.occurs(note, dt.date(2026, 8, day)))
        self.assertFalse(app.occurs(note, dt.date(2026, 7, 31)))
        self.assertFalse(app.occurs(note, dt.date(2026, 8, 9)))
        self.assertEqual(
            self.request("complete", dict(id=note["id"], day="2026-08-08", done=True))[
                0
            ],
            200,
        )
        self.assertEqual(
            self.request("complete", dict(id=note["id"], day="2026-08-09", done=True))[
                0
            ],
            400,
        )
        self.assertEqual(self.request("save", dict(body, until=""))[0], 400)
        self.assertEqual(self.request("save", dict(body, until="2026-07-31"))[0], 400)
        self.assertEqual(self.request("save", dict(body, until=body["date"]))[0], 200)

    def test_bounded_weekly_and_legacy_schedules(self):
        body = dict(
            self.note(),
            date="2026-08-01",
            until="2026-08-08",
            repeat="weekly",
            weekdays=[5],
        )
        self.assertEqual(self.request("save", body)[0], 200)
        note = self.request("state")[1]["notes"][0]
        self.assertTrue(app.occurs(note, dt.date(2026, 8, 1)))
        self.assertTrue(app.occurs(note, dt.date(2026, 8, 8)))
        self.assertFalse(app.occurs(note, dt.date(2026, 8, 15)))
        self.assertEqual(
            self.request("save", dict(body, until="2026-08-02", weekdays=[0]))[0], 400
        )
        legacy = self.note()
        self.assertTrue(app.occurs(legacy, dt.date(2027, 1, 1)))
        self.assertEqual(self.request("save", legacy)[0], 200)

    def test_date_range_reminders_stop_after_end(self):
        self.request(
            "save",
            dict(self.note(), date="2026-08-01", until="2026-08-08", repeat="range"),
        )
        self.assertEqual(app.due_alerts(dt.datetime(2026, 7, 31, 10)), [])
        self.assertEqual(len(app.due_alerts(dt.datetime(2026, 8, 1, 10))), 2)
        self.assertEqual(len(app.due_alerts(dt.datetime(2026, 8, 8, 10))), 2)
        self.assertEqual(app.due_alerts(dt.datetime(2026, 8, 9, 10)), [])

    def test_mixed_content_roundtrip_and_validation(self):
        image = "data:image/png;base64,iVBORw0KGgo="
        blocks = [
            {"type": "text", "text": "图片前\n"},
            {"type": "image", "src": image},
            {"type": "text", "text": "\n图片后 <script>literal</script>"},
        ]
        self.assertEqual(
            self.request("save", dict(self.note(), detailContent=blocks))[0], 200
        )
        note = self.request("state")[1]["notes"][0]
        self.assertEqual(note["detailContent"], blocks)
        self.assertEqual(note["images"], [image])
        self.assertEqual(note["detail"], "图片前\n\n图片后 <script>literal</script>")
        self.assertEqual(
            self.request(
                "save",
                dict(
                    self.note(), detailContent=[{"type": "html", "text": "<script/>"}]
                ),
            )[0],
            400,
        )
        self.assertEqual(
            self.request(
                "save",
                dict(
                    self.note(),
                    detailContent=[{"type": "image", "src": "javascript:alert(1)"}],
                ),
            )[0],
            400,
        )
        self.assertEqual(
            self.request(
                "save",
                dict(self.note(), detailContent=[{"type": "image", "src": image}] * 7),
            )[0],
            400,
        )

    def test_auth_validation_and_images(self):
        self.assertEqual(self.request("state", auth=False)[0], 401)
        self.assertEqual(self.request("login", {"token": "wrong"}, auth=False)[0], 401)
        self.assertEqual(
            self.request("login", {"token": "test-secret"}, auth=False)[0], 200
        )
        self.assertEqual(self.request("save", dict(self.note(), end="08:00"))[0], 400)
        self.assertEqual(
            self.request("save", dict(self.note(), repeat="weekly"))[0], 400
        )
        self.assertEqual(
            self.request(
                "save", dict(self.note(), images=["data:text/html;base64,AAAA"])
            )[0],
            400,
        )
        image = "data:image/png;base64,iVBORw0KGgo="
        self.assertEqual(
            self.request("save", dict(self.note(), images=[image]))[0], 200
        )
        self.assertEqual(self.request("state")[1]["notes"][0]["images"], [image])


if __name__ == "__main__":
    unittest.main()
