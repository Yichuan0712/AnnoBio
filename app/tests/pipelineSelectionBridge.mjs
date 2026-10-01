// Used by the Python compiler's integration test: the actual browser-side pure functions.
import { detectPipelines } from '../src/pipelineDetection.js';
import { buildSelectedRoute, exportRoutePayload } from '../src/pipelineRouteSelection.js';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const pipelines = detectPipelines(JSON.parse(input));
if (pipelines.length !== 1) throw new Error('Fixture must select exactly one pipeline');
process.stdout.write(JSON.stringify(exportRoutePayload(buildSelectedRoute(pipelines[0], new Map()))));
