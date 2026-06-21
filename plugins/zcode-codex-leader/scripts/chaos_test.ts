// Chaos tests for run_store.ts — verifies fault-tolerance semantics.
// Run: node --experimental-strip-types chaos_test.ts
import { RunStore, type PacketInput } from './run_store.ts';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let passed = 0, failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log('  PASS: ' + msg); }
  else { failed++; console.error('  FAIL: ' + msg); }
}

function makePacket(id: string, runId: string, deps: string[] = [], priority = 0): PacketInput {
  return { packet_id: id, run_id: runId, kind: 'ask', model_tier: 'fast', objective: 'do ' + id, depends_on: deps, priority, write_globs: [], base_revision: 'HEAD' };
}

function freshStore(): { store: RunStore; path: string } {
  const path = join(tmpdir(), 'chaos_' + Math.random().toString(36).slice(2) + '.sqlite');
  return { store: RunStore.open(path), path };
}

// Test 1: CAS conflict — concurrent applyOutcome on same packet
async function testCasConflict(): Promise<void> {
  console.log('Test 1: CAS conflict detection');
  const { store, path } = freshStore();
  try {
    const runId = 'run_cas';
    store.createRun(runId, 'h', [makePacket('pkt_cas', runId)]);
    const ready = store.claimReadyPackets(runId, 1);
    assert(ready.length === 1 && ready[0] === 'pkt_cas', 'packet claimed');
    const att = store.beginAttempt('pkt_cas', runId, 1);
    store.applyOutcome(att, 'pkt_cas', { status: 'accepted', exitCode: 0, summary: 'ok' });
    // replay attempt — must throw (CAS conflict, packet already accepted)
    let threw = false;
    try { store.applyOutcome(att, 'pkt_cas', { status: 'rejected', exitCode: 1, summary: 'replay' }); } catch { threw = true; }
    assert(threw, 'replay attempt rejected by CAS');
    // verify state unchanged
    const pkt = store.getPacket('pkt_cas');
    assert(pkt?.state === 'accepted', 'packet stays accepted after rejected replay');
  } finally { store.close(); try { rmSync(path); } catch {} }
}

// Test 2: Stale cascade — dependency failure propagates to dependents
async function testStaleCascade(): Promise<void> {
  console.log('Test 2: stale cascade on dependency failure');
  const { store, path } = freshStore();
  try {
    const runId = 'run_cascade';
    // A -> B -> C (chain), A -> D (branch)
    store.createRun(runId, 'h', [
      makePacket('pkt_a', runId),
      makePacket('pkt_b', runId, ['pkt_a']),
      makePacket('pkt_c', runId, ['pkt_b']),
      makePacket('pkt_d', runId, ['pkt_a']),
    ]);
    // claim A, fail it
    store.claimReadyPackets(runId, 1);
    const att = store.beginAttempt('pkt_a', runId, 1);
    store.applyOutcome(att, 'pkt_a', { status: 'rejected', exitCode: 1, summary: 'failed' });
    store.failDependents(runId, 'pkt_a');
    // B, C, D should all be stale (transitively)
    assert(store.getPacket('pkt_b')?.state === 'stale', 'pkt_b stale (direct dep)');
    assert(store.getPacket('pkt_c')?.state === 'stale', 'pkt_c stale (transitive dep)');
    assert(store.getPacket('pkt_d')?.state === 'stale', 'pkt_d stale (branch dep)');
    assert(store.isRunTerminal(runId), 'run terminal after cascade');
  } finally { store.close(); try { rmSync(path); } catch {} }
}

// Test 3: Resume after crash — reopen store, recover state
async function testResumeAfterCrash(): Promise<void> {
  console.log('Test 3: resume after crash (store reopen)');
  const path = join(tmpdir(), 'chaos_resume_' + Math.random().toString(36).slice(2) + '.sqlite');
  const runId = 'run_resume';
  // Session 1: create run, claim packet, but DON'T apply outcome (simulates crash mid-flight)
  let store1 = RunStore.open(path);
  store1.createRun(runId, 'h', [makePacket('pkt_r1', runId)]);
  store1.claimReadyPackets(runId, 1);
  store1.beginAttempt('pkt_r1', runId, 1);
  store1.close();
  // Session 2: reopen, packet should still be 'dispatched' (in-flight)
  const store2 = RunStore.open(path);
  const pkt = store2.getPacket('pkt_r1');
  assert(pkt?.state === 'dispatched', 'packet preserved as dispatched across reopen');
  // before markStale: run is NOT terminal (dispatched packet in-flight)
  assert(!store2.isRunTerminal(runId), 'run not terminal (in-flight dispatched packet)');
  const envBefore = store2.buildEnvelope(runId);
  assert(envBefore.total === 1 && envBefore.accepted === 0, 'envelope shows 0/1 accepted before reclaim');
  // mark stale (reclaim logic for orphaned in-flight)
  store2.markStale('pkt_r1');
  // after markStale: packet is terminal (stale), run IS terminal
  assert(store2.isRunTerminal(runId), 'run terminal after stale reclaim');
  const envAfter = store2.buildEnvelope(runId);
  assert(envAfter.stale === 1, 'envelope shows 1 stale after reclaim');
  store2.close();
  try { rmSync(path); } catch {}
}

// Test 4: Ledger tamper detection — adding evidence changes sha
async function testLedgerTamper(): Promise<void> {
  console.log('Test 4: ledger tamper detection');
  const { store, path } = freshStore();
  try {
    const runId = 'run_ledger';
    store.createRun(runId, 'h', [makePacket('pkt_l1', runId)]);
    store.claimReadyPackets(runId, 1);
    const att = store.beginAttempt('pkt_l1', runId, 1);
    store.applyOutcome(att, 'pkt_l1', { status: 'accepted', exitCode: 0, summary: 'ok' });
    const sha1 = store.recordEvidence(runId, 'pkt_l1', att, 'ask', 'cmd1', 'turn_1');
    assert(store.verifyEvidence(runId, sha1), 'ledger sha verifies');
    // add more evidence — sha must change
    store.recordEvidence(runId, 'pkt_l1', att, 'ask', 'cmd2', 'turn_2');
    const sha2 = store.computeLedgerSha(runId);
    assert(sha1 !== sha2, 'ledger sha changes after new evidence');
    assert(!store.verifyEvidence(runId, sha1), 'old sha no longer valid');
    assert(store.verifyEvidence(runId, sha2), 'new sha valid');
  } finally { store.close(); try { rmSync(path); } catch {} }
}

// Test 5: Deadlock detection — circular dependency
async function testDeadlockDetection(): Promise<void> {
  console.log('Test 5: circular dependency handling');
  const { store, path } = freshStore();
  try {
    const runId = 'run_cycle';
    // A depends on B, B depends on A (cycle) — neither can become ready
    store.createRun(runId, 'h', [
      makePacket('pkt_x', runId, ['pkt_y']),
      makePacket('pkt_y', runId, ['pkt_x']),
    ]);
    const ready = store.claimReadyPackets(runId, 4);
    assert(ready.length === 0, 'no packets ready (circular dep)');
    assert(!store.isRunTerminal(runId), 'run stuck (not terminal, not ready)');
  } finally { store.close(); try { rmSync(path); } catch {} }
}

// Test 6: Bad input — createRun with duplicate packet_id
async function testDuplicatePacketId(): Promise<void> {
  console.log('Test 6: duplicate packet_id rejection');
  const { store, path } = freshStore();
  try {
    const runId = 'run_dup';
    let threw = false;
    try {
      store.createRun(runId, 'h', [makePacket('pkt_same', runId), makePacket('pkt_same', runId)]);
    } catch { threw = true; }
    assert(threw, 'duplicate packet_id rejected by PK constraint');
  } finally { store.close(); try { rmSync(path); } catch {} }
}

// Test 7: Priority ordering — higher priority claimed first
async function testPriorityOrdering(): Promise<void> {
  console.log('Test 7: priority-based ordering');
  const { store, path } = freshStore();
  try {
    const runId = 'run_prio';
    store.createRun(runId, 'h', [
      makePacket('pkt_low', runId, [], 1),
      makePacket('pkt_high', runId, [], 10),
      makePacket('pkt_mid', runId, [], 5),
    ]);
    // claim 1 at a time, verify order
    const r1 = store.claimReadyPackets(runId, 1);
    assert(r1[0] === 'pkt_high', 'highest priority first');
    const r2 = store.claimReadyPackets(runId, 1);
    assert(r2[0] === 'pkt_mid', 'medium priority second');
    const r3 = store.claimReadyPackets(runId, 1);
    assert(r3[0] === 'pkt_low', 'lowest priority last');
  } finally { store.close(); try { rmSync(path); } catch {} }
}

async function main(): Promise<void> {
  console.log('=== run_store chaos tests ===');
  await testCasConflict();
  await testStaleCascade();
  await testResumeAfterCrash();
  await testLedgerTamper();
  await testDeadlockDetection();
  await testDuplicatePacketId();
  await testPriorityOrdering();
  console.log('');
  console.log('=== RESULT: ' + passed + ' passed, ' + failed + ' failed ===');
  if (failed > 0) process.exit(1);
  console.log('ALL CHAOS TESTS PASSED');
}

main().catch(e => { console.error(e); process.exit(1); });
