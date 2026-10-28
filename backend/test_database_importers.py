"""Adapter contracts using reduced public API responses captured on 2026-10-28."""
import json
from pathlib import Path
import unittest
from unittest import mock

import httpx
import reference_import as ri
from agent.source_search import SourceSearchError, describe_sources, search_source


FIXTURES = json.loads((Path(__file__).parent / "test_fixtures/database_imports.json").read_text(encoding="utf-8"))
CASES = {
    "pubchem": ("2244", "title", "Aspirin"),
    "dailymed": ("02b3a604-3f09-47e7-add1-b9038b3a268b", "version", "2"),
    "openfda": ("0058175f-3474-40c3-a046-6cfaec86d84b", "generic_name", "ASPIRIN"),
    "ensembl": ("ENSG00000141510", "name", "TP53"),
    "clinvar": ("7105", "significance", "Pathogenic"),
    "gwas": ("GCST000001", "trait", "Age-related macular degeneration"),
    "gnomad": ("1-55051215-G-GA", "genome_af", "0.004772721304587589"),
    "pdb": ("1CRN", "methods", "X-RAY DIFFRACTION"),
    "alphafold": ("P04637", "protein", "Cellular tumor antigen p53"),
    "interpro": ("IPR000001", "name", "Kringle"),
    "reactome": ("R-HSA-109581", "name", "Apoptosis"),
    "string": ("9606.ENSP00000269305", "name", "TP53"),
    "opentargets": ("ENSG00000141510", "name", "tumor protein p53"),
    "geo": ("GSE100", "sample_count", "4"),
    "pride": ("PXD000001", "instruments", "LTQ Orbitrap Velos"),
    "encode": ("ENCSR000AKS", "assay", "Histone ChIP-seq"),
}


class DatabaseImportTest(unittest.TestCase):
    def fetch(self, source, ids, fields, handler, on_batch=None):
        factory = lambda: httpx.Client(transport=httpx.MockTransport(handler))
        with mock.patch.object(ri, "_client", factory), mock.patch.object(ri, "_pace"), mock.patch.object(ri, "BATCH_DELAY_SEC", 0):
            return ri.fetch_records(source, ids, fields, on_batch=on_batch)

    def test_all_sixteen_adapters_parse_real_responses_into_selected_string_columns(self):
        for source, (identifier, field, expected) in CASES.items():
            with self.subTest(source=source):
                def handler(request):
                    if "esearch" in request.url.path:
                        self.assertEqual(request.url.params["term"], 'GSE100[Accession]')
                        return httpx.Response(200, json={"esearchresult": {"idlist": ["200000100"]}})
                    if source in ("gnomad", "opentargets"):
                        body = json.loads(request.content)
                        self.assertEqual(request.method, "POST")
                        self.assertEqual(body["variables"]["id"], identifier)
                    return httpx.Response(200, json=FIXTURES[source])
                rows = self.fetch(source, [identifier], [field, "source_url", "record_json"], handler)
                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0][field], expected)
                self.assertTrue(rows[0]["source_url"].startswith("https://"))
                self.assertTrue(json.loads(rows[0]["record_json"]))
                self.assertEqual(set(rows[0]), {field, "source_url", "record_json"})

    def test_registry_defaults_are_valid_and_import_only_sources_do_not_pretend_to_search(self):
        for source in CASES:
            info = ri.describe_importers()[source]
            self.assertTrue(set(info["default_fields"]) <= info["fields"].keys())
            self.assertFalse(describe_sources()[source]["searchable"])
            with self.assertRaisesRegex(SourceSearchError, "import by"):
                search_source(source, "test")

    def test_invalid_ids_never_make_network_requests(self):
        for source in CASES:
            with self.subTest(source=source):
                calls = []
                def handler(request):
                    calls.append(request)
                    raise AssertionError("Malformed identifier reached the network")
                progress = []
                rows = self.fetch(source, ["https://example.org/../../secret"], ["source_url"], handler,
                                  lambda rows, missing, done, total: progress.append((missing, done, total)))
                self.assertEqual(rows, [])
                self.assertEqual(calls, [])
                self.assertEqual(progress[-1][1:], (1, 1))

    def test_missing_records_are_reported_without_empty_rows(self):
        missing = []
        rows = self.fetch("pubchem", ["2244", "999999999"], ["cid"],
                          lambda request: httpx.Response(200, json=FIXTURES["pubchem"]) if "/2244/" in request.url.path
                          else httpx.Response(404), lambda rows, ids, done, total: missing.extend(ids))
        self.assertEqual(rows, [{"cid": "2244"}])
        self.assertEqual(missing, ["999999999"])

    def test_graphql_schema_errors_are_visible_and_do_not_become_blank_successes(self):
        with self.assertRaisesRegex(ValueError, "Cannot query field"):
            self.fetch("gnomad", [CASES["gnomad"][0]], ["variant_id"],
                       lambda request: httpx.Response(200, json={"errors": [{"message": "Cannot query field badField"}]}))
        rows = self.fetch("gnomad", [CASES["gnomad"][0]], ["variant_id"],
                          lambda request: httpx.Response(200, json={"errors": [{"message": "Variant not found"}]}))
        self.assertEqual(rows, [])

    def test_zero_allele_counts_and_missing_exomes_remain_distinct(self):
        data = {"data": {"variant": {"variant_id": CASES["gnomad"][0], "exome": None, "genome": {"ac": 0, "an": 100, "af": 0.0}}}}
        rows = self.fetch("gnomad", [CASES["gnomad"][0]], ["exome_ac", "genome_ac", "genome_af"],
                          lambda request: httpx.Response(200, json=data))
        self.assertEqual(rows, [{"exome_ac": "", "genome_ac": "0", "genome_af": "0.0"}])

    def test_clinvar_accessions_resolve_to_variation_summaries(self):
        seen = []
        def handler(request):
            seen.append(request)
            if request.url.path.endswith("esearch.fcgi"):
                self.assertEqual(request.url.params["term"], "RCV000007998")
                return httpx.Response(200, json={"esearchresult": {"idlist": ["7105"],
                    "errorlist": {"phrasesnotfound": [], "fieldsnotfound": []}}})
            self.assertEqual(request.url.params["id"], "7105")
            return httpx.Response(200, json=FIXTURES["clinvar"])
        rows = self.fetch("clinvar", ["VCV000007105", "RCV000007998"], ["variation_id"], handler)
        self.assertEqual(rows, [{"variation_id": "7105"}, {"variation_id": "7105"}])
        self.assertEqual(sum(r.url.path.endswith("esearch.fcgi") for r in seen), 1)

    def test_geo_uses_exact_accessions_not_related_studies(self):
        expected = {"507": "GDS507", "100000096": "GPL96", "200000100": "GSE100"}
        def handler(request):
            self.assertTrue(request.url.path.endswith("esummary.fcgi"))
            uid = request.url.params["id"]
            return httpx.Response(200, json={"result": {uid: {"accession": expected[uid]}}})
        rows = self.fetch("geo", ["GDS507", "GPL96", "GSE100"], ["accession"], handler)
        self.assertEqual(rows, [{"accession": value} for value in expected.values()])
        rows = self.fetch("geo", ["GPL96"], ["accession"],
                          lambda request: httpx.Response(200, json={"result": {"100000096": {"accession": "GSE123"}}}))
        self.assertEqual(rows, [])

    def test_opentargets_drug_uses_current_clinical_stage_field(self):
        def handler(request):
            body = json.loads(request.content)
            self.assertIn("maximumClinicalStage", body["query"])
            self.assertEqual(body["variables"], {"id": "CHEMBL25"})
            return httpx.Response(200, json={"data": {"drug": {"id": "CHEMBL25", "name": "ASPIRIN", "maximumClinicalStage": "APPROVAL"}}})
        rows = self.fetch("opentargets", ["CHEMBL25"], ["name", "clinical_stage"], handler)
        self.assertEqual(rows, [{"name": "ASPIRIN", "clinical_stage": "APPROVAL"}])
        with self.assertRaisesRegex(ValueError, "Invalid query"):
            self.fetch("opentargets", ["CHEMBL25"], ["name"],
                       lambda request: httpx.Response(400, json={"errors": [{"message": "Invalid query"}]}))

    def test_dailymed_full_label_is_opt_in_and_extracts_xml_text(self):
        calls = []
        def handler(request):
            calls.append(request.url.path)
            if request.url.path.endswith(".xml"):
                return httpx.Response(200, text='<document xmlns="urn:hl7-org:v3"><section><text>Use <paragraph>only as directed.</paragraph></text></section></document>')
            return httpx.Response(200, json=FIXTURES["dailymed"])
        identifier = CASES["dailymed"][0]
        self.fetch("dailymed", [identifier], ["title"], handler)
        self.assertEqual(len(calls), 1)
        result = self.fetch("dailymed", [identifier], ["label_text"], handler)
        self.assertEqual(result[0]["label_text"], "Use only as directed.")

    def test_cancellation_callback_stops_before_the_next_record(self):
        calls = []
        def handler(request):
            calls.append(request)
            return httpx.Response(200, json=FIXTURES["pubchem"])
        class Cancelled(Exception):
            pass
        def cancel(*args):
            raise Cancelled()
        with self.assertRaises(Cancelled):
            self.fetch("pubchem", ["2244", "3672"], ["cid"], handler, cancel)
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
