// SQLite-backed run/packet state store for zcode-codex-leader.
// Single source of truth for DAG run state. node:sqlite only, no deps.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pluginDataDir } from './app_server_pool.ts';

export interface PacketInput {
  packet_id: string;
  run_id: string;
  kind: string;
  model_tier: string;
  objective: string;
  depends_on: string[];
  priority: number;
  write_globs: string[];
  base_revision: string;
}

export interface PacketRow {
  packet_id: string;
  run_id: string;
  dag_version: number;
  packet_revision: number;
  kind: string;
  model_tier: string;
  objective: string;
  depends_on: string[];
  priority: number;
  write_globs: string[];
  state: string;
  state_version: number;
  base_revision: string;
  created_at: number;
  updated_at: number;
}

export interface RunRow {
  run_id: string;
  request_hash: string;
  status: string;
  dag_json: string;
  created_at: number;
  updated_at: number;
}

export interface RunEnvelope {
  run_id: string;
  status: string;
  accepted: number;
  rejected: number;
  stale: number;
  total: number;
  ledger_sha: string;
  evidence_lines: string[];
}

const TERMINAL_STATES = new Set(['accepted', 'rejected', 'stale', 'cancelled']);

export function dbPath(): string {
  return join(pluginDataDir(), 'runs.sqlite');
}

function migrate(db: DatabaseSync): void {
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;`);
  db.exec(`CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    dag_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ); CREATE TABLE IF NOT EXISTS packets (
    packet_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    dag_version INTEGER NOT NULL DEFAULT 1,
    packet_revision INTEGER NOT NULL DEFAULT 1,
    kind TEXT NOT NULL,
    model_tier TEXT NOT NULL,
    objective TEXT NOT NULL,
    depends_on TEXT NOT NULL DEFAULT '[]',
    priority INTEGER NOT NULL DEFAULT 0,
    write_globs TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL DEFAULT 'planned',
    state_version INTEGER NOT NULL DEFAULT 1,
    base_revision TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(run_id)
  ); CREATE TABLE IF NOT EXISTS packet_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    packet_id TEXT NOT NULL,
    attempt_id TEXT,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    worker_epoch INTEGER,
    event_seq INTEGER,
    created_at INTEGER NOT NULL
  ); CREATE TABLE IF NOT EXISTS packet_attempts (
    attempt_id TEXT PRIMARY KEY,
    packet_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    worker_epoch INTEGER,
    status TEXT NOT NULL DEFAULT 'in_flight',
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    exit_code INTEGER,
    outcome TEXT,
    FOREIGN KEY (packet_id) REFERENCES packets(packet_id)
  ); CREATE TABLE IF NOT EXISTS evidence (
    evidence_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    packet_id TEXT NOT NULL,
    attempt_id TEXT,
    capability TEXT NOT NULL,
    command TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    ledger_sha TEXT,
    created_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS idx_packets_run ON packets(run_id); CREATE INDEX IF NOT EXISTS idx_events_run ON packet_events(run_id); CREATE INDEX IF NOT EXISTS idx_attempts_packet ON packet_attempts(packet_id); CREATE INDEX IF NOT EXISTS idx_evidence_run ON evidence(run_id);`);
}

export class RunStore {
  private db: DatabaseSync;
  private constructor(db: DatabaseSync) { this.db = db; }

  static open(customPath?: string): RunStore {
    const p = customPath ?? dbPath();
    mkdirSync(dirname(p), { recursive: true });
    const db = new DatabaseSync(p);
    migrate(db);
    return new RunStore(db);
  }

  close(): void { try { this.db.close(); } catch { /* ponytail: ignore double-close */ } }

  private now(): number { return Date.now(); }

  createRun(runId: string, requestHash: string, packets: PacketInput[]): void {
    const now = this.now();
    const tx = this.db.prepare('BEGIN IMMEDIATE');
    tx.run();
    try {
      this.db.prepare('INSERT INTO runs (run_id, request_hash, status, dag_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(runId, requestHash, 'running', JSON.stringify({ packets }), now, now);
      const ins = this.db.prepare('INSERT INTO packets (packet_id, run_id, dag_version, packet_revision, kind, model_tier, objective, depends_on, priority, write_globs, state, state_version, base_revision, created_at, updated_at) VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)');
      for (const p of packets) {
        ins.run(p.packet_id, p.run_id, p.kind, p.model_tier, p.objective, JSON.stringify(p.depends_on), p.priority, JSON.stringify(p.write_globs), 'planned', p.base_revision, now, now);
        this.appendEvent(runId, p.packet_id, null, 'planned', { objective: p.objective });
      }
      this.db.prepare('COMMIT').run();
    } catch (e) {
      try { this.db.prepare('ROLLBACK').run(); } catch { /* ponytail */ }
      throw e;
    }
  }

  getRun(runId: string): RunRow | null {
    const r = this.db.prepare('SELECT run_id, request_hash, status, dag_json, created_at, updated_at FROM runs WHERE run_id=?').get(runId) as Record<string, unknown> | undefined;
    return r ? { run_id: r.run_id as string, request_hash: r.request_hash as string, status: r.status as string, dag_json: r.dag_json as string, created_at: r.created_at as number, updated_at: r.updated_at as number } : null;
  }

  setRunStatus(runId: string, status: string): void {
    this.db.prepare('UPDATE runs SET status=?, updated_at=? WHERE run_id=?').run(status, this.now(), runId);
    this.appendEvent(runId, '__run__', null, 'run_status', { status });
  }

  getPacket(packetId: string): PacketRow | null {
    const r = this.db.prepare('SELECT packet_id, run_id, dag_version, packet_revision, kind, model_tier, objective, depends_on, priority, write_globs, state, state_version, base_revision, created_at, updated_at FROM packets WHERE packet_id=?').get(packetId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      packet_id: r.packet_id as string, run_id: r.run_id as string,
      dag_version: r.dag_version as number, packet_revision: r.packet_revision as number,
      kind: r.kind as string, model_tier: r.model_tier as string,
      objective: r.objective as string,
      depends_on: JSON.parse(r.depends_on as string) as string[],
      priority: r.priority as number,
      write_globs: JSON.parse(r.write_globs as string) as string[],
      state: r.state as string, state_version: r.state_version as number,
      base_revision: r.base_revision as string,
      created_at: r.created_at as number, updated_at: r.updated_at as number,
    };
  }

  claimReadyPackets(runId: string, limit: number): string[] {
    // ready: state='planned' AND all depends_on accepted. CAS to 'dispatched' in tx.
    const now = this.now();
    this.db.prepare('BEGIN IMMEDIATE').run();
    try {
      const cands = this.db.prepare('SELECT packet_id, depends_on FROM packets WHERE run_id=? AND state=? ORDER BY priority DESC, created_at ASC LIMIT ?').all(runId, 'planned', limit * 4) as Array<Record<string, unknown>>;
      const ready: string[] = [];
      for (const c of cands) {
        const deps = JSON.parse(c.depends_on as string) as string[];
        if (deps.length === 0) { ready.push(c.packet_id as string); continue; }
        const placeholders = deps.map(() => '?').join(',');
        const rows = this.db.prepare(`SELECT state FROM packets WHERE packet_id IN (${placeholders})`).all(...deps) as Array<Record<string, unknown>>;
        if (rows.length === deps.length && rows.every(r => r.state === 'accepted')) {
          ready.push(c.packet_id as string);
        }
      }
      const claimed = ready.slice(0, limit);
      const upd = this.db.prepare('UPDATE packets SET state=?, updated_at=? WHERE packet_id=? AND state=?');
      for (const pid of claimed) { upd.run('dispatched', now, pid, 'planned'); this.appendEvent(runId, pid, null, 'dispatched', {}); }
      this.db.prepare('COMMIT').run();
      return claimed;
    } catch (e) {
      try { this.db.prepare('ROLLBACK').run(); } catch { /* ponytail */ }
      throw e;
    }
  }

  markDispatched(packetId: string, attemptId: string, workerEpoch: number): void {
    this.appendEvent(/* run_id inferred */ '', packetId, attemptId, 'worker_dispatched', { workerEpoch }, workerEpoch);
  }

  beginAttempt(packetId: string, runId: string, workerEpoch: number): string {
    const attemptId = 'att_' + Math.random().toString(36).slice(2, 12);
    const now = this.now();
    this.db.prepare('INSERT INTO packet_attempts (attempt_id, packet_id, run_id, worker_epoch, status, started_at) VALUES (?, ?, ?, ?, ?, ?)').run(attemptId, packetId, runId, workerEpoch, 'in_flight', now);
    this.appendEvent(runId, packetId, attemptId, 'attempt_started', { workerEpoch }, workerEpoch);
    return attemptId;
  }

  applyOutcome(attemptId: string, packetId: string, outcome: { status: string; exitCode: number; summary: string }): void {
    const now = this.now();
    const pkt = this.getPacket(packetId);
    if (!pkt) throw new Error('packet not found: ' + packetId);
    const expected = pkt.state;
    const expectedVer = pkt.state_version;
    if (expected !== 'dispatched' && expected !== 'failed_retryable') {
      throw new Error(`CAS conflict: packet ${packetId} in state ${expected}, cannot apply outcome`);
    }
    this.db.prepare('BEGIN IMMEDIATE').run();
    try {
      this.db.prepare('UPDATE packet_attempts SET status=?, ended_at=?, exit_code=?, outcome=? WHERE attempt_id=?').run(outcome.status, now, outcome.exitCode, outcome.summary, attemptId);
      const res = this.db.prepare('UPDATE packets SET state=?, state_version=state_version+1, updated_at=? WHERE packet_id=? AND state=? AND state_version=?').run(outcome.status, now, packetId, expected, expectedVer);
      if (res.changes !== 1) {
        this.db.prepare('ROLLBACK').run();
        throw new Error(`CAS conflict on ${packetId}: expected ${expected}@v${expectedVer}`);
      }
      this.appendEvent(pkt.run_id, packetId, attemptId, outcome.status, { summary: outcome.summary, exitCode: outcome.exitCode });
      this.db.prepare('COMMIT').run();
    } catch (e) {
      try { this.db.prepare('ROLLBACK').run(); } catch { /* ponytail */ }
      throw e;
    }
  }

  markStale(packetId: string): void {
    const pkt = this.getPacket(packetId);
    if (!pkt) return;
    const now = this.now();
    this.db.prepare('UPDATE packets SET state=?, state_version=state_version+1, updated_at=? WHERE packet_id=?').run('stale', now, packetId);
    this.appendEvent(pkt.run_id, packetId, null, 'stale', {});
  }

  failDependents(runId: string, failedPacketId: string): void {
    // cascade: any packet whose depends_on includes failedPacketId (transitively) -> stale
    const all = this.db.prepare('SELECT packet_id, depends_on FROM packets WHERE run_id=?').all(runId) as Array<Record<string, unknown>>;
    const failed = new Set<string>([failedPacketId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of all) {
        if (failed.has(p.packet_id as string)) continue;
        const deps = JSON.parse(p.depends_on as string) as string[];
        if (deps.some(d => failed.has(d))) {
          failed.add(p.packet_id as string);
          changed = true;
        }
      }
    }
    failed.delete(failedPacketId);
    for (const pid of failed) this.markStale(pid);
  }

  isRunTerminal(runId: string): boolean {
    const total = (this.db.prepare('SELECT COUNT(*) AS c FROM packets WHERE run_id=?').get(runId) as Record<string, number>).c;
    const terminal = (this.db.prepare('SELECT COUNT(*) AS c FROM packets WHERE run_id=? AND state IN (?, ?, ?, ?)').get(runId, 'accepted', 'rejected', 'stale', 'cancelled') as Record<string, number>).c;
    return total > 0 && total === terminal;
  }

  appendEvent(runId: string, packetId: string, attemptId: string | null, eventType: string, payload: object, workerEpoch?: number): void {
    const seq = (this.db.prepare('SELECT COALESCE(MAX(event_seq),0)+1 AS s FROM packet_events WHERE packet_id=?').get(packetId) as Record<string, number>).s;
    this.db.prepare('INSERT INTO packet_events (run_id, packet_id, attempt_id, event_type, payload, worker_epoch, event_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(runId, packetId, attemptId, eventType, JSON.stringify(payload), workerEpoch ?? null, seq, this.now());
    if (runId) this.db.prepare('UPDATE runs SET updated_at=? WHERE run_id=?').run(this.now(), runId);
  }

  recordEvidence(runId: string, packetId: string, attemptId: string, capability: string, command: string, turnId: string): string {
    const now = this.now();
    this.db.prepare('INSERT INTO evidence (run_id, packet_id, attempt_id, capability, command, turn_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(runId, packetId, attemptId, capability, command, turnId, now);
    const sha = this.computeLedgerSha(runId);
    this.db.prepare('UPDATE evidence SET ledger_sha=? WHERE rowid=(SELECT MAX(rowid) FROM evidence WHERE run_id=?)').run(sha, runId);
    return sha;
  }

  computeLedgerSha(runId: string): string {
    const rows = this.db.prepare('SELECT capability, command, turn_id FROM evidence WHERE run_id=? ORDER BY evidence_id').all(runId) as Array<Record<string, unknown>>;
    const blob = rows.map(r => `${r.capability}|${r.command}|${r.turn_id}`).join('\n');
    return createHash('sha256').update(blob).digest('hex');
  }

  verifyEvidence(runId: string, claimedLedgerSha: string): boolean {
    return this.computeLedgerSha(runId) === claimedLedgerSha;
  }

  buildEnvelope(runId: string): RunEnvelope {
    const run = this.getRun(runId);
    const status = run?.status ?? 'unknown';
    const agg = this.db.prepare('SELECT state, COUNT(*) AS c FROM packets WHERE run_id=? GROUP BY state').all(runId) as Array<Record<string, unknown>>;
    let accepted = 0, rejected = 0, stale = 0, total = 0;
    for (const r of agg) {
      const c = r.c as number;
      total += c;
      if (r.state === 'accepted') accepted = c;
      else if (r.state === 'rejected') rejected = c;
      else if (r.state === 'stale') stale = c;
    }
    const ledger = this.computeLedgerSha(runId);
    const evRows = this.db.prepare('SELECT capability, command, turn_id FROM evidence WHERE run_id=? ORDER BY evidence_id').all(runId) as Array<Record<string, unknown>>;
    const evidence_lines = evRows.map(r => `Plugin evidence: ${r.capability} via codex_bridge.ts — ${r.command} [turn ${r.turn_id}]`);
    return { run_id: runId, status, accepted, rejected, stale, total, ledger_sha: ledger, evidence_lines };
  }
}

// ponytail: self-check — fails if state machine / CAS / ledger breaks.
// Run: node --experimental-strip-types run_store.ts
async function selfCheck(): Promise<void> {
  const tmpPath = join(tmpdir(), `run_store_selfcheck_${Date.now()}.sqlite`);
  const store = RunStore.open(tmpPath);
  try {
    const runId = 'run_selfcheck';
    const p1: PacketInput = { packet_id: 'pkt_a', run_id: runId, kind: 'ask', model_tier: 'balanced', objective: 'do A', depends_on: [], priority: 10, write_globs: ['src/a.ts'], base_revision: 'r0' };
    const p2: PacketInput = { packet_id: 'pkt_b', run_id: runId, kind: 'ask', model_tier: 'balanced', objective: 'do B', depends_on: ['pkt_a'], priority: 5, write_globs: ['src/b.ts'], base_revision: 'r0' };
    store.createRun(runId, 'hash123', [p1, p2]);
    // p1 ready (no deps), p2 blocked
    const ready1 = store.claimReadyPackets(runId, 4);
    if (ready1.length !== 1 || ready1[0] !== 'pkt_a') throw new Error('expected only pkt_a ready, got ' + JSON.stringify(ready1));
    const att = store.beginAttempt('pkt_a', runId, 1);
    store.applyOutcome(att, 'pkt_a', { status: 'accepted', exitCode: 0, summary: 'A done' });
    // now p2 ready
    const ready2 = store.claimReadyPackets(runId, 4);
    if (ready2.length !== 1 || ready2[0] !== 'pkt_b') throw new Error('expected pkt_b ready after pkt_a accepted, got ' + JSON.stringify(ready2));
    // ledger round-trip
    const sha = store.recordEvidence(runId, 'pkt_a', att, 'ask', 'ask prompt', 'turn_001');
    if (!store.verifyEvidence(runId, sha)) throw new Error('ledger sha mismatch');
    if (store.verifyEvidence(runId, 'tampered')) throw new Error('tampered ledger should not verify');
    // CAS: applying outcome to already-accepted packet must throw
    let threw = false;
    try { store.applyOutcome(att, 'pkt_a', { status: 'rejected', exitCode: 1, summary: 'replay' }); } catch { threw = true; }
    if (!threw) throw new Error('CAS conflict not detected on accepted packet');
    // stale cascade
    store.markStale('pkt_b');
    store.failDependents(runId, 'pkt_b');
    if (!store.isRunTerminal(runId)) throw new Error('run should be terminal after both packets done');
    console.log('self-check passed');
  } finally {
    store.close();
    try { rmSync(tmpPath); } catch { /* ponytail */ }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  selfCheck().catch(e => { console.error(e); process.exit(1); });
}
