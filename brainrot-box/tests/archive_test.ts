// #130 — durable external archive + reusable tool library.
// Covers the issue's acceptance: content-addressed tool archive (generation + eviction, dedup by
// hash), gzipped trace flush + bounded rotating buffer, boot reseed from the library, and the
// kill+restart round-trip ("an evicted tool is recoverable"). All offline — a stub StreamProvider
// stands in for the toolsmith LLM and a temp LocalArchiveBackend stands in for the external store.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import handler, {
  ArchiveBackend,
  ArchiveToolRecord,
  ArchiveTraceEntry,
  GoodpointRuntime,
  LocalArchiveBackend,
  TraceStore,
  STARTER_TOOLS,
  buildArchive,
  toolHash,
} from "../server.ts";

const env = {
  OAUTH3_CORE: "https://core.example/oauth3",
  OTTER_TOKEN: "tok-otter-test",
  NEAR_API_KEY: "near-test",
  CHUTES_API_KEY: "chutes-test",
};

// A generated tool the smoke test accepts (no clearRect, valid canvas calls).
const genDraw = "(ctx,p,t,w,h,txt)=>{ctx.globalAlpha=0.5;ctx.fillStyle='hsl(200,80%,55%)';ctx.fillRect(10,10,p.speed*10,10);}";
const genToolJson = (name: string, draw = genDraw) =>
  JSON.stringify({ name, desc: "a generated layer", params: [{ name: "speed", default: 1, min: 0, max: 3 }], draw });

Deno.test("#130 toolHash: sha256 hex of the draw body; identical bodies collide, different diverge", async () => {
  const h1 = await toolHash(genDraw);
  const h2 = await toolHash(genDraw);
  const h3 = await toolHash(genDraw + " ");
  assertEquals(h1, h2, "identical draw → identical hash (dedup identity)");
  assert(h1 !== h3, "different draw → different hash");
  assert(/^[0-9a-f]{64}$/.test(h1), "hash is 64-char lowercase hex");
});

Deno.test("#130 LocalArchiveBackend: tools dedup by hash; blobs are content-addressed; traces gzip round-trip", async () => {
  const dir = await Deno.makeTempDir();
  const a = new LocalArchiveBackend(dir);
  const draw = "ctx=>{}";
  const hash = await toolHash(draw);
  // archive the "same" tool twice (two sessions, identical draw) → one library entry
  await a.putTool({ name: "aurora_a", desc: "d", params: [], draw, session: "s1", ts: 1, hash });
  await a.putTool({ name: "aurora_b", desc: "d-newer", params: [], draw, session: "s2", ts: 2, hash });
  const tools = await a.listTools();
  assertEquals(tools.length, 1, "identical draw bodies dedup to one entry");
  assertEquals(tools[0].hash, hash);
  assertEquals(tools[0].ts, 2, "newest write wins for the shared hash");

  // blob content-addressing: put then idempotent re-put
  const blobHash = "a".repeat(64);
  assertEquals(await a.putBlob(blobHash, new Uint8Array([1, 2, 3])), null);
  assertEquals(await a.hasBlob(blobHash), true);
  assertEquals(await a.putBlob(blobHash, new Uint8Array([1, 2, 3])), null, "re-put is a no-op");
  assertEquals(await a.hasBlob("b".repeat(64)), false);
  assertEquals(await a.putBlob("not-a-hex", new Uint8Array()), "invalid hash", "unsafe hash rejected");

  // trace gzip round-trip
  const payload = new TextEncoder().encode('{"seq":1,"ev":{"type":"segment"}}\n{"seq":2,"ev":{"type":"tool"}}\n');
  assertEquals(await a.putTrace("sess-1", payload), null);
  const list = await a.listTraces();
  assertEquals(list.length, 1);
  assertEquals(list[0].id, "sess-1");
  const back = await a.readTrace("sess-1");
  assert(back && back.every((b, i) => b === payload[i]), "stored bytes round-trip exactly");
  assertEquals(await a.readTrace("../../etc/passwd"), null, "path-traversal id rejected");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("#130 archiveTool records {name,desc,params,draw,session,ts,hash} on generation", async () => {
  const archive = new LocalArchiveBackend(await Deno.makeTempDir());
  const traceDir = await Deno.makeTempDir();
  const rt = new GoodpointRuntime(env, undefined, {
    complete: async () => genToolJson("gen_aurora"),
  }, new TraceStore(traceDir), undefined, undefined, archive);
  await rt.toolsmithTurn(AbortSignal.timeout(5000));

  const tools = await archive.listTools();
  assertEquals(tools.length, 1, "the generated tool was archived");
  const rec = tools[0];
  assertEquals(rec.name, "gen_aurora");
  assertEquals(rec.desc, "a generated layer");
  assertEquals(rec.params.length, 1);
  assertEquals(rec.params[0].name, "speed");
  assertEquals(rec.draw, genDraw);
  assertEquals(rec.hash, await toolHash(genDraw));
  assertEquals(rec.session, rt.traces!.id, "session is the current trace stem");
  assert(rec.ts > 0);
  await Deno.remove(archive.dir, { recursive: true });
  await Deno.remove(traceDir, { recursive: true });
});

Deno.test("#130 archiveTool on eviction: evicted generated tools land in the library before deletion", async () => {
  const archive = new LocalArchiveBackend(await Deno.makeTempDir());
  const rt = new GoodpointRuntime({ ...env, MAX_TOOLS: String(STARTER_TOOLS.length + 1) }, undefined, undefined, null, undefined, undefined, archive);
  // 3 generated tools, each a DISTINCT draw body → distinct hashes (else dedup collapses them)
  const mk = (n: string) => ({ name: n, desc: "gen", params: [], draw: `(ctx,p,t,w,h)=>{ctx.fillRect(0,0,${n.charCodeAt(1) * 7},1)}` });
  rt.registry.set("g1", mk("g1"));
  rt.registry.set("g2", mk("g2"));
  rt.registry.set("g3", mk("g3"));
  await rt.evictTools();

  const tools = await archive.listTools();
  assertEquals(tools.length, 2, "2 generated tools were evicted past the cap and archived");
  assert(rt.registry.size === STARTER_TOOLS.length + 1, "registry back at the cap");
  const names = tools.map((t) => t.name).sort();
  assertEquals(names, ["g1", "g2"], "oldest generated tools evicted + archived (LRU)");
  await Deno.remove(archive.dir, { recursive: true });
});

Deno.test("#130 flushArchive: gzips every local trace, prunes the buffer to TRACE_KEEP (open session kept)", async () => {
  const archive = new LocalArchiveBackend(await Deno.makeTempDir());
  const traceDir = await Deno.makeTempDir();
  const rt = new GoodpointRuntime({ ...env, TRACE_KEEP: "3" }, undefined, undefined, new TraceStore(traceDir), undefined, undefined, archive);
  const openSession = rt.traces!.id;
  rt.push({ type: "segment", segment: { order: 1, text: "hello", t: 0 } });
  // simulate 5 closed older sessions on disk
  for (let i = 0; i < 5; i++) {
    Deno.writeTextFileSync(`${traceDir}/2026-01-0${i}T00-00-00-000Z-aaaaaaa${i}.jsonl`, '{"seq":1,"ev":{"type":"segment"}}\n');
  }
  const r = await rt.flushArchive(1234);
  assertEquals(r.ok, true);
  assert(r.flushed >= 6, "every local trace (open + 5 closed) flushed");

  const archived = await archive.listTraces();
  assert(archived.some((t) => t.id === openSession), "the open session was flushed to the archive");
  // buffer pruned to TRACE_KEEP (open + 2 newest closed survive)
  const remaining = rt.traces!.list();
  assertEquals(remaining.length, 3, "rotating buffer pruned to TRACE_KEEP");
  assert(remaining.some((t) => t.id === openSession), "the open session is never pruned");
  assertEquals(rt.archiveLastOk, 1234);
  assertEquals(rt.archiveLastErr, "");
  assertEquals(rt.archiveFlushed, r.flushed);
  await Deno.remove(archive.dir, { recursive: true });
  await Deno.remove(traceDir, { recursive: true });
});

// Acceptance bullet 5 (verbatim shape): offline, stub streams + temp local-mock external store;
// kill + restart the runtime → library + traces reload from the archive, and an evicted tool is
// recoverable.
Deno.test("#130 kill+restart: an evicted tool is re-seeded from the archive; traces survive on the archive", async () => {
  const archiveDir = await Deno.makeTempDir();
  const traceDir1 = await Deno.makeTempDir();

  // --- session 1: generate a tool, evict it, flush to the durable archive ---
  const archive1 = new LocalArchiveBackend(archiveDir);
  const rt1 = new GoodpointRuntime(env, undefined, {
    complete: async () => genToolJson("gen_recover_me"),
  }, new TraceStore(traceDir1), undefined, undefined, archive1);
  await rt1.toolsmithTurn(AbortSignal.timeout(5000)); // generates + archives gen_recover_me
  // force it out of the registry by dropping the cap below starters+1 and evicting
  rt1.cfg = { ...rt1.cfg, maxTools: STARTER_TOOLS.length };
  await rt1.evictTools();
  assert(!(rt1.registry.has("gen_recover_me")), "tool evicted from session 1");
  const session1 = rt1.traces!.id;
  await rt1.flushArchive();

  // --- "kill": a fresh pod boots with an EMPTY local trace dir but the SAME external archive ---
  const traceDir2 = await Deno.makeTempDir(); // empty — the pod's local buffer was lost on redeploy
  const archive2 = new LocalArchiveBackend(archiveDir); // same volume
  const rt2 = new GoodpointRuntime({ ...env, SEED_FROM_LIBRARY: "true" }, undefined, undefined, new TraceStore(traceDir2), undefined, undefined, archive2);
  await rt2.bootSeedPromise;

  // the evicted tool is recoverable — re-seeded into the fresh registry
  assert(rt2.registry.has("gen_recover_me"), "evicted tool recovered from the library in session 2");
  const seeded = rt2.events.find((e) => (e.ev as any).type === "tool" && (e.ev as any).seeded === true);
  assert(seeded, "the recovered tool was announced as a seeded tool event");

  // nothing lost on redeploy: the session-1 trace is readable from the archive (local /traces is empty)
  assertEquals(rt2.traces!.list().length, 1, "session 2 has only its own fresh local trace");
  const archived = await archive2.listTraces();
  assert(archived.some((t) => t.id === session1), "session-1 trace lives on the archive after the pod reset");

  // dedup by hash held: library has exactly one entry for gen_recover_me
  const lib = await archive2.listTools();
  assertEquals(lib.filter((t) => t.name === "gen_recover_me").length, 1);

  for (const d of [archiveDir, traceDir1, traceDir2]) await Deno.remove(d, { recursive: true });
});

Deno.test("#130 routes: /tools/library, /archive/flush, /archive/traces(+id), and /diag archive block", async () => {
  const archive = new LocalArchiveBackend(await Deno.makeTempDir());
  const traceDir = await Deno.makeTempDir();
  const rt = new GoodpointRuntime(env, undefined, undefined, new TraceStore(traceDir), undefined, undefined, archive);
  await rt.archiveTool({ name: "lib_tool", desc: "from library", params: [], draw: genDraw });
  rt.push({ type: "segment", segment: { order: 1, text: "archive me", t: 0 } });

  // GET /tools/library
  let res = await handler(new Request("https://app.example/tools/library"), { runtime: rt });
  assertEquals(res.status, 200);
  let body = await res.json();
  assertEquals(body.backend, "local");
  assertEquals(body.tools.length, 1);
  assertEquals(body.tools[0].name, "lib_tool");

  // POST /archive/flush
  res = await handler(new Request("https://app.example/archive/flush", { method: "POST" }), { runtime: rt });
  assertEquals(res.status, 200);
  body = await res.json();
  assertEquals(body.ok, true);
  assert(body.flushed >= 1, "at least the open session flushed");
  assertEquals(body.backend, "local");

  // GET /archive/traces
  res = await handler(new Request("https://app.example/archive/traces"), { runtime: rt });
  body = await res.json();
  assert(body.traces.length >= 1);
  const id = body.traces[0].id;

  // GET /archive/traces/<id> → gunzipped NDJSON round-trips the events
  res = await handler(new Request(`https://app.example/archive/traces/${id}`), { runtime: rt });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "application/x-ndjson");
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  assert(lines.some((l: any) => l.ev?.type === "segment"), "flushed trace round-trips through the gunzip route");

  // GET /archive/traces/<bogus> 404s
  res = await handler(new Request("https://app.example/archive/traces/does-not-exist"), { runtime: rt });
  assertEquals(res.status, 404);

  // GET /diag exposes the archive block
  res = await handler(new Request("https://app.example/diag"), { runtime: rt });
  body = await res.json();
  assertEquals(body.archive.backend, "local");
  assert(body.archive.flushed >= 1);
  assert(body.archive.last_ok > 0);
  assertEquals(body.archive.last_err, "");

  await Deno.remove(archive.dir, { recursive: true });
  await Deno.remove(traceDir, { recursive: true });
});

Deno.test("#130 no-fallback: a failing backend surfaces a status event on put + sets last_err on flush", async () => {
  // mock backend that always fails writes
  const failing: ArchiveBackend = {
    name: "mock-fail",
    async putTool() { return "mock putTool failure"; },
    async listTools() { return []; },
    async putBlob() { return "mock putBlob failure"; },
    async hasBlob() { return false; },
    async putTrace() { return "mock putTrace failure"; },
    async listTraces() { return []; },
    async readTrace() { return null; },
  };
  const rt = new GoodpointRuntime(env, undefined, undefined, new TraceStore(await Deno.makeTempDir()), undefined, undefined, failing);
  await rt.archiveTool({ name: "x", desc: "d", params: [], draw: "ctx=>{}" });
  const status = rt.events.find((e) =>
    (e.ev as any).type === "status" && typeof (e.ev as any).text === "string" && (e.ev as any).text.includes("archive putTool failed"),
  );
  assert(status, "a putTool failure surfaced as a status event (no silent swallow)");

  const r = await rt.flushArchive();
  assertEquals(r.ok, false, "flush reports failure");
  assert(rt.archiveLastErr.includes("mock putTrace failure"), "last_err records the flush failure");
  await Deno.remove(rt.traces!.dir, { recursive: true });
});

Deno.test("#130 buildArchive: opt-in via ARCHIVE_DIR; ARCHIVE_BACKEND=none and unimplemented backends disable", () => {
  assertEquals(buildArchive({}), null, "no ARCHIVE_DIR → disabled");
  assertEquals(buildArchive({ ARCHIVE_DIR: "/tmp/x" })?.name, "local");
  assertEquals(buildArchive({ ARCHIVE_DIR: "/tmp/x", ARCHIVE_BACKEND: "none" }), null);
  assertEquals(buildArchive({ ARCHIVE_DIR: "/tmp/x", ARCHIVE_BACKEND: "s3" }), null, "unimplemented backend disables honestly");
});
