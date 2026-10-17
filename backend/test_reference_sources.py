"""Lookup sources of the Agent's search_source, against canned API responses (no network)."""

import unittest
from unittest import mock

import httpx

from agent import reference_sources as ref
from agent.source_search import SourceSearchError, describe_sources, search_source


def _client_for(handler):
    return lambda: httpx.Client(transport=httpx.MockTransport(handler), headers={"User-Agent": ref.USER_AGENT})


class ReferenceSourcesTest(unittest.TestCase):
    def run_search(self, source, query, handler, limit=20):
        with mock.patch.object(ref, "_client", _client_for(handler)):
            return search_source(source, query, limit)

    def test_europepmc_lists_importable_pmids_and_only_biorxiv_medrxiv_dois(self):
        lite = {"hitCount": 3, "resultList": {"result": [
            {"id": "123", "source": "MED", "pmid": "123"},
            {"id": "PPR1", "source": "PPR", "doi": "10.64898/a", "bookOrReportDetails": {"publisher": "bioRxiv"}},
            {"id": "PPR2", "source": "PPR", "doi": "10.21203/b", "bookOrReportDetails": {"publisher": "Research Square"}},
        ]}}
        core = {"resultList": {"result": [{"id": "PPR1", "source": "PPR", "doi": "10.64898/a", "title": "T", "pubYear": "2026",
                                           "bookOrReportDetails": {"publisher": "bioRxiv"}, "abstractText": "x " * 2000}]}}

        def handler(request):
            return httpx.Response(200, json=lite if request.url.params["resultType"] == "lite" else core)

        result = self.run_search("europepmc", "CDK2 SRC:PPR", handler)
        self.assertEqual((result["total"], result["ids"], result["pmids"], result["preprint_dois"]),
                         (3, ["123", "PPR1", "PPR2"], ["123"], ["10.64898/a"]))
        sample = result["samples"][0]
        self.assertEqual((sample["journal"], sample["year"]), ("bioRxiv", "2026"))
        self.assertLessEqual(len(sample["abstract"]), ref.TEXT_LIMIT + 1)
        self.assertTrue(sample["abstract"].endswith("…"))

    def test_openalex_rebuilds_abstracts_and_strips_url_prefixes(self):
        work = {"id": "https://openalex.org/W1", "doi": "https://doi.org/10.1/x", "display_name": "Title",
                "ids": {"pmid": "https://pubmed.ncbi.nlm.nih.gov/42"}, "publication_year": 2020, "cited_by_count": 7,
                "primary_location": {"source": {"display_name": "Journal"}},
                "abstract_inverted_index": {"kinases": [1], "Cyclin": [0], "phosphorylate": [2]}}

        def handler(request):
            self.assertLessEqual(int(request.url.params["per-page"]), ref.OPENALEX_MAX_PAGE)
            return httpx.Response(200, json={"meta": {"count": 9}, "results": [work]})

        result = self.run_search("openalex", "cyclin", handler, limit=500)
        self.assertEqual((result["total"], result["ids"], result["pmids"]), (9, ["W1"], ["42"]))
        self.assertEqual(result["samples"][0], {"id": "W1", "pmid": "42", "doi": "10.1/x", "title": "Title", "year": 2020,
                                                    "cited_by": 7, "venue": "Journal", "abstract": "Cyclin kinases phosphorylate"})

    def test_uniprot_reads_total_from_header_and_drops_inline_citations(self):
        entry = {"primaryAccession": "P24941", "uniProtkbId": "CDK2_HUMAN", "entryType": "UniProtKB reviewed (Swiss-Prot)",
                 "proteinDescription": {"recommendedName": {"fullName": {"value": "Cyclin-dependent kinase 2"}}},
                 "genes": [{"geneName": {"value": "CDK2"}}], "organism": {"scientificName": "Homo sapiens"},
                 "sequence": {"length": 298},
                 "comments": [{"commentType": "FUNCTION", "texts": [{"value": "Kinase of the cell cycle (PubMed:1, PubMed:2). Phosphorylates RB1 (PubMed:3)."}]}]}

        def handler(request):
            return httpx.Response(200, json={"results": [entry]}, headers={"x-total-results": "1"})

        result = self.run_search("uniprot", "gene:CDK2", handler)
        self.assertEqual((result["total"], result["ids"]), (1, ["P24941"]))
        self.assertEqual(result["samples"][0], {"id": "P24941", "entry_name": "CDK2_HUMAN", "reviewed": True,
                                                "protein": "Cyclin-dependent kinase 2", "genes": ["CDK2"], "organism": "Homo sapiens",
                                                "length": 298, "function": "Kinase of the cell cycle. Phosphorylates RB1."})

    def test_wikipedia_returns_titles_and_introductions(self):
        def handler(request):
            if request.url.params.get("list") == "search":
                return httpx.Response(200, json={"query": {"searchinfo": {"totalhits": 2},
                                                           "search": [{"title": "Cyclin A"}, {"title": "CDK2"}]}})
            return httpx.Response(200, json={"query": {"pages": {
                "1": {"title": "CDK2", "fullurl": "https://en.wikipedia.org/wiki/CDK2", "extract": "An enzyme."},
                "2": {"title": "Cyclin A", "fullurl": "https://en.wikipedia.org/wiki/Cyclin_A", "extract": "A protein."}}}})

        result = self.run_search("wikipedia", "cyclin", handler)
        self.assertEqual(result["ids"], ["Cyclin A", "CDK2"])
        self.assertEqual([s["id"] for s in result["samples"]], ["Cyclin A", "CDK2"])
        self.assertEqual(result["samples"][1]["summary"], "An enzyme.")

    def test_new_sources_are_searchable_and_list_their_import_fields(self):
        sources = describe_sources()
        for key in ("europepmc", "openalex", "uniprot", "wikipedia"):
            self.assertTrue(sources[key]["searchable"])
            self.assertTrue(sources[key]["fields"])
        with self.assertRaisesRegex(SourceSearchError, "europepmc"):
            search_source("preprint", "kinase")

if __name__ == "__main__":
    unittest.main()
