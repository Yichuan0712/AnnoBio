"""The compiler reads Run and Process inputs only through run_input and process_inputs."""

from __future__ import annotations

import unittest

from backend.pipeline_compile import _Compiler
from backend.test_pipeline_compile import DEFAULTS, branched, dataset, edge, process, prompt, route_for, run


def compiled(state):
    compiler = _Compiler(state, route_for(state), None, DEFAULTS, "strict")
    compiler.compile()
    return compiler


class CompilerInputAccessTests(unittest.TestCase):
    def test_run_input_is_the_dataset_the_run_reads(self):
        compiler = compiled(branched())
        self.assertEqual(compiler.run_input("r"), "merged")

    def test_process_inputs_put_the_recorded_primary_first_as_df(self):
        compiler = compiled(branched())
        primary, sources = compiler.process_inputs("merge", compiler.nodes["merge"])
        self.assertEqual(primary, "left")
        self.assertEqual(sources, [("left", "df"), ("right", "df_right")])

    def test_a_single_input_is_the_primary_without_being_recorded(self):
        compiler = compiled(branched())
        self.assertEqual(compiler.process_inputs("split", compiler.nodes["split"]), ("raw", [("raw", "df")]))

    def test_several_inputs_without_a_recorded_primary_are_reported(self):
        state = {"nodes": [dataset("a"), dataset("b"), process("join")],
                 "connections": [edge("a", "join", "dataset-to-process"), edge("b", "join", "dataset-to-process")]}
        compiler = compiled(state)
        before = len(compiler.diagnostics)
        primary, sources = compiler.process_inputs("join", compiler.nodes["join"])
        self.assertEqual(primary, "")
        self.assertEqual(sources, [("a", ""), ("b", "")])
        self.assertEqual([d["code"] for d in compiler.diagnostics[before:]], ["INVALID_PRIMARY_INPUT"])

    def test_a_run_without_input_reads_nothing(self):
        state = {"nodes": [dataset("raw"), prompt(), run(input_id="")], "connections": [edge("p", "r", "prompt-to-run")]}
        self.assertEqual(compiled(state).run_input("r"), "")


if __name__ == "__main__":
    unittest.main()
