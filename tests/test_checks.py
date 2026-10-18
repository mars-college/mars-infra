"""Local disposable fixtures only; no Discord credentials, host access, or public requests."""
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, filename):
    loader = importlib.machinery.SourceFileLoader(name, str(ROOT / "bin" / filename))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


http_check = load("http_check", "check-http")
host_check = load("host_check", "check-host")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.server.requests.append(self.path)
        origin = self.server.origin
        routes = {
            "/healthz": (200, {"ok": True, "service": "mars-mcp", "version": "fixture"}, {}),
            "/.well-known/oauth-protected-resource/mcp": (200, {
                "resource": origin + "/mcp", "authorization_servers": [origin],
                "scopes_supported": ["mars.read"], "bearer_methods_supported": ["header"]}, {}),
            "/.well-known/oauth-authorization-server": (200, {
                "issuer": origin, "authorization_endpoint": origin + "/authorize",
                "token_endpoint": origin + "/token", "registration_endpoint": origin + "/register",
                "revocation_endpoint": origin + "/revoke", "response_types_supported": ["code"],
                "code_challenge_methods_supported": ["S256"], "grant_types_supported": ["authorization_code"],
                "token_endpoint_auth_methods_supported": ["none"], "scopes_supported": ["mars.read"]}, {}),
            "/mcp": (401, {}, {"WWW-Authenticate": 'Bearer resource_metadata="' + origin +
                               '/.well-known/oauth-protected-resource/mcp"'}),
        }
        status, body, headers = routes.get(self.path, (404, {}, {}))
        if self.path in self.server.overrides:
            status, body, headers = self.server.overrides[self.path]
        payload = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)


class HttpChecks(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.origin = "http://127.0.0.1:" + str(self.server.server_port)
        self.server.requests = []
        self.server.overrides = {}
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_fixture)

    def close_fixture(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def run_check(self, suffix=""):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = http_check.run(http_check.origin_from_url(self.server.origin + suffix))
        return code, output.getvalue()

    def test_ready_and_only_four_readonly_routes(self):
        code, output = self.run_check("/mcp")
        self.assertEqual(code, 0, output)
        self.assertIn("HTTP READY", output)
        self.assertEqual(self.server.requests, ["/healthz", "/.well-known/oauth-protected-resource/mcp",
                         "/.well-known/oauth-authorization-server", "/mcp"])

    def test_missing_authorization_discovery_is_not_ready(self):
        self.server.overrides["/.well-known/oauth-authorization-server"] = (404, {}, {})
        code, output = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("FAIL authorization discovery: expected HTTP 200, got 404", output)
        self.assertIn("PASS MCP anonymous denial", output)

    def test_redirect_refused_without_followup(self):
        self.server.overrides["/healthz"] = (302, {}, {"Location": self.server.origin + "/do-not-fetch"})
        code, output = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("redirect refused", output)
        self.assertNotIn("/do-not-fetch", self.server.requests)

    def test_unsafe_issuer_not_followed_or_echoed(self):
        secret = "DO-NOT-PRINT-FIXTURE-CONTENT"
        self.server.overrides["/.well-known/oauth-protected-resource/mcp"] = (200, {
            "resource": self.server.origin + "/mcp", "authorization_servers": ["https://example.invalid/" + secret]}, {})
        code, output = self.run_check()
        self.assertEqual(code, 1)
        self.assertNotIn(secret, output)
        self.assertEqual(len(self.server.requests), 4)

    def test_json_and_size_failures_are_bounded_and_private(self):
        for body, expected in ((b"SECRET-not-json", "invalid JSON"), (b"x" * 65537, "exceeds 64 KiB"),
                               ([], "expected JSON object")):
            with self.subTest(expected=expected):
                self.server.overrides["/healthz"] = (200, body, {})
                code, output = self.run_check()
                self.assertEqual(code, 1)
                self.assertIn(expected, output)
                self.assertNotIn("SECRET", output)

    def test_malformed_metadata_and_missing_endpoints_fail_cleanly(self):
        self.server.overrides["/.well-known/oauth-protected-resource/mcp"] = (200, {
            "resource": self.server.origin + "/mcp", "authorization_servers": [self.server.origin],
            "scopes_supported": None}, {})
        self.server.overrides["/.well-known/oauth-authorization-server"] = (200, {"issuer": self.server.origin}, {})
        code, output = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("FAIL protected resource", output)
        self.assertIn("FAIL authorization discovery", output)

    def test_denial_requires_401_and_same_origin_challenge(self):
        for status, headers in ((200, {}), (401, {}), (401, {"WWW-Authenticate":
                                'Bearer resource_metadata="https://example.invalid/metadata"'})):
            with self.subTest(status=status, headers=headers):
                self.server.overrides["/mcp"] = (status, {}, headers)
                code, output = self.run_check()
                self.assertEqual(code, 1)
                self.assertIn("FAIL MCP anonymous denial", output)

    def test_transport_error_is_concise(self):
        with patch.object(http_check.urllib.request.OpenerDirector, "open", side_effect=TimeoutError):
            code, output = self.run_check()
        self.assertEqual(code, 1)
        self.assertEqual(output.count("request failed"), 4)

    def test_cli_accepts_fixture(self):
        result = subprocess.run([str(ROOT / "bin" / "check-http"), self.server.origin],
                                capture_output=True, text=True, timeout=10, check=False)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)


class UrlSafety(unittest.TestCase):
    def test_unsafe_urls(self):
        for url in ("http://example.com", "https://user:secret@example.com", "https://example.com/?x=secret",
                    "https://example.com/#secret", "https://example.com?", "https://example.com#",
                    "file:///tmp/example", "https://example.com/private", "https://example.com\\@evil.test",
                    "https://example.com:\n443", "https://example.com:", "https://example.com:0",
                    "https://example.com:65536", "https://example.com/%6dcp", "https://éxample.com"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                http_check.origin_from_url(url)

    def test_safe_urls(self):
        for url, expected in (("https://mcp.mars.college/mcp", "https://mcp.mars.college"),
                              ("http://localhost:4400/", "http://localhost:4400"),
                              ("http://[::1]:4400", "http://[::1]:4400")):
            self.assertEqual(http_check.origin_from_url(url), expected)


class HostChecks(unittest.TestCase):
    def setUp(self):
        self.account = types.SimpleNamespace(pw_name="fixture-operator", pw_uid=23456,
                                             pw_gid=34567, pw_dir="/fixture-home")
        for target, name, value in ((host_check.pwd, "getpwuid", self.account),
                                    (host_check.os, "getuid", self.account.pw_uid),
                                    (host_check.os, "geteuid", self.account.pw_uid)):
            patcher = patch.object(target, name, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def run_host(self, args=None):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            code = host_check.main(args if args is not None else ["--user", self.account.pw_name])
        return code, output.getvalue()

    def test_wrong_account_never_runs_subprocess(self):
        with patch.object(host_check.subprocess, "run") as command:
            code, output = self.run_host(["--user", "different-fixture-account"])
        self.assertEqual(code, 1)
        command.assert_not_called()
        self.assertNotIn("different-fixture-account", output)

    def test_root_or_different_real_effective_ids_never_run_subprocess(self):
        for real_uid, effective_uid in ((0, 0), (0, 23456), (23456, 0), (23457, 23456)):
            with self.subTest(real_uid=real_uid, effective_uid=effective_uid), \
                    patch.object(host_check.os, "getuid", return_value=real_uid), \
                    patch.object(host_check.os, "geteuid", return_value=effective_uid), \
                    patch.object(host_check.subprocess, "run") as command:
                code, _ = self.run_host()
                self.assertEqual(code, 1)
                command.assert_not_called()

    def test_account_lookup_failure_never_runs_subprocess(self):
        for error in (KeyError("PRIVATE-LOOKUP"), OSError("PRIVATE-LOOKUP")):
            with self.subTest(error=type(error).__name__), \
                    patch.object(host_check.pwd, "getpwuid", side_effect=error), \
                    patch.object(host_check.subprocess, "run") as command:
                code, output = self.run_host()
                self.assertEqual(code, 1)
                self.assertNotIn("PRIVATE-LOOKUP", output)
                command.assert_not_called()

    def test_cli_requires_account_without_echoing_invalid_arguments(self):
        for args in ([], ["--env-file", "/fixture-private/SECRET"],
                     ["--user", self.account.pw_name, "--unknown=/fixture-private/SECRET"]):
            with self.subTest(args=args), patch.object(host_check.subprocess, "run") as command:
                output = io.StringIO()
                with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output), \
                        self.assertRaises(SystemExit) as exited:
                    host_check.main(args)
                self.assertEqual(exited.exception.code, 2)
                self.assertNotIn("/fixture-private/SECRET", output.getvalue())
                command.assert_not_called()

    def test_correct_account_checks_unit_container_binding_and_default_metadata(self):
        results = [types.SimpleNamespace(returncode=0, stdout=text) for text in (
            "LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n",
            "running\n", "127.0.0.1:4400\n")]
        environment = {"PATH": "/usr/bin:/bin", "HOME": self.account.pw_dir,
                       "USER": self.account.pw_name, "LOGNAME": self.account.pw_name,
                       "XDG_RUNTIME_DIR": "/run/user/23456", "LC_ALL": "C"}
        with patch.dict(os.environ, {"SECRET_FIXTURE": "not-forwarded", "PODMAN_HOST": "not-forwarded"}), \
                patch.object(host_check.subprocess, "run", side_effect=results) as command, \
                patch.object(host_check, "private_path", return_value=True) as metadata:
            code, output = self.run_host()
        self.assertEqual(code, 0, output)
        self.assertEqual([call.args[0] for call in command.call_args_list], [
            ["/usr/bin/systemctl", "--user", "show", "mars-mcp.service", "--no-pager",
             "--property=LoadState", "--property=ActiveState", "--property=SubState",
             "--property=UnitFileState"],
            ["/usr/bin/podman", "container", "inspect", "--format", "{{.State.Status}}", "mars-mcp"],
            ["/usr/bin/podman", "port", "mars-mcp", "4400/tcp"]])
        for call in command.call_args_list:
            self.assertEqual(call.kwargs, {"env": environment, "stdin": subprocess.DEVNULL,
                                          "stdout": subprocess.PIPE, "stderr": subprocess.DEVNULL,
                                          "text": True, "timeout": 5, "check": False})
        self.assertEqual([call.args for call in metadata.call_args_list], [
            (Path("/fixture-home/.config/mars-mcp/runtime.env"), self.account, False),
            (Path("/fixture-home/.local/state/mars-mcp"), self.account, True)])
        self.assertNotIn(self.account.pw_dir, output)

    def test_host_failures_and_operator_paths_remain_private(self):
        env_path, state_path = "/fixture-private/SECRET.env", "/fixture-private/SECRET-state"
        with patch.object(host_check, "command", return_value=(1, "SECRET-COMMAND-OUTPUT")), \
                patch.object(host_check, "private_path", return_value=False) as metadata:
            code, output = self.run_host(["--user", self.account.pw_name,
                                          "--env-file", env_path, "--state-dir", state_path])
        self.assertEqual(code, 1)
        self.assertNotIn("SECRET", output)
        self.assertNotIn("/fixture-private", output)
        self.assertEqual([call.args for call in metadata.call_args_list], [
            (Path(env_path), self.account, False), (Path(state_path), self.account, True)])

    def test_unexpected_status_or_binding_fails(self):
        ready = [(0, "LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled"),
                 (0, "running"), (0, "127.0.0.1:4400")]
        failures = [(0, (0, "LoadState=loaded\nActiveState=inactive")),
                    (1, (0, "exited")), (2, (0, "0.0.0.0:4400")),
                    (2, (0, "127.0.0.1:4400\n[::]:4400")), (2, (1, "127.0.0.1:4400"))]
        for index, result in failures:
            responses = ready.copy()
            responses[index] = result
            with self.subTest(index=index, result=result), \
                    patch.object(host_check, "command", side_effect=responses), \
                    patch.object(host_check, "private_path", return_value=True):
                self.assertEqual(self.run_host()[0], 1)

    def test_command_failures_are_silent(self):
        for error in (subprocess.TimeoutExpired("SECRET-COMMAND", 5), OSError("SECRET-ERROR"),
                      UnicodeError("SECRET-DECODE")):
            with self.subTest(error=type(error).__name__), \
                    patch.object(host_check.subprocess, "run", side_effect=error), \
                    contextlib.redirect_stdout(io.StringIO()) as output, \
                    contextlib.redirect_stderr(io.StringIO()) as errors:
                self.assertEqual(host_check.command(["/usr/bin/podman", "port", "mars-mcp"], {}), (None, ""))
            self.assertEqual(output.getvalue() + errors.getvalue(), "")

    def test_private_metadata_accepts_only_exact_kind_owner_group_and_mode(self):
        cases = [(stat.S_IFREG | 0o600, 23456, 34567, False, True),
                 (stat.S_IFDIR | 0o700, 23456, 34567, True, True),
                 (stat.S_IFREG | 0o644, 23456, 34567, False, False),
                 (stat.S_IFREG | 0o400, 23456, 34567, False, False),
                 (stat.S_IFDIR | 0o750, 23456, 34567, True, False),
                 (stat.S_IFREG | 0o600, 23457, 34567, False, False),
                 (stat.S_IFREG | 0o600, 23456, 34568, False, False),
                 (stat.S_IFDIR | 0o700, 23457, 34567, True, False),
                 (stat.S_IFDIR | 0o700, 23456, 34568, True, False),
                 (stat.S_IFLNK | 0o600, 23456, 34567, False, False),
                 (stat.S_IFLNK | 0o700, 23456, 34567, True, False),
                 (stat.S_IFDIR | 0o600, 23456, 34567, False, False),
                 (stat.S_IFREG | 0o700, 23456, 34567, True, False)]
        path = Path("/fixture-private/metadata-only")
        for mode, uid, gid, directory, expected in cases:
            info = types.SimpleNamespace(st_mode=mode, st_uid=uid, st_gid=gid)
            with self.subTest(mode=mode, uid=uid, gid=gid, directory=directory), \
                    patch.object(Path, "lstat", return_value=info) as metadata, \
                    patch.object(Path, "open", side_effect=AssertionError("must not read contents")):
                self.assertEqual(host_check.private_path(path, self.account, directory), expected)
                metadata.assert_called_once_with()

    def test_private_metadata_lookup_errors_fail_closed(self):
        for error in (FileNotFoundError("SECRET-PATH"), PermissionError("SECRET-PATH"),
                      ValueError("SECRET-PATH")):
            with self.subTest(error=type(error).__name__), \
                    patch.object(Path, "lstat", side_effect=error), \
                    contextlib.redirect_stdout(io.StringIO()) as output, \
                    contextlib.redirect_stderr(io.StringIO()) as errors:
                self.assertFalse(host_check.private_path(Path("/fixture-private"), self.account, False))
            self.assertEqual(output.getvalue() + errors.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
