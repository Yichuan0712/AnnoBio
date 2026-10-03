import unittest

from safe_stdio import safe_print


class BrokenStream:
    encoding = "utf-8"

    def write(self, _value):
        raise OSError(22, "Invalid argument")

    def flush(self):
        raise OSError(22, "Invalid argument")


class SafePrintTests(unittest.TestCase):
    def test_broken_log_pipe_does_not_break_caller(self):
        safe_print("Run progress", file=BrokenStream(), flush=True)


if __name__ == "__main__":
    unittest.main()
