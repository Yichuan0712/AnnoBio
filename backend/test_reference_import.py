"""Import by id from Europe PMC, OpenAlex, UniProt and Wikipedia, against canned API responses (no network)."""

import unittest
from unittest import mock

import httpx

import reference_import as ri


def _client_for(handler, seen=None):
    def wrapped(request):
        if seen is not None:
            seen.append(request)
        return handler(request)
    return lambda: httpx.Client(transport=httpx.MockTransport(wrapped))


class ReferenceImportTest(unittest.TestCase):
    def fetch(self, source, ids, fields, handler, seen=None):
        batches = []
        with mock.patch.object(ri, "_client", _client_for(handler, seen)), mock.patch.object(ri, "BATCH_DELAY_SEC", 0):
            rows = ri.fetch_records(source, ids, fields, on_batch=lambda rows, missing, done, total: batches.append((len(rows), missing, done, total)))
        return rows, batches

    def test_europepmc_matches_pmcids_and_preprints_back_to_the_requested_ids(self):
        def handler(request):
            query = request.url.params["query"]
            self.assertIn("PMCID:PMC5", query)
            self.assertIn("(EXT_ID:PPR7 AND SRC:PPR)", query)
            return httpx.Response(200, json={"resultList": {"result": [
                {"id": "42", "source": "MED", "pmid": "42", "pmcid": "PMC5", "title": "<i>CDK2</i> paper",
                 "abstractText": "<h4>Aim</h4>Find substrates.", "journalInfo": {"journal": {"title": "J"}},
                 "meshHeadingList": {"meshHeading": [{"descriptorName": "Humans"}, {"descriptorName": "Kinases"}]}, "isOpenAccess": "Y"},
                {"id": "PPR7", "source": "PPR", "doi": "10.64898/x", "bookOrReportDetails": {"publisher": "bioRxiv"}},
            ]}})

        rows, batches = self.fetch("europepmc", ["pmc5", "PPR7", "pmid:99", "not-an-id"], ["id", "title", "journal", "abstract", "mesh_terms", "is_open_access"], handler)
        self.assertEqual(rows, [
            {"id": "42", "title": "CDK2 paper", "journal": "J", "abstract": "Aim Find substrates.", "mesh_terms": "Humans; Kinases", "is_open_access": "Yes"},
            {"id": "PPR7", "title": "", "journal": "bioRxiv", "abstract": "", "mesh_terms": "", "is_open_access": ""},
        ])
        self.assertEqual(batches, [(0, ["not-an-id"], 1, 4), (2, ["99"], 4, 4)])

    def test_openalex_queries_work_ids_and_dois_separately_and_ignores_case_of_dois(self):
        def handler(request):
            name, values = request.url.params["filter"].split(":", 1)
            works = {"openalex": [{"id": "https://openalex.org/W1", "display_name": "One", "abstract_inverted_index": {"b": [1], "a": [0]}}],
                     "doi": [{"id": "https://openalex.org/W2", "doi": "https://doi.org/10.1234/ABC", "authorships": [{"author": {"display_name": "X"}}]}]}[name]
            return httpx.Response(200, json={"results": works})

        rows, batches = self.fetch("openalex", ["https://openalex.org/w1", "doi:10.1234/abc", "10.2345/missing"], ["openalex_id", "doi", "title", "authors", "abstract"], handler)
        self.assertEqual(rows, [
            {"openalex_id": "W1", "doi": "", "title": "One", "authors": "", "abstract": "a b"},
            {"openalex_id": "W2", "doi": "10.1234/ABC", "title": "", "authors": "X", "abstract": ""},
        ])
        self.assertEqual(batches[-1][1], ["10.2345/missing"])

    def test_uniprot_sends_only_well_formed_accessions(self):
        seen = []

        def handler(request):
            return httpx.Response(200, json={"results": [{
                "primaryAccession": "P24941", "uniProtkbId": "CDK2_HUMAN", "entryType": "UniProtKB reviewed (Swiss-Prot)",
                "proteinDescription": {"recommendedName": {"fullName": {"value": "CDK2"}, "ecNumbers": [{"value": "2.7.11.22"}]}},
                "comments": [{"commentType": "FUNCTION", "texts": [{"value": "Kinase (PubMed:1, PubMed:2)."}]},
                             {"commentType": "SUBCELLULAR LOCATION", "subcellularLocations": [{"location": {"value": "Nucleus"}}, {"location": {"value": "Nucleus"}}]}],
                "uniProtKBCrossReferences": [{"database": "GO", "properties": [{"key": "GoTerm", "value": "C:nucleus"}]}, {"database": "PDB"}],
                "sequence": {"length": 298, "value": "MEN"},
            }]})

        rows, batches = self.fetch("uniprot", ["p24941", "BAD!", "Q9ZZZ9"], ["accession", "reviewed", "function", "subcellular_location", "ec_number", "go_terms", "length"], handler, seen)
        self.assertEqual(seen[0].url.params["accessions"], "P24941,Q9ZZZ9")
        self.assertEqual(rows, [{"accession": "P24941", "reviewed": "Yes", "function": "Kinase.", "subcellular_location": "Nucleus",
                                 "ec_number": "2.7.11.22", "go_terms": "C:nucleus", "length": "298"}])
        self.assertEqual([b[1] for b in batches], [["BAD!"], ["Q9ZZZ9"]])

    def test_wikipedia_follows_normalization_and_redirects_and_fetches_full_text_per_page(self):
        def handler(request):
            params = request.url.params
            if "pageids" in params:
                return httpx.Response(200, json={"query": {"pages": [{"extract": f"Full {params['pageids']}"}]}})
            return httpx.Response(200, json={"query": {
                "normalized": [{"from": "cdk2", "to": "CDK2"}],
                "redirects": [{"from": "CDK2", "to": "Cyclin-dependent kinase 2"}],
                "pages": [{"title": "Cyclin-dependent kinase 2", "pageid": 9, "fullurl": "https://en.wikipedia.org/wiki/Cyclin-dependent_kinase_2",
                           "description": "Protein found in humans", "extract": "Intro."},
                          {"title": "Nope", "missing": True}],
            }})

        rows, batches = self.fetch("wikipedia", ["cdk2", "https://en.wikipedia.org/wiki/Nope"], ["title", "description", "summary", "full_text"], handler)
        self.assertEqual(rows, [{"title": "Cyclin-dependent kinase 2", "description": "Protein found in humans", "summary": "Intro.", "full_text": "Full 9"}])
        self.assertEqual(batches[-1][1], ["Nope"])

    def test_ids_are_deduplicated_in_order(self):
        seen = []
        rows, _ = self.fetch("uniprot", ["P24941", "p24941", "P06493"], ["accession"], lambda request: httpx.Response(200, json={"results": []}), seen)
        self.assertEqual(seen[0].url.params["accessions"], "P24941,P06493")
        self.assertEqual(rows, [])


if __name__ == "__main__":
    unittest.main()
