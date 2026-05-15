import unittest

from pg_ops_tui.pg_gateway import _int, _is_psql_meta_command, probe_menu


class PgGatewayTest(unittest.TestCase):
    def test_probe_menu_exposes_troubleshooting_shortcuts(self) -> None:
        keys = {item["key"] for item in probe_menu()}

        self.assertTrue({"a", "b", "w", "l", "x", "s", "t", "n", "g"}.issubset(keys))

    def test_psql_meta_command_detection(self) -> None:
        self.assertTrue(_is_psql_meta_command(r"\dv"))
        self.assertFalse(_is_psql_meta_command("select 1"))

    def test_int_accepts_decimal_stats(self) -> None:
        self.assertEqual(_int("12.4"), 12)

    def test_int_falls_back_to_zero(self) -> None:
        self.assertEqual(_int(""), 0)


if __name__ == "__main__":
    unittest.main()
