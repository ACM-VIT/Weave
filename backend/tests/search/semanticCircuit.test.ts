import test from 'node:test';
import assert from 'node:assert/strict';
import { SemanticSearchCircuit } from '../../services/semanticSearchCircuit.js';

test('opens after failures, skips outage calls and admits only one recovery probe', async () => {
  let now = 1; let calls = 0;
  const circuit = new SemanticSearchCircuit(100, 10, () => now);
  const fail = async () => { calls++; throw new Error('upstream'); };
  for (let i = 0; i < 3; i++) await assert.rejects(circuit.run(fail));
  for (let i = 0; i < 20; i++) await assert.rejects(circuit.run(fail));
  assert.equal(calls, 3);
  now = 12;
  let resolve!: (value: string) => void;
  const probe = circuit.run(() => new Promise<string>(r => { calls++; resolve = r; }));
  await assert.rejects(circuit.run(fail));
  resolve('recovered'); assert.equal(await probe, 'recovered');
  assert.equal(await circuit.run(async () => 'healthy'), 'healthy');
});

test('cancellation does not count as upstream failure', async () => {
  const circuit = new SemanticSearchCircuit();
  for (let i = 0; i < 4; i++) {
    const abort = new AbortController();
    const pending = circuit.run(async signal => {
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    }, abort.signal);
    await Promise.resolve(); abort.abort(); await assert.rejects(pending);
  }
  assert.equal(await circuit.run(async () => 42), 42);
});

test('deadline bounds a non-cooperative transport and admission remains bounded', async () => {
  const circuit = new SemanticSearchCircuit(10, 10);
  let calls = 0;
  const attempts = Array.from({ length: 8 }, () => circuit.run(() => {
    calls++; return new Promise(() => {});
  }));
  await assert.rejects(circuit.run(async () => { calls++; }));
  const results = await Promise.allSettled(attempts);
  assert.ok(results.every(result => result.status === 'rejected'));
  await new Promise(r => setTimeout(r, 15));
  await assert.rejects(circuit.run(async () => { calls++; }));
  assert.equal(calls, 8);
});
