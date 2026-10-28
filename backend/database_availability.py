"""Deployment policy for downloadable Dataset sources.

Local/desktop backends enable snapshots. The hosted backend image disables them explicitly.
"""
import os


def data_lake_enabled():
    return os.environ.get('ANNOBIO_ENABLE_DATA_LAKE', '1').strip().lower() in ('1', 'true', 'yes', 'on')


def source_enabled(importer):
    return importer.get('kind') != 'snapshot' or data_lake_enabled()


def require_data_lake():
    if not data_lake_enabled():
        raise ValueError('Downloadable dataset imports are disabled on this server. Use the desktop app.')
