// Worker thread for grep. Isolated so a slow regular expression can be killed without stalling the server.
import { parentPort, workerData } from 'node:worker_threads';
import { grepRun } from './local-tools.mjs';

try { parentPort.postMessage({ ok: true, result: await grepRun(workerData.root, workerData.args) }); }
catch (e) { parentPort.postMessage({ ok: false, error: String(e?.message || e) }); }
