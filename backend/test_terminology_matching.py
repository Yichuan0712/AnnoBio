"""Entity resolution, source isolation, and progress/error contracts without external services."""
import asyncio
import json
import os
from pathlib import Path
import sys
import unittest
from unittest import mock

os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")
sys.path.insert(0, str(Path(__file__).resolve().parent))

import httpx
import grounding_sources as sources
import terminology_client as terminology
from score_match_primitives import build_concept_id_map, concept_pair_matches, get_match_flags, medical_concept_source


class EntityResolutionTests(unittest.TestCase):
    def resolve(self, term, source, handler):
        client = httpx.Client(transport=httpx.MockTransport(handler))
        with mock.patch.object(sources.httpx, "Client", return_value=client), mock.patch.object(sources.time, "sleep"):
            return sources.resolve_entity(term, source)

    def test_hgnc_alias_and_symbol_resolve_to_same_approved_gene(self):
        gene = {"hgnc_id": "HGNC:11998", "symbol": "TP53", "name": "tumor protein p53",
                "status": "Approved", "alias_symbol": ["P53"]}
        def handler(request):
            path = request.url.path
            if path.endswith("/symbol/P53"):
                docs = []
            else:
                docs = [gene]
            return httpx.Response(200, json={"response": {"docs": docs, "numFound": len(docs)}})
        a = self.resolve("p53", "hgnc", handler)
        b = self.resolve("TP53", "hgnc", handler)
        self.assertEqual(a["concept_id"], b["concept_id"])
        self.assertEqual(a["concept_id"], "HGNC:11998")

    def test_hgnc_ambiguous_alias_and_withdrawn_genes_are_not_accepted(self):
        def handler(request):
            path = request.url.path
            if "/alias_symbol/" in path:
                docs = [{"hgnc_id": key, "symbol": key, "alias_symbol": ["old"], "status": "Approved"}
                        for key in ("HGNC:1", "HGNC:2")]
            else:
                docs = []
            return httpx.Response(200, json={"response": {"docs": docs}})
        self.assertEqual(self.resolve("old", "hgnc", handler)["status"], "ambiguous")
        result = self.resolve("HGNC:1", "hgnc", lambda request: httpx.Response(200, json={
            "response": {"docs": [{"hgnc_id": "HGNC:1", "symbol": "OLD", "status": "Entry Withdrawn"}]}}))
        self.assertIsNone(result)

    def test_pubchem_name_cid_ambiguity_and_not_found(self):
        def handler(request):
            if "/name/" in request.url.path:
                self.assertEqual(request.url.params["name_type"], "complete")
            return httpx.Response(200, json={"IdentifierList": {"CID": [1983]}})
        for value in ("paracetamol", "acetaminophen", "CID:1983", "PUBCHEM.COMPOUND:1983"):
            self.assertEqual(self.resolve(value, "pubchem", handler)["concept_id"], "PUBCHEM.COMPOUND:1983")
        self.assertEqual(self.resolve("ambiguous", "pubchem", lambda req: httpx.Response(200,
            json={"IdentifierList": {"CID": [1, 2]}}))["status"], "ambiguous")
        self.assertIsNone(self.resolve("missing", "pubchem", lambda req: httpx.Response(404)))

    def test_ontology_exact_names_synonyms_ids_and_source_filter(self):
        def handler(request):
            source = request.url.params["ontology"]
            self.assertEqual(request.url.params["exact"], "true")
            return httpx.Response(200, json={"response": {"docs": [
                {"obo_id": "GO:999", "ontology_name": "go", "label": "unrelated"},
                {"obo_id": f"{source.upper()}:1", "ontology_name": source,
                 "label": "canonical", "synonym": ["alias"], "is_obsolete": False},
                {"obo_id": f"{source.upper()}:2", "ontology_name": source,
                 "label": "alias", "is_obsolete": True},
            ]}})
        for source in ("go", "chebi", "mondo"):
            for term in ("canonical", "alias", f"{source.upper()}:1"):
                self.assertEqual(self.resolve(term, source, handler)["concept_id"], f"{source.upper()}:1")
        self.assertIsNone(self.resolve("no exact hit", "go", handler))

    def test_service_failure_is_not_no_match(self):
        with self.assertRaises(httpx.HTTPStatusError):
            self.resolve("p53", "hgnc", lambda req: httpx.Response(503))


class TerminologyProgressTests(unittest.TestCase):
    def setUp(self):
        self.cache = mock.patch.dict(terminology._cache, {}, clear=True)
        self.persist = mock.patch.object(terminology, "_persist_cache")
        self.cache.start()
        self.persist.start()
        self.addCleanup(self.cache.stop)
        self.addCleanup(self.persist.stop)

    def test_cached_and_uncached_unique_terms_report_once_each(self):
        resolved = {"concept_id": "HGNC:1", "source": "hgnc"}
        terminology._cache[terminology._cache_key("hgnc", "cached")] = resolved
        events = []
        with mock.patch.object(terminology, "resolve_concept", return_value=resolved) as lookup:
            result = terminology.resolve_concepts_bulk(["cached", "new", "new"], source="hgnc",
                ncbi_api_key="", ncbi_email="", on_progress=lambda term, value: events.append(term))
        self.assertCountEqual(events, ["cached", "new"])
        self.assertEqual(len(result), 2)
        lookup.assert_called_once()

    def test_network_failure_does_not_poison_cache_and_can_be_retried(self):
        with mock.patch.object(terminology, "resolve_concept", side_effect=RuntimeError("offline")):
            with self.assertRaisesRegex(RuntimeError, "offline"):
                terminology.resolve_concepts_bulk(["p53"], source="hgnc", ncbi_api_key="", ncbi_email="")
        self.assertNotIn(terminology._cache_key("hgnc", "p53"), terminology._cache)

    def test_request_keys_are_preserved_for_streams_and_python_callers(self):
        events = []
        with mock.patch.object(terminology, "resolve_concept", return_value={"source": "hgnc", "concept_id": "HGNC:1"}):
            result = terminology.resolve_concepts_bulk([" p53 "], source="hgnc", ncbi_api_key="", ncbi_email="",
                on_progress=lambda term, value: events.append(term))
        self.assertIn(" p53 ", result)
        self.assertEqual(events, [" p53 "])

    def test_python_optimize_uses_source_qualified_maps(self):
        with mock.patch.object(terminology, "resolve_concepts_bulk", side_effect=lambda terms, source:
                {term: {"source": source, "concept_id": source + ":1"} for term in terms}):
            concepts = {**build_concept_id_map(["same", "alias"], "hgnc"),
                        **build_concept_id_map(["same", "other"], "pubchem")}
        self.assertTrue(concept_pair_matches("same", "alias", concepts, "hgnc"))
        self.assertTrue(concept_pair_matches("same", "other", concepts, "pubchem"))
        self.assertFalse(concept_pair_matches("same", "alias", concepts, "pubchem"))
        for flags, expected in (({"hgncMatch": True}, "hgnc"), ({"pubchemMatch": True}, "pubchem"),
                                ({"ontologyMatch": True, "ontologySource": "mondo"}, "mondo")):
            self.assertEqual(medical_concept_source(get_match_flags({"matchFlags": flags})), expected)

    def test_api_stream_reports_each_result_and_a_terminal_event(self):
        import main
        def bulk(terms, **kwargs):
            for term in terms:
                kwargs["on_progress"](term, {"concept_id": "HGNC:1", "source": "hgnc"})
            return {}
        async def collect(response):
            return [json.loads(line) async for line in response.body_iterator]
        with mock.patch.object(main, "_load_settings", return_value={}), \
             mock.patch.object(terminology, "resolve_concepts_bulk", side_effect=bulk):
            response = main.api_terminology_normalize(main.TerminologyNormalizeRequest(terms=["p53", "TP53"], source="hgnc", stream=True))
            events = asyncio.run(collect(response))
        self.assertEqual([event["type"] for event in events], ["result", "result", "done"])

    def test_api_stream_failure_is_explicit_and_has_no_done_event(self):
        import main
        async def collect(response):
            return [json.loads(line) async for line in response.body_iterator]
        with mock.patch.object(main, "_load_settings", return_value={}), \
             mock.patch.object(terminology, "resolve_concepts_bulk", side_effect=RuntimeError("offline")):
            response = main.api_terminology_normalize(main.TerminologyNormalizeRequest(terms=["p53"], source="hgnc", stream=True))
            events = asyncio.run(collect(response))
        self.assertEqual([event["type"] for event in events], ["error"])


if __name__ == "__main__":
    unittest.main()
