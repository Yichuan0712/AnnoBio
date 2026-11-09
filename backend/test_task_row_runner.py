"""task_row_runner: one input through the user's Generate model, the way a Run does it."""
from __future__ import annotations

import unittest

from task_row_runner import make_row_runner, output_fields_for

SCHEMA = {"return_shape": "single", "fields": [{"key": "drug name", "type": "str"}]}


class Fake:
    def __init__(self, replies):
        self.replies, self.calls = list(replies), []

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        return self.replies.pop(0), False


def runner(fake, schema=SCHEMA, settings=None):
    return make_row_runner(provider="p", model="m", api_key="k", base_url="", output_schema=schema,
                           run_settings=settings or {"run_max_tokens": 1234, "run_params": {"temperature": 0},
                                                     "run_max_retries": 1},
                           run_structured=fake, sleep=lambda s: None)


class TaskRowRunnerTests(unittest.TestCase):
    def test_substitutes_placeholders_and_passes_run_settings(self):
        fake = Fake([{"drug_name": "aspirin"}])
        out = runner(fake)("Find the drug in: {text}", {"text": "Took aspirin."})
        self.assertEqual(out, [{"drug_name": "aspirin"}])
        call = fake.calls[0]
        self.assertEqual(call["prompt"], "Find the drug in: Took aspirin.")
        self.assertEqual((call["max_tokens"], call["params"], call["return_shape"]), (1234, {"temperature": 0}, "single"))

    def test_json_braces_in_the_prompt_are_left_alone(self):
        fake = Fake([{"drug_name": "x"}])
        runner(fake)('Example: {"drug name": "aspirin"}\nNow: {text}', {"text": "t"})
        self.assertEqual(fake.calls[0]["prompt"], 'Example: {"drug name": "aspirin"}\nNow: t')

    def test_empty_output_is_retried_then_raises(self):
        fake = Fake([{"drug_name": ""}, {"drug_name": "ok"}])
        self.assertEqual(runner(fake)("{text}", {"text": "t"}), [{"drug_name": "ok"}])
        fake = Fake([{"drug_name": ""}, {"drug_name": ""}])
        with self.assertRaises(RuntimeError):
            runner(fake)("{text}", {"text": "t"})

    def test_table_outputs_unwrap_to_rows(self):
        schema = {"return_shape": "table", "fields": [{"key": "drug", "type": "str"}]}
        fake = Fake([{"rows": [{"drug": "a"}, {"drug": "b"}]}])
        self.assertEqual(runner(fake, schema)("{text}", {"text": "t"}), [{"drug": "a"}, {"drug": "b"}])

    def test_output_field_names_match_the_run_job(self):
        self.assertEqual(output_fields_for([{"key": "drug name"}, {"key": "drug-name"}]),
                         [{"display": "drug name", "key": "drug_name"}, {"display": "drug-name", "key": "drug_name_1"}])


if __name__ == "__main__":
    unittest.main()
