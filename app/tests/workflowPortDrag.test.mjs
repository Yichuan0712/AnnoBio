import test from 'node:test';
import assert from 'node:assert/strict';

import { AUTO_PAN_MARGIN, AUTO_PAN_MAX_SPEED, autoPanStep } from '../src/workflowPortDrag.js';

const rect = { left: 100, top: 50, right: 900, bottom: 650 };

test('the canvas does not pan while the pointer is away from its edges', () => {
  assert.deepEqual(autoPanStep(500, 300, rect), { dx: 0, dy: 0 });
  assert.deepEqual(autoPanStep(100 + AUTO_PAN_MARGIN, 650 - AUTO_PAN_MARGIN, rect), { dx: 0, dy: 0 });
});

test('it pans toward an edge, faster the closer the pointer gets', () => {
  const near = autoPanStep(900 - AUTO_PAN_MARGIN / 2, 300, rect);
  const nearer = autoPanStep(900 - 2, 300, rect);
  assert.ok(near.dx > 0 && nearer.dx > near.dx, JSON.stringify({ near, nearer }));
  assert.equal(near.dy, 0);
  assert.ok(autoPanStep(105, 300, rect).dx < 0);
  assert.ok(autoPanStep(500, 55, rect).dy < 0);
  assert.ok(autoPanStep(500, 640, rect).dy > 0);
});

test('past an edge it pans at full speed, on both axes in a corner', () => {
  assert.deepEqual(autoPanStep(2000, 300, rect), { dx: AUTO_PAN_MAX_SPEED, dy: 0 });
  assert.deepEqual(autoPanStep(0, 0, rect), { dx: -AUTO_PAN_MAX_SPEED, dy: -AUTO_PAN_MAX_SPEED });
});
