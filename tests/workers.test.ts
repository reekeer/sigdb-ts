import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

import { buildBytes, loadBytes } from "../src/index.ts";
import { TESTS_DIR } from "./support.ts";

test("raw sections can be transferred to a worker", async () => {
  const db = loadBytes(buildBytes({ nginx: { headers: { Server: "nginx" } }, jq: { js: "jquery" } }));
  const raw = db.rawSections();
  const buffers = Object.values(raw).map((b) => b.buffer as ArrayBuffer);
  const src = pathToFileURL(join(TESTS_DIR, "..", "src", "index.ts")).href;
  const code = `
    import { parentPort, workerData } from "node:worker_threads";
    const { Database } = await import(${JSON.stringify(src)});
    const db = Database.fromRaw(workerData.metadata, workerData.raw);
    parentPort.postMessage([db.match("Server: nginx/1").item.key, db.matchGroup("js", "jquery.min.js").item.key]);
  `;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(code)}`), {
    workerData: { metadata: db.metadata, raw },
    transferList: buffers,
  });
  const result = await new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  await worker.terminate();
  assert.deepEqual(result, ["nginx", "jq"]);
  assert.ok(buffers.every((b) => b.byteLength === 0), "buffers were transferred");
  assert.equal(db.match("Server: nginx").item?.key, "nginx");
});
