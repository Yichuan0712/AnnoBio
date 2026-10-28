import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REFERENCE_IMPORT_TABS, parseReferenceIds, referenceImportPanelsHtml, referenceImportTabsHtml,
} from '../src/referenceImportPanels.js';
import { DATABASE_CATALOG, availableDatabases, databasePickerHtml, filterDatabases } from '../src/databaseCatalog.js';

test('ids split on spaces and commas, or by line only for titles that contain them', () => {
  assert.deepEqual(parseReferenceIds(' 11532001, PMC5\nPPR7  W1 '), ['11532001', 'PMC5', 'PPR7', 'W1']);
  assert.deepEqual(parseReferenceIds('Cyclin-dependent kinase 2\r\n\nCyclin A, human \n', { oneTitlePerLine: true }), ['Cyclin-dependent kinase 2', 'Cyclin A, human']);
});

test('other databases share one entry and retain their import forms', () => {
  assert.equal(REFERENCE_IMPORT_TABS.length, 38);
  const tabs = referenceImportTabsHtml();
  assert.deepEqual([...tabs.matchAll(/data-source="([a-z]+)">Import from ([^<]+)</g)].map((match) => [match[1], match[2]]),
    [['database', 'other databases']]);
  const panels = referenceImportPanelsHtml();
  for (const { source, label } of REFERENCE_IMPORT_TABS) {
    assert.match(panels, new RegExp(`data-source-panel="${source}" hidden`));
    assert.match(panels, new RegExp(`id="${source}-ids"`));
    assert.match(panels, new RegExp(`>Fetch from ${label}</button>`));
  }
  assert.doesNotMatch(tabs + panels, /wikipedia/i);
  assert.match(panels, /placeholder="P24941&#10;P06493"/);
});

test('picker preserves existing sources and exposes every Biomni source and snapshot group', () => {
  const expected = ['clinicaltrials', 'preprint', 'chembl', 'europepmc', 'openalex', 'uniprot',
    'pubchem', 'dailymed', 'openfda', 'ensembl', 'clinvar', 'gwas', 'gnomad', 'pdb', 'alphafold',
    'interpro', 'reactome', 'string', 'opentargets', 'geo', 'pride', 'encode'];
  assert.deepEqual(DATABASE_CATALOG.slice(0, expected.length).map((item) => item.source), expected);
  assert.equal(DATABASE_CATALOG.length, 69);
  assert.equal(DATABASE_CATALOG.filter((item) => item.kind === 'snapshot').length, 28);
  assert.equal(new Set(DATABASE_CATALOG.map((item) => item.source)).size, 69);
  const picker = databasePickerHtml();
  for (const source of expected) assert.match(picker, new RegExp(`data-database-source="${source}"`));
  assert.doesNotMatch(picker, /wikipedia|data-database-source="pubmed"/i);
});

test('database filters combine case-insensitive terms, descriptions and categories', () => {
  assert.deepEqual(filterDatabases('pubCHEM').map((item) => item.source), ['pubchem']);
  assert.deepEqual(filterDatabases('function', 'Proteins and structures').map((item) => item.source), ['uniprot', 'interpro']);
  assert.deepEqual(filterDatabases('PubChem', 'Experimental data'), []);
  assert.deepEqual(filterDatabases('does not exist'), []);
});

test('web exposes only online sources while desktop retains the complete snapshot catalog', () => {
  const web = availableDatabases({ includeSnapshots: false });
  const desktop = availableDatabases({ includeSnapshots: true });
  assert.equal(web.length, 41);
  assert.equal(desktop.length, 69);
  assert.ok(web.every((item) => item.kind !== 'snapshot'));
  assert.equal(desktop.filter((item) => item.kind === 'snapshot').length, 28);
  assert.doesNotMatch(databasePickerHtml(), /data-database-source="lake_|>Data snapshots</);
  assert.deepEqual(filterDatabases('', 'Data snapshots'), []);
  assert.equal(filterDatabases('', 'Data snapshots', { includeSnapshots: true }).length, 28);
});
