import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REFERENCE_IMPORT_TABS, parseReferenceIds, referenceImportPanelsHtml, referenceImportTabsHtml,
} from '../src/referenceImportPanels.js';

test('ids split on spaces and commas, or by line only for titles that contain them', () => {
  assert.deepEqual(parseReferenceIds(' 11532001, PMC5\nPPR7  W1 '), ['11532001', 'PMC5', 'PPR7', 'W1']);
  assert.deepEqual(parseReferenceIds('Cyclin-dependent kinase 2\r\n\nCyclin A, human \n', { oneTitlePerLine: true }), ['Cyclin-dependent kinase 2', 'Cyclin A, human']);
});

test('each academic source gets a tab after the existing imports; Wikipedia is left to the Agent', () => {
  assert.deepEqual(REFERENCE_IMPORT_TABS.map((tab) => tab.source), ['europepmc', 'openalex', 'uniprot']);
  const tabs = referenceImportTabsHtml();
  assert.deepEqual([...tabs.matchAll(/data-source="([a-z]+)">Import from ([^<]+)</g)].map((match) => [match[1], match[2]]),
    [['europepmc', 'Europe PMC'], ['openalex', 'OpenAlex'], ['uniprot', 'UniProt']]);
  const panels = referenceImportPanelsHtml();
  for (const { source, label } of REFERENCE_IMPORT_TABS) {
    assert.match(panels, new RegExp(`data-source-panel="${source}" hidden`));
    assert.match(panels, new RegExp(`id="${source}-ids"`));
    assert.match(panels, new RegExp(`>Fetch from ${label}</button>`));
  }
  assert.doesNotMatch(tabs + panels, /wikipedia/i);
  assert.match(panels, /placeholder="P24941&#10;P06493"/);
});
