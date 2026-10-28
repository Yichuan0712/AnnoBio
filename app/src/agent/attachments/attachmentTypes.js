/**
 * Which files can be attached to an Agent chat (desktop app; docs/design/AGENT_ATTACHMENTS_PLAN.md),
 * shared by the main process, which only reads these, and the chat. Tables, images and PDFs are the
 * kinds Create Dataset imports; documents, text and code are for the Agent to read.
 */
import { TABLE_FILE_EXTENSIONS, IMAGE_FILE_EXTENSIONS, DOCUMENT_FILE_EXTENSIONS, fileExtension } from '../../fileTypes.js';

const MB = 1024 * 1024;

const EXTENSIONS = {
  table: TABLE_FILE_EXTENSIONS,
  image: IMAGE_FILE_EXTENSIONS,
  document: DOCUMENT_FILE_EXTENSIONS,
  pdf: ['pdf'],
  text: [
    // Text, markup and config
    'txt', 'text', 'md', 'markdown', 'mdx', 'rst', 'adoc', 'asciidoc', 'org', 'tex', 'bib', 'rtf', 'log', 'out', 'diff', 'patch',
    'jsonc', 'json5', 'geojson', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'config', 'properties',
    'xml', 'xsd', 'xsl', 'xslt', 'svg', 'html', 'htm', 'xhtml', 'css', 'scss', 'sass', 'less', 'styl',
    'gitignore', 'dockerignore', 'editorconfig', 'gitattributes', 'rprofile', 'renviron',
    // Biology and chemistry text formats
    'fasta', 'fa', 'fna', 'faa', 'ffn', 'fastq', 'fq', 'gb', 'gbk', 'genbank', 'embl', 'gff', 'gff3', 'gtf', 'bed', 'bedgraph',
    'wig', 'vcf', 'sam', 'psl', 'maf', 'aln', 'sto', 'phy', 'nwk', 'newick', 'nex', 'pdb', 'cif', 'mmcif', 'mol', 'mol2',
    'sdf', 'smi', 'smiles', 'xyz', 'mzml', 'obo', 'owl', 'ttl', 'rdf', 'nt', 'nq',
    // Code: data science and scientific
    'py', 'pyw', 'pyi', 'pyx', 'pxd', 'ipynb', 'r', 'rmd', 'qmd', 'rnw', 'jl', 'm', 'sas', 'do', 'ado', 'stan',
    'smk', 'nf', 'wdl', 'cwl', 'f', 'for', 'f77', 'f90', 'f95', 'f03', 'f08', 'ijs', 'apl',
    // Code: web and scripting
    'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte', 'astro', 'coffee', 'php', 'phtml', 'rb', 'erb',
    'pl', 'pm', 'pod', 'lua', 'tcl', 'awk', 'sed', 'sh', 'bash', 'zsh', 'fish', 'ksh', 'csh', 'ps1', 'psm1', 'psd1',
    'bat', 'cmd', 'vbs', 'applescript', 'ahk', 'vim',
    // Code: compiled and systems
    'c', 'h', 'cpp', 'cc', 'cxx', 'c++', 'hpp', 'hh', 'hxx', 'h++', 'ino', 'cu', 'cuh', 'cl', 'm', 'mm', 'cs', 'csx',
    'fs', 'fsi', 'fsx', 'vb', 'java', 'kt', 'kts', 'scala', 'sc', 'groovy', 'gradle', 'go', 'rs', 'swift', 'dart',
    'zig', 'nim', 'd', 'cr', 'v', 'sv', 'svh', 'vhd', 'vhdl', 'asm', 's', 'ada', 'adb', 'ads', 'pas', 'pp', 'cob', 'cbl',
    'sol', 'glsl', 'hlsl', 'wgsl', 'metal',
    // Code: functional and other languages
    'hs', 'lhs', 'ml', 'mli', 'elm', 'ex', 'exs', 'erl', 'hrl', 'clj', 'cljs', 'cljc', 'edn', 'lisp', 'lsp', 'cl', 'el',
    'scm', 'ss', 'rkt', 'purs', 're', 'rei', 'res', 'resi', 'lean', 'agda', 'idr', 'pro', 'prolog', 'raku', 'rakumod',
    // Queries, schemas, build and infrastructure
    'sql', 'psql', 'mysql', 'pgsql', 'graphql', 'gql', 'sparql', 'rq', 'cypher', 'proto', 'thrift', 'avsc', 'cmake',
    'mk', 'make', 'mak', 'ninja', 'bazel', 'bzl', 'nix', 'tf', 'tfvars', 'hcl', 'dockerfile', 'containerfile', 'jenkinsfile',
    'cabal', 'gemspec', 'podspec', 'csproj', 'fsproj', 'vbproj', 'sln', 'pom', 'lock', 'mod', 'sum', 'toml',
  ],
};

// Text and code files usually saved without an extension, by lower-case name.
const TEXT_FILE_NAMES = new Set([
  'dockerfile', 'containerfile', 'makefile', 'gnumakefile', 'cmakelists.txt', 'snakefile', 'nextflow.config', 'rakefile',
  'gemfile', 'podfile', 'procfile', 'jenkinsfile', 'vagrantfile', 'brewfile', 'justfile', 'pipfile', 'build', 'workspace',
  'readme', 'license', 'licence', 'notice', 'authors', 'contributors', 'changelog', 'changes', 'news', 'todo', 'copying',
  'description', 'namespace', 'requirements.txt', 'environment.yml', 'manifest.in', 'setup.cfg', 'tox.ini',
]);

// Images and PDFs as in Create Dataset (projectAssets.js, asset_store.py).
export const ATTACHMENT_MAX_BYTES = { table: 20 * MB, image: 30 * MB, pdf: 50 * MB, text: 20 * MB, document: 20 * MB };
export const MAX_ATTACHMENTS_PER_MESSAGE = 20;

const KIND_BY_EXTENSION = new Map(Object.entries(EXTENSIONS).flatMap(([kind, list]) => list.map((ext) => [ext, kind])));

/** 'table' | 'image' | 'pdf' | 'document' | 'text', or '' when unsupported. */
export function attachmentKind(name) {
  const baseName = String(name || '').split(/[/\\]/).pop().toLowerCase();
  if (TEXT_FILE_NAMES.has(baseName)) return 'text';
  return KIND_BY_EXTENSION.get(fileExtension(baseName)) || '';
}

/** Why a file of `kind` (attachmentKind, or 'text' from looksLikeText) cannot be attached, or '' when it can. */
export function attachmentProblem(kind, size) {
  if (!ATTACHMENT_MAX_BYTES[kind]) return 'This file type cannot be attached.';
  if (Number(size) > ATTACHMENT_MAX_BYTES[kind]) return `Files of this type must be under ${ATTACHMENT_MAX_BYTES[kind] / MB} MB.`;
  return '';
}

// How much of a file with an unknown extension looksLikeText checks.
export const TEXT_SNIFF_BYTES = 8192;

/**
 * Whether the start of a file reads as text: valid UTF-8 and no NUL bytes. Lets a code or text file
 * whose extension is not listed above be attached as 'text'.
 */
export function looksLikeText(bytes) {
  if (!bytes?.length) return true;
  if (bytes.includes(0)) return false;
  try {
    // stream: a character cut off at the end of the sample is not an error.
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * A user message's attachments as saved with the chat (agentWindowModal.js, and main.js for desktop
 * projects): {id, name, path, kind, size, preview}; preview is what the model was shown.
 */
export function normalizeStoredAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => item && typeof item === 'object' && String(item.id || '').trim())
    .map((item) => ({
      id: String(item.id).trim(),
      name: String(item.name || ''),
      path: String(item.path || ''),
      kind: item.kind === 'folder' ? 'folder' : attachmentKind(item.name) || String(item.kind || ''),
      size: Number(item.size) || 0,
      ...(item.grantId ? { grantId: String(item.grantId) } : {}),
      ...(['file', 'folder'].includes(item.pathType) ? { pathType: item.pathType } : {}),
      ...(item.relativePath ? { relativePath: String(item.relativePath) } : {}),
      ...(item.revoked ? { revoked: true } : {}),
      ...(item.error ? { error: String(item.error) } : {}),
      ...(item.preview != null ? { preview: String(item.preview) } : {}),
    }));
}

/** Filters for the open dialog. */
export function attachmentDialogFilters() {
  const unique = (list) => [...new Set(list)];
  const all = unique(Object.values(EXTENSIONS).flat());
  return [
    { name: 'Supported files', extensions: all },
    { name: 'Tables', extensions: EXTENSIONS.table },
    { name: 'Documents and presentations', extensions: EXTENSIONS.document },
    { name: 'Images', extensions: EXTENSIONS.image },
    { name: 'PDF', extensions: EXTENSIONS.pdf },
    { name: 'Text and code', extensions: unique(EXTENSIONS.text) },
    // Files with no extension (Dockerfile, Makefile, ...) only show here; others are turned away with a reason.
    { name: 'All files', extensions: ['*'] },
  ];
}
