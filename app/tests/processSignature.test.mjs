import assert from 'node:assert/strict';
import test from 'node:test';

import { codeOutsideSignature, parseProcessSignature, withProcessParameters } from '../src/processSignature.js';

const body = '\n    return df.merge(df_lookup)\n';

test('reads parameters across lines, past annotations, defaults, strings and comments', () => {
  const code = `import pandas as pd


def process(
    df: pd.DataFrame,  # the primary input
    df_lookup: "pd.DataFrame",
    limit=(1, 2),
    sep=",)",
    **inputs,
) -> pd.DataFrame:${body}`;
  const signature = parseProcessSignature(code);
  assert.deepEqual(signature.params.map((param) => param.name), ['df', 'df_lookup', 'limit', 'sep', 'inputs']);
  assert.equal(signature.params[0].text, 'df: pd.DataFrame');
  assert.equal(code.slice(signature.close, signature.close + 2), ') ');
  assert.equal(parseProcessSignature('def processing(df):\n    return df\n'), null);
  assert.equal(parseProcessSignature('    def process(df):\n        return df\n'), null);
});

test('adds, keeps and removes df_ parameters right after df', () => {
  assert.equal(withProcessParameters(`def process(df):${body}`, ['df_lookup']), `def process(df, df_lookup):${body}`);
  assert.equal(withProcessParameters(`def process(df, df_a: pd.DataFrame, limit=5):${body}`, ['df_a', 'df_b']),
    `def process(df, df_a: pd.DataFrame, df_b, limit=5):${body}`);
  assert.equal(withProcessParameters(`def process(df, df_a, df_b, **inputs):${body}`, ['df_b']),
    `def process(df, df_b, **inputs):${body}`);
  const unchanged = `def process(df,df_a):${body}`;
  assert.equal(withProcessParameters(unchanged, ['df_a']), unchanged);
  assert.equal(withProcessParameters('df = 1\n', ['df_a']), 'df = 1\n');
});

test('a signature too long for one line goes one parameter per line, and back', () => {
  const aliases = ['df_pairs_ready_for_uniprot_matching_copy_1', 'df_pairs_with_uniprot_candidates'];
  const long = withProcessParameters(`def process(df) -> pd.DataFrame:${body}`, aliases);
  assert.equal(long, `def process(
    df,
    df_pairs_ready_for_uniprot_matching_copy_1,
    df_pairs_with_uniprot_candidates,
) -> pd.DataFrame:${body}`);
  assert.equal(withProcessParameters(long, ['df_pairs_with_uniprot_candidates']),
    `def process(df, df_pairs_with_uniprot_candidates) -> pd.DataFrame:${body}`);
});

test('the code outside the signature tells a used Dataset from one only declared', () => {
  const code = `def process(df, df_lookup, df_unused):${body}`;
  assert.equal(codeOutsideSignature(code), `def process():${body}`);
});
