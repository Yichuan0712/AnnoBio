"""Auditable source coverage against the pinned official Biomni registry."""
from biomni_data_lake import FILES, GROUPS, MANIFEST
from database_availability import data_lake_enabled


def describe_coverage():
    return {
        'repository': MANIFEST['repository'], 'commit': MANIFEST['commit'], 'checked_on': MANIFEST['checked_on'],
        'scope': 'Database-source coverage and data-lake file access; not parity with every Biomni query operation.',
        'database_tools': [{'tool': tool, 'source': source} for tool, source in MANIFEST['tool_sources'].items()],
        'credentials_required': ['iucn', 'gtopdb', 'screen'], 'optional_credentials': ['synapse'],
        'data_lake_enabled': data_lake_enabled(),
        'data_lake': [{'filename': filename, 'source': source, **FILES[filename]}
                      for source, group in GROUPS.items() for filename in group['files']],
    }
