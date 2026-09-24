/**
 * Process-code helpers shared by the canvas, editor, and agent tools.
 *
 * A Process node has one public contract: ``process(df) -> pandas.DataFrame``.  Older
 * projects may still contain ``process(row)`` source.  We keep those projects runnable by
 * wrapping the old function in an equivalent dataframe processor when they are first opened.
 */

const DATAFRAME_PROCESS = /^\s*def\s+process\s*\(\s*df\b[^)]*\)/m;
const ROW_PROCESS = /^(\s*)def\s+process(\s*\(\s*row\b[^)]*\))/m;

export function isDataframeProcessCode(value) {
  return DATAFRAME_PROCESS.test(String(value ?? ''));
}

export function isLegacyRowProcessCode(value) {
  return ROW_PROCESS.test(String(value ?? ''));
}

/**
 * Convert a saved ``process(row)`` function into the current dataframe contract.
 *
 * The adapter preserves the legacy semantics: a ``None`` result omits a row, scalar results
 * become a ``result`` column, and a failure becomes an ``error`` row instead of aborting the
 * full dataset.  It intentionally leaves user code intact apart from renaming its entry point.
 */
export function migrateRowProcessCode(value) {
  const source = String(value ?? '').trim();
  if (!source || !isLegacyRowProcessCode(source)) return null;
  const renamed = source.replace(ROW_PROCESS, '$1def _annobio_legacy_row_process$2');
  return `# Migrated from this project's legacy process(row) function by AnnoBio.
import pandas as pd

${renamed}


def process(df):
    """Apply the legacy row transform while exposing AnnoBio's dataframe contract."""
    output = []
    records = df.where(pd.notna(df), None).to_dict(orient="records")
    for row in records:
        try:
            result = _annobio_legacy_row_process(dict(row))
            if result is None:
                continue
            output.append(dict(result) if isinstance(result, dict) else {"result": result})
        except Exception as exc:
            output.append({"error": str(exc)})
    return pd.DataFrame(output)
`;
}

/** Return a dataframe processor from either the current or legacy saved fields. */
export function resolveDataframeProcessCode({ dfCode, code } = {}) {
  const current = String(dfCode ?? '').trim();
  if (current) return current;
  return migrateRowProcessCode(code);
}
