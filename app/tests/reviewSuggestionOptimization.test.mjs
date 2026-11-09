import test from 'node:test';
import assert from 'node:assert/strict';

import { keepSegmentWhitespace } from '../src/reviewSuggestionOptimization.js';

test('a segment without edge whitespace leaves its candidates unchanged (the built-in method)', () => {
  assert.equal(keepSegmentWhitespace('Return every drug name.', '  List all drugs.  '), 'List all drugs.');
});

test('paragraph segments keep their line breaks, so the joined candidates keep the layout', () => {
  const text = '# Task\nExtract drugs.\n\n# Output\nReturn JSON.\n\nBe brief.';
  const segments = ['# Task\nExtract drugs.\n\n', '# Output\nReturn JSON.\n\n', 'Be brief.'];
  assert.equal(segments.join(''), text);
  // Candidates come back trimmed; re-attaching each segment's whitespace restores the paragraph breaks.
  const candidates = segments.map((s) => s.trim());
  const composed = candidates.map((c, i) => keepSegmentWhitespace(segments[i], c)).join('');
  assert.equal(composed, text);
  assert.equal(keepSegmentWhitespace(segments[0], 'Find the drugs.'), 'Find the drugs.\n\n');
});

test('a whitespace-only segment adds nothing', () => {
  assert.equal(keepSegmentWhitespace('   ', 'x'), '   x');
});
