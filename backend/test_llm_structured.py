"""The structured-output core (llm_structured.py): request shapes per mode, reading replies, which
errors move on to the next mode, the correction turn, truncation, and remembering a model's mode."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import llm_structured as core  # noqa: E402

SCHEMA = {
    "$defs": {
        "Row": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "default": ""},
                "default": {"type": "number"},
            },
            "required": ["name", "default"],
            "additionalProperties": False,
        }
    },
    "title": "Table Output",
    "type": "object",
    "properties": {"rows": {"type": "array", "items": {"$ref": "#/$defs/Row"}}},
    "required": ["rows"],
    "additionalProperties": False,
}


def reply(content=None, tool_arguments=None, finish_reason="stop"):
    message = {"content": content}
    if tool_arguments is not None:
        message["tool_calls"] = [{"function": {"name": core.TOOL_NAME, "arguments": tool_arguments}}]
    return {"choices": [{"message": message, "finish_reason": finish_reason}]}


class ApiError(Exception):
    def __init__(self, message, status_code=None):
        super().__init__(message)
        self.status_code = status_code


class UnsupportedParamsError(Exception):
    pass


class FakeSend:
    """Answers each request with the next item: a response, or an exception to raise."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.requests: list[dict] = []

    def __call__(self, request):
        self.requests.append(request)
        answer = self.answers.pop(0)
        if isinstance(answer, BaseException):
            raise answer
        return answer


def rows_of(data):
    if not isinstance(data.get("rows"), list) or not all(isinstance(r.get("name"), str) for r in data["rows"]):
        raise ValueError("rows[].name must be a string")
    return data


def run(send, **kwargs):
    kwargs.setdefault("validate", rows_of)
    kwargs.setdefault("array_key", "rows")
    return core.run(send, messages=[{"role": "user", "content": "List rows."}], schema=SCHEMA, **kwargs)


class RequestShapeTest(unittest.TestCase):
    def test_json_schema_is_strict_and_drops_defaults_only_from_schema_positions(self):
        request = core.build_request("json_schema", [{"role": "user", "content": "x"}], SCHEMA)
        spec = request["response_format"]["json_schema"]
        self.assertTrue(spec["strict"])
        self.assertEqual(spec["name"], "Table_Output")
        row = spec["schema"]["$defs"]["Row"]
        self.assertNotIn("default", row["properties"]["name"])
        self.assertIn("default", row["properties"])  # a property named "default" stays

    def test_tool_mode_forces_one_tool_with_references_inlined(self):
        request = core.build_request("tool", [{"role": "user", "content": "x"}], SCHEMA)
        self.assertEqual(request["tool_choice"]["function"]["name"], core.TOOL_NAME)
        parameters = request["tools"][0]["function"]["parameters"]
        self.assertNotIn("$defs", parameters)
        self.assertEqual(parameters["properties"]["rows"]["items"]["properties"]["name"]["type"], "string")

    def test_json_object_mode_puts_the_schema_and_the_word_json_in_the_prompt(self):
        request = core.build_request("json_object", [{"role": "user", "content": "List rows."}], SCHEMA)
        self.assertEqual(request["response_format"], {"type": "json_object"})
        text = request["messages"][-1]["content"]
        self.assertTrue(text.startswith("List rows."))
        self.assertIn("JSON Schema", text)
        self.assertNotIn("$ref", text)

    def test_prompt_mode_keeps_image_blocks_and_adds_a_text_block(self):
        image = {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA"}}
        messages = [{"role": "user", "content": [{"type": "text", "text": "Read."}, image]}]
        request = core.build_request("prompt", messages, SCHEMA)
        content = request["messages"][-1]["content"]
        self.assertEqual(content[:2], [{"type": "text", "text": "Read."}, image])
        self.assertEqual(content[2]["type"], "text")
        self.assertNotIn("response_format", request)
        self.assertEqual(len(messages[0]["content"]), 2)  # the caller's messages are not changed


class ReadReplyTest(unittest.TestCase):
    def test_tool_mode_reads_the_tool_arguments(self):
        value, raw, finish = core.read_reply("tool", reply(tool_arguments='{"rows": []}'))
        self.assertEqual((value, raw, finish), ('{"rows": []}', '{"rows": []}', "stop"))

    def test_tool_mode_without_a_tool_call_reads_the_content(self):
        value, _, _ = core.read_reply("tool", reply(content='{"rows": []}'))
        self.assertEqual(value, '{"rows": []}')

    def test_a_parsed_object_is_used_as_it_is(self):
        response = {"choices": [{"message": {"content": "", "parsed": {"rows": []}}, "finish_reason": "stop"}]}
        self.assertEqual(core.read_reply("json_schema", response)[0], {"rows": []})

    def test_objects_with_attributes_are_read_like_dicts(self):
        class Obj:
            def __init__(self, **kw):
                self.__dict__.update(kw)
        response = Obj(choices=[Obj(finish_reason="stop", message=Obj(content="hi", tool_calls=None, parsed=None))])
        self.assertEqual(core.read_reply("prompt", response), ("hi", "hi", "stop"))


class ParseReplyTest(unittest.TestCase):
    """The prompt-only modes return free text: the JSON must be read by the parser, not by counting brackets."""

    def test_a_bracket_inside_a_string_does_not_end_the_array(self):
        text = 'Here you go:\n[\n  {"name": "Ser15] was phosphorylated"}\n]\nDone.'
        self.assertEqual(core.parse_reply(text, "rows"), {"rows": [{"name": "Ser15] was phosphorylated"}]})

    def test_an_object_reply_is_read_the_same_way(self):
        self.assertEqual(core.parse_reply('{"a": "x {y}", "b": ["} z"]} trailing'), {"a": "x {y}", "b": ["} z"]})

    def test_a_table_accepts_the_wrapped_object_a_bare_array_and_a_single_row(self):
        self.assertEqual(core.parse_reply('{"rows": [{"name": "a"}]}', "rows"), {"rows": [{"name": "a"}]})
        self.assertEqual(core.parse_reply('[{"name": "a"}]', "rows"), {"rows": [{"name": "a"}]})
        self.assertEqual(core.parse_reply('{"name": "a"}', "rows"), {"rows": [{"name": "a"}]})

    def test_a_fenced_block_is_preferred(self):
        self.assertEqual(core.parse_reply('Note {x}\n```json\n{"a": 1}\n```'), {"a": 1})

    def test_no_json_says_what_the_model_said(self):
        with self.assertRaisesRegex(ValueError, "no JSON.*I cannot help"):
            core.parse_reply("I cannot help with that.")

    def test_an_incomplete_reply_reports_the_parse_error(self):
        with self.assertRaisesRegex(ValueError, "Unterminated string"):
            core.parse_reply('[{"name": "Hyperoxia phosph', "rows")


class ClassifyErrorTest(unittest.TestCase):
    def test_capability_errors(self):
        for exc in (
            ApiError("Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model", 400),
            ApiError("This response_format type is unavailable now", 400),
            ApiError("tool_choice is not supported", 422),
            ApiError("No endpoints found that support the requested parameters", 404),
            UnsupportedParamsError("deepseek does not support parameters: ['tools']"),
            UnsupportedParamsError("ollama does not support parameters: ['tools'], for model=llama3.2-vision"),
            ApiError("registry.ollama.ai/library/llama3.2-vision:latest does not support tools", 400),
            ApiError("Invalid schema for response_format 'x': 'default' is not permitted", 400),
        ):
            self.assertEqual(core.classify_error(exc), "capability", str(exc))

    def test_fatal_errors(self):
        for exc in (
            ApiError("Service Unavailable", 503),
            ApiError("Rate limit reached for requests", 429),
            ApiError("Invalid API key", 401),
            ApiError("The model does not support image input", 400),
            ApiError("This model's maximum context length is 8192 tokens", 400),
            ApiError("Invalid request: messages[0].content must not be empty", 400),
            ApiError("Model not found", 404),
            ApiError("User location is not supported for the API use.", 400),
            ApiError("The model `gpt-foo` is not supported", 400),
            ApiError("No endpoints found matching your data policy", 404),
            ApiError("This model doesn't support the image content block that you provided.", 400),
        ):
            self.assertEqual(core.classify_error(exc), "fatal", str(exc))


class RunTest(unittest.TestCase):
    def test_the_first_mode_that_is_accepted_is_used(self):
        send = FakeSend(
            ApiError("response_format json_schema is not supported", 400),
            reply(tool_arguments='{"rows": [{"name": "H", "default": 1}]}'),
        )
        result = run(send)
        self.assertEqual(result["mode"], "tool")
        self.assertEqual(result["output"]["rows"][0]["name"], "H")
        self.assertEqual([t["mode"] for t in result["tried"]], ["json_schema"])
        self.assertIn("tools", send.requests[1])

    def test_a_fatal_error_is_raised_without_trying_other_modes(self):
        send = FakeSend(ApiError("Service Unavailable", 503))
        with self.assertRaisesRegex(ApiError, "Service Unavailable"):
            run(send)
        self.assertEqual(len(send.requests), 1)

    def test_start_mode_skips_the_modes_above_it(self):
        send = FakeSend(reply(content='[{"name": "H"}]'))
        result = run(send, start_mode="prompt")
        self.assertEqual(result["mode"], "prompt")
        self.assertNotIn("response_format", send.requests[0])

    def test_a_reply_that_fails_validation_gets_one_correction_turn(self):
        send = FakeSend(reply(content='{"rows": [{"name": 7}]}'), reply(content='{"rows": [{"name": "7"}]}'))
        result = run(send, start_mode="json_object")
        self.assertTrue(result["repaired"])
        correction = send.requests[1]["messages"]
        self.assertEqual(correction[-2], {"role": "assistant", "content": '{"rows": [{"name": 7}]}'})
        self.assertIn("rows[].name must be a string", correction[-1]["content"])
        self.assertEqual(send.requests[1]["response_format"], {"type": "json_object"})

    def test_a_reply_still_wrong_after_correction_is_an_error_at_run_time(self):
        send = FakeSend(reply(content='{"rows": [{"name": 1}]}'), reply(content='{"rows": [{"name": 2}]}'))
        with self.assertRaisesRegex(core.StructuredOutputError, "must be a string") as caught:
            run(send)
        self.assertFalse(caught.exception.ignored)
        self.assertEqual(len(send.requests), 2)

    def test_a_run_moves_on_from_a_mode_whose_replies_hold_no_json(self):
        # The endpoint took response_format and ignored it; one wrong row must not do the same.
        send = FakeSend(reply(content="Hydrogen and helium."), reply(content="H, He"),
                        reply(tool_arguments='{"rows": [{"name": "H"}]}'))
        result = run(send)
        self.assertEqual(result["mode"], "tool")
        self.assertEqual(result["tried"][0]["mode"], "json_schema")

    def test_one_reply_with_json_keeps_the_mode(self):
        send = FakeSend(reply(content='{"rows": [{"name": 1}]}'), reply(content="Sorry."))
        with self.assertRaises(core.StructuredOutputError) as caught:
            run(send)
        self.assertFalse(caught.exception.ignored)

    def test_a_refusal_is_the_answer_and_never_moves_on(self):
        refused = {"choices": [{"message": {"content": None, "refusal": "I can't help with that."}, "finish_reason": "stop"}]}
        send = FakeSend(refused)
        with self.assertRaisesRegex(core.StructuredOutputError, "refused: I can't help") as caught:
            run(send)
        self.assertFalse(caught.exception.ignored)
        self.assertEqual(len(send.requests), 1)

    def test_a_reply_cut_off_at_max_tokens_says_so_in_any_mode(self):
        for mode in core.MODES:
            send = FakeSend(reply(content='{"rows": [{"name": "Hyper', finish_reason="length"))
            with self.assertRaisesRegex(core.TruncatedReply, r"max tokens limit \(8192\).*Raise Max tokens in Settings"):
                run(send, start_mode=mode, max_tokens=8192)
            self.assertEqual(len(send.requests), 1)

    def test_a_capability_error_in_the_last_mode_is_raised(self):
        send = FakeSend(ApiError("unsupported", 400))
        with self.assertRaisesRegex(ApiError, "unsupported"):
            run(send, start_mode="prompt")


class ModeMemoryTest(unittest.TestCase):
    def test_a_run_only_lowers_the_mode_and_reports_changes(self):
        changes = []
        memory = core.ModeMemory(on_change=lambda key, mode, detail: changes.append((key, mode)))
        memory.learn("m", "json_schema")
        memory.learn("m", "tool")
        memory.learn("m", "json_schema")
        memory.learn("m", "tool")
        self.assertEqual(memory.get("m"), "tool")
        self.assertEqual(changes, [("m", "json_schema"), ("m", "tool")])

    def test_set_may_raise_it_and_is_not_reported(self):
        changes = []
        memory = core.ModeMemory(on_change=lambda *args: changes.append(args))
        memory.set("m", "prompt")
        memory.set("m", "json_schema")
        self.assertEqual(memory.get("m"), "json_schema")
        memory.set("m", None)
        self.assertIsNone(memory.get("m"))
        self.assertEqual(changes, [])

    def test_a_failing_listener_does_not_fail_the_call(self):
        memory = core.ModeMemory(on_change=lambda *args: 1 / 0)
        memory.learn("m", "tool")
        self.assertEqual(memory.get("m"), "tool")


if __name__ == "__main__":
    unittest.main()
