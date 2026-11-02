import ast
from html import escape
from pathlib import Path
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import releases


def release_response():
    return {
        "tag_name": "v2.3.4", "html_url": releases.REPOSITORY_URL + "/releases/tag/v2.3.4",
        "draft": False, "prerelease": False,
        "assets": [{"name": name, "browser_download_url": releases.REPOSITORY_URL + "/releases/download/v2.3.4/" + name}
                   for name in (releases.WINDOWS_ASSET, releases.MAC_ASSET)],
    }


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        releases._cached = releases.ReleaseInfo()
        releases._expires = 0
        self.clock = mock.patch.object(releases, "monotonic", return_value=1000).start()
        self.request = mock.patch.object(releases.httpx, "get").start()
        self.request.return_value.json.return_value = release_response()
        self.addCleanup(mock.patch.stopall)

    def test_published_version_and_downloads_are_cached_together(self):
        first = releases.latest_release()
        self.assertEqual(first.version, "v2.3.4")
        self.assertIn("/v2.3.4/", first.windows_url)
        self.assertIn("/v2.3.4/", first.mac_url)
        self.assertEqual(releases.latest_release(), first)
        self.request.assert_called_once()

    def test_first_request_failure_does_not_invent_a_version(self):
        self.request.side_effect = releases.httpx.ConnectError("offline")
        self.assertEqual(releases.latest_release().version, "")
        self.assertEqual(releases.latest_release().url, releases.LATEST_RELEASE_URL)
        self.request.assert_called_once()

    def test_outage_preserves_last_known_version_and_its_pinned_downloads(self):
        first = releases.latest_release()
        self.clock.return_value = 1301
        self.request.side_effect = releases.httpx.ConnectError("offline")
        self.assertEqual(releases.latest_release(), first)
        self.assertEqual(releases.latest_release(), first)
        self.assertEqual(self.request.call_count, 2)

    def test_incomplete_or_unpublished_release_is_not_advertised(self):
        for change in ({"assets": []}, {"draft": True}, {"prerelease": True},
                       {"tag_name": None}, {"html_url": "https://example.org/releases/tag/v2.3.4"}):
            with self.subTest(change=change):
                releases._expires = 0
                self.request.return_value.json.return_value = {**release_response(), **change}
                self.assertEqual(releases.latest_release().version, "")

    def test_public_pages_render_the_version_and_matching_downloads(self):
        release = releases.latest_release()
        module = ast.parse(Path(__file__).with_name("main.py").read_text(encoding="utf-8"))
        for name in ("about_page", "download_page"):
            fn = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == name)
            fn.decorator_list = []
            context = {"Request": object, "current_user": lambda request: None,
                       "latest_release": lambda: release, "escape": escape,
                       "HTMLResponse": lambda html: html, "render_page": lambda **kw: kw["body"]}
            exec(compile(ast.Module(body=[fn], type_ignores=[]), "release-page", "exec"), context)
            html = context[name](None)
            self.assertIn("Version v2.3.4", html)
            self.assertIn(release.url, html)
            if name == "download_page":
                self.assertIn(release.windows_url, html)
                self.assertIn(release.mac_url, html)
            else:
                self.assertIn("Paper coming soon.", html)


if __name__ == "__main__":
    unittest.main()
