import socket
import unittest
from unittest import mock

from tools import viz_server


class LocalServerTests(unittest.TestCase):
    def test_server_bind_does_not_require_reverse_dns(self):
        with mock.patch.object(
            socket,
            "getfqdn",
            side_effect=AssertionError("local dashboard startup must not use DNS"),
        ):
            server = viz_server.LocalThreadingHTTPServer(
                ("127.0.0.1", 0), viz_server.Handler
            )
        try:
            self.assertEqual(server.server_name, "127.0.0.1")
            self.assertGreater(server.server_port, 0)
        finally:
            server.server_close()


if __name__ == "__main__":
    unittest.main()
