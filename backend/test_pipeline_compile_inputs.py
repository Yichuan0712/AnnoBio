"""The compiler reads Run and Process inputs only through run_input and process_inputs."""

from __future__ import annotations

import unittest

from backend.pipeline_compile import _Compiler, compile_pipeline
from backend.test_pipeline_compile import DEFAULTS, branched, data, dataset, edge, process, prompt, route_for, run


def compiled(state):
    compiler = _Compiler(state, route_for(state), None, DEFAULTS, "strict")
    compiler.compile()
    return compiler


class CompilerInputAccessTests(unittest.TestCase):
    def test_run_input_is_the_source_the_run_reads(self):
        compiler = compiled(branched())
        self.assertEqual(compiler.run_input("r"), ("merge", "result"))

    def test_process_inputs_put_the_recorded_primary_first_as_df(self):
        compiler = compiled(branched())
        primary, sources = compiler.process_inputs("merge", compiler.nodes["merge"])
        self.assertEqual(primary, ("split", "left"))
        self.assertEqual(sources, [(("split", "left"), "df"), (("split", "right"), "df_right")])

    def test_a_single_input_is_the_primary_without_being_recorded(self):
        state = branched()
        del next(e for e in state["connections"] if e["type"] == "data" and e["toId"] == "split")["alias"]
        compiler = compiled(state)
        self.assertEqual(compiler.process_inputs("split", compiler.nodes["split"]), (("raw", "result"), [(("raw", "result"), "df")]))

    def test_several_inputs_without_a_recorded_primary_are_reported(self):
        state = {"nodes": [dataset("a"), dataset("b"), process("join")],
                 "connections": [data("a", "join"), data("b", "join")]}
        compiler = compiled(state)
        before = len(compiler.diagnostics)
        primary, sources = compiler.process_inputs("join", compiler.nodes["join"])
        self.assertEqual(primary, "")
        self.assertEqual(sources, [(("a", "result"), ""), (("b", "result"), "")])
        self.assertEqual([d["code"] for d in compiler.diagnostics[before:]], ["INVALID_PRIMARY_INPUT"])

    def test_two_df_inputs_are_reported(self):
        state = {"nodes": [dataset("a"), dataset("b"), process("join")],
                 "connections": [data("a", "join", "df"), data("b", "join", "df")]}
        compiler = compiled(state)
        before = len(compiler.diagnostics)
        self.assertEqual(compiler.process_inputs("join", compiler.nodes["join"]),
                         ("", [(("a", "result"), "df"), (("b", "result"), "df")]))
        self.assertEqual([d["code"] for d in compiler.diagnostics[before:]], ["INVALID_PRIMARY_INPUT"])

    def test_a_run_without_input_reads_nothing(self):
        state = {"nodes": [dataset("raw"), prompt(), run()], "connections": [edge("p", "r", "prompt-to-run")]}
        self.assertEqual(compiled(state).run_input("r"), ("", "result"))

    def test_a_run_with_two_inputs_is_reported(self):
        state = {"nodes": [dataset("a"), dataset("b"), prompt(), run()],
                 "connections": [edge("p", "r", "prompt-to-run"), data("b", "r"), data("a", "r")]}
        compiler = compiled(state)
        before = len(compiler.diagnostics)
        self.assertEqual(compiler.run_input("r"), ("a", "result"))
        self.assertEqual([d["code"] for d in compiler.diagnostics[before:]], ["MULTIPLE_RUN_INPUTS"])

    def test_a_step_output_is_read_as_its_job_artifact(self):
        state = branched()
        result = compile_pipeline(canvas_state=state, route=route_for(state), run_defaults=DEFAULTS)
        jobs = {job["id"]: job for job in result["spec"]["jobs"]}
        self.assertEqual(jobs["llm:r"]["inputs"], {"data": "output:process:merge:result"})
        self.assertEqual(jobs["process:merge"]["inputs"]["df_right"], "output:process:split:right")


if __name__ == "__main__":
    unittest.main()
