import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeEvent, verifyChain, stableStringify, computeObligations, contactStats, shareableFacts,
  effectiveEvents, daysBetween, arrearsLabel, validateAnswers, PRIVATE_TYPES,
} from '../core.js';

async function build(specs) {
  const chain = [];
  for (const [type, data] of specs) chain.push(await makeEvent(chain, type, data, '2026-10-01T09:00:00.000Z'));
  return chain;
}

const ANS = { schedule: 'as_promised', workState: 'done', info: 'ontime', safety: 'yes', treatment: ['none'] };
const close = (date, extra = {}) => ['day.close', { promiseId: 'p1', date, answers: ANS, ...extra }];

test('stableStringify is key-order independent', () => {
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }), stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
});

test('hash chain verifies and detects edits, deletions and reordering', async () => {
  const chain = await build([
    ['promise.create', { id: 'p1', site: 'A', counterpart: 'X', rate: 300000, rateUnit: 'day', contractType: 'service', payRule: 'once', payDate: '2026-10-10' }],
    close('2026-10-01'), close('2026-10-02'),
  ]);
  assert.deepEqual(await verifyChain(chain), { ok: true });

  const edited = structuredClone(chain); edited[1].data.date = '2026-09-30';
  assert.equal((await verifyChain(edited)).brokenAt, 2);

  const deleted = [chain[0], chain[2]];
  assert.equal((await verifyChain(deleted)).ok, false);

  const swapped = [chain[0], chain[2], chain[1]];
  assert.equal((await verifyChain(swapped)).ok, false);

  // re-hashing a tampered event still breaks the link to the next one
  const rehashed = structuredClone(chain); rehashed[1].data.date = '2026-09-30';
  const { sha256Hex } = await import('../core.js');
  rehashed[1].hash = await sha256Hex(stableStringify({ seq: 2, ts: rehashed[1].ts, type: rehashed[1].type, data: rehashed[1].data, prev: rehashed[1].prev }));
  const r = await verifyChain(rehashed);
  assert.equal(r.ok, false); assert.equal(r.brokenAt, 3); assert.equal(r.reason, 'prev-mismatch');
});

test('an outside anchor catches tail deletion and full rebuilds that the chain alone misses', async () => {
  const { verifyAnchor, parseAnchor } = await import('../core.js');
  const P = ['promise.create', { id: 'p1', counterpart: 'X', rate: 300000, rateUnit: 'day', contractType: 'service', payRule: 'once', payDate: '2026-10-10' }];
  const chain = await build([P, close('2026-10-01'), ['payment.check', { promiseId: 'p1', period: 'all', result: 'full', amount: 300000 }]]);
  const msg = `[약속장부] 2026-10-01 마감 · 현장 · X · 기록번호 3 · 지문 ${chain[2].hash.slice(0, 16)}`;
  const a = parseAnchor(msg);
  assert.deepEqual(a, { seq: 3, hashPrefix: chain[2].hash.slice(0, 16) });
  assert.deepEqual(await verifyAnchor(chain, a.seq, a.hashPrefix), { ok: true });

  // tail deletion: chain still verifies, anchor does not
  const cut = chain.slice(0, 2);
  assert.deepEqual(await verifyChain(cut), { ok: true });
  assert.equal((await verifyAnchor(cut, a.seq, a.hashPrefix)).reason, 'missing');

  // full rebuild with a changed amount: chain verifies, anchor does not
  const rebuilt = await build([P, close('2026-10-01'), ['payment.check', { promiseId: 'p1', period: 'all', result: 'full', amount: 1 }]]);
  assert.deepEqual(await verifyChain(rebuilt), { ok: true });
  assert.equal((await verifyAnchor(rebuilt, a.seq, a.hashPrefix)).reason, 'mismatch');

  // edited content with the old hash left in place (Codex round 2): must not pass
  const edited = structuredClone(chain); edited[1].data.date = '2020-01-01';
  assert.deepEqual(await verifyAnchor(edited, a.seq, a.hashPrefix), { ok: false, reason: 'broken', brokenAt: 2 });

  // records after the anchor are outside its guarantee: an anchor at seq 2 still passes after seq 3 is dropped
  assert.deepEqual(await verifyAnchor(cut, 2, chain[1].hash.slice(0, 16)), { ok: true });

  assert.equal((await verifyAnchor(chain, 3, 'abc')).reason, 'bad-anchor');   // too short to mean anything
  assert.equal(parseAnchor('아무 말'), null);
});

test('daysBetween crosses month and year boundaries', () => {
  assert.equal(daysBetween('2026-10-10', '2026-10-11'), 1);
  assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1);
  assert.equal(daysBetween('2028-02-28', '2028-03-01'), 2); // leap year
});

test('once: unpaid after pay date counts arrears days from the day after', async () => {
  const chain = await build([
    ['promise.create', { id: 'p1', counterpart: 'X', rate: 300000, rateUnit: 'day', contractType: 'service', payRule: 'once', payDate: '2026-10-10' }],
    close('2026-10-01'), close('2026-10-02'), close('2026-10-03'),
  ]);
  const onDue = computeObligations('p1', chain, '2026-10-10')[0];
  assert.equal(onDue.status, 'notdue'); assert.equal(onDue.overdueDays, 0);
  const o = computeObligations('p1', chain, '2026-10-13')[0];
  assert.equal(o.amountDue, 900000); assert.equal(o.status, 'unpaid'); assert.equal(o.overdueDays, 3);
  assert.equal(o.shortfall, 900000);
});

test('partial payment keeps arrears running on the shortfall', async () => {
  const chain = await build([
    ['promise.create', { id: 'p1', counterpart: 'X', rate: 300000, rateUnit: 'day', contractType: 'labor', payRule: 'once', payDate: '2026-10-10' }],
    close('2026-10-01'), close('2026-10-02'),
    ['payment.check', { promiseId: 'p1', period: 'all', result: 'partial', amount: 500000 }],
  ]);
  const o = computeObligations('p1', chain, '2026-10-20')[0];
  assert.equal(o.received, 500000); assert.equal(o.shortfall, 100000);
  assert.equal(o.status, 'partial'); assert.equal(o.overdueDays, 10);
});

test('full payment clears arrears; paying in two parts also clears', async () => {
  const chain = await build([
    ['promise.create', { id: 'p1', counterpart: 'X', rate: 300000, rateUnit: 'day', contractType: 'service', payRule: 'once', payDate: '2026-10-10' }],
    close('2026-10-01'),
    ['payment.check', { promiseId: 'p1', period: 'all', result: 'partial', amount: 100000 }],
    ['payment.check', { promiseId: 'p1', period: 'all', result: 'partial', amount: 200000 }],
  ]);
  const o = computeObligations('p1', chain, '2026-11-30')[0];
  assert.equal(o.status, 'paid'); assert.equal(o.overdueDays, 0);
});

test('monthly: days split by work month, due on payDay of next month, clamped', async () => {
  const chain = await build([
    ['promise.create', { id: 'p1', counterpart: 'X', rate: 250000, rateUnit: 'day', contractType: 'service', payRule: 'monthly', payDay: 31 }],
    close('2027-01-30'), close('2027-01-31'), close('2027-02-01'),
  ]);
  const [jan, feb] = computeObligations('p1', chain, '2027-03-05');
  assert.equal(jan.period, '2027-01'); assert.equal(jan.dueDate, '2027-02-28'); // Feb has no 31st
  assert.equal(jan.amountDue, 500000); assert.equal(jan.overdueDays, 5);
  assert.equal(feb.dueDate, '2027-03-31'); assert.equal(feb.status, 'notdue');
});

test('hourly rate uses closed hours; zero owed is never arrears', async () => {
  const chain = await build([
    ['promise.create', { id: 'p1', counterpart: 'X', rate: 12000, rateUnit: 'hour', contractType: 'labor', payRule: 'once', payDate: '2026-10-10' }],
    close('2026-10-01', { hours: 8 }), close('2026-10-02', { hours: 4.5 }),
  ]);
  assert.equal(computeObligations('p1', chain, '2026-10-11')[0].amountDue, 150000);

  const zero = await build([
    ['promise.create', { id: 'p1', counterpart: 'X', rate: 12000, rateUnit: 'hour', contractType: 'labor', payRule: 'once', payDate: '2026-10-10' }],
    close('2026-10-01', { hours: 0 }),
  ]);
  const z = computeObligations('p1', zero, '2026-10-20')[0];
  assert.equal(z.status, 'paid'); assert.equal(z.overdueDays, 0);
});

test('closing the same date twice counts the day once (last close wins)', async () => {
  const chain = await build([
    ['promise.create', { id: 'p1', counterpart: 'X', rate: 12000, rateUnit: 'hour', contractType: 'labor', payRule: 'once', payDate: '2026-10-10' }],
    close('2026-10-01', { hours: 8 }), close('2026-10-01', { hours: 10 }),
  ]);
  const o = computeObligations('p1', chain, '2026-10-05')[0];
  assert.equal(o.workedDays, 1); assert.equal(o.amountDue, 120000);
});

test('correction replaces an event in the effective view but keeps the raw chain valid', async () => {
  const chain = await build([
    ['promise.create', { id: 'p1', counterpart: 'X', rate: 300000, rateUnit: 'day', contractType: 'service', payRule: 'once', payDate: '2026-10-10' }],
    ['payment.check', { promiseId: 'p1', period: 'all', result: 'full', amount: 3000000 }], // typo: one zero too many
  ]);
  chain.push(await makeEvent(chain, 'correction', { targetSeq: 2, replacement: { type: 'payment.check', data: { promiseId: 'p1', period: 'all', result: 'partial', amount: 300000 } } }));
  assert.equal((await verifyChain(chain)).ok, true);
  const eff = effectiveEvents(chain);
  assert.equal(eff.length, 2); assert.equal(eff[1].data.amount, 300000); assert.equal(eff[1].corrected, true);
});

test('contact stats: silent days run from the last reply', async () => {
  const chain = await build([
    ['contact.attempt', { promiseId: 'p1', date: '2026-10-11', channel: 'phone', answered: true }],
    ['contact.attempt', { promiseId: 'p1', date: '2026-10-12', channel: 'phone', answered: false }],
    ['contact.attempt', { promiseId: 'p1', date: '2026-10-14', channel: 'sms', answered: false }],
  ]);
  const c = contactStats('p1', chain, '2026-10-20');
  assert.equal(c.noAnswerCount, 2); assert.equal(c.noAnswerSinceLastReply, 2);
  assert.equal(c.lastAnswered, '2026-10-11'); assert.equal(c.silentDays, 9);
});

test('labels follow contract type', () => {
  assert.equal(arrearsLabel('labor'), '임금 체불');
  assert.equal(arrearsLabel('service'), '대금 체불');
  assert.equal(arrearsLabel('unknown'), '대금 체불');
});

test('shareable facts never include private notes or free text', async () => {
  const secret = '소사장 욕설 들음 — 비공개';
  const chain = await build([
    ['promise.create', { id: 'p1', site: '오창 2라인', counterpart: '○○테크', rate: 300000, rateUnit: 'day', contractType: 'service', payRule: 'once', payDate: '2026-10-10' }],
    close('2026-10-01'),
    ['note.private', { promiseId: 'p1', date: '2026-10-01', text: secret }],
    ['contact.attempt', { promiseId: 'p1', date: '2026-10-12', channel: 'phone', answered: false }],
  ]);
  const facts = shareableFacts('p1', chain, '2026-10-15');
  const s = JSON.stringify(facts);
  assert.ok(!s.includes(secret)); assert.ok(!s.includes('오창'));
  assert.deepEqual(facts.arrears, { label: '대금 체불', days: 5, shortfall: 300000 });
  assert.ok(PRIVATE_TYPES.has('note.private'));
});

test('daily answers: all required, "none" cannot combine with others', () => {
  assert.deepEqual(validateAnswers(ANS), []);
  assert.ok(validateAnswers({ ...ANS, safety: undefined }).includes('safety'));
  assert.ok(validateAnswers({ ...ANS, treatment: [] }).includes('treatment'));
  assert.ok(validateAnswers({ ...ANS, treatment: ['none', 'rest'] }).includes('treatment-conflict'));
});
