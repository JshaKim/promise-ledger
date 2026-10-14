// 약속장부 core: pure logic, no DOM. Runs in browsers and Node 22 (globalThis.crypto.subtle).
//
// Data model: an append-only list of events, each chained to the previous one by SHA-256.
//   { seq, ts, type, data, prev, hash }
// Nothing is ever edited or deleted. A mistake is fixed by appending a "correction" event
// that points at the seq it replaces.
//
// Event types and their data:
//   promise.create   { id, site, counterpart, rate, rateUnit: 'day'|'hour', contractType: 'labor'|'service'|'unknown',
//                      payRule: 'once'|'monthly', payDate?: 'YYYY-MM-DD' (once), payDay?: 1..31 (monthly),
//                      method, startDate }
//   promise.end      { promiseId, endDate }
//   day.close        { promiseId, date, hours?, answers: { schedule, workState, info, safety, treatment: [] } }
//   payment.check    { promiseId, period, result: 'full'|'partial'|'none', amount }
//   contact.attempt  { promiseId, date, channel, answered: boolean }
//   note.private     { promiseId?, date, text }          -- never shareable
//   correction       { targetSeq, replacement: { type, data } }

export const PRIVATE_TYPES = new Set(['note.private']);

// ---------- canonical JSON + hashing ----------

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

export async function sha256Hex(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const GENESIS = '0'.repeat(64);

function hashInput(e) {
  return stableStringify({ seq: e.seq, ts: e.ts, type: e.type, data: e.data, prev: e.prev });
}

export async function makeEvent(chain, type, data, ts = new Date().toISOString()) {
  const last = chain[chain.length - 1];
  const e = { seq: last ? last.seq + 1 : 1, ts, type, data, prev: last ? last.hash : GENESIS };
  e.hash = await sha256Hex(hashInput(e));
  return e;
}

// Returns { ok: true } or { ok: false, brokenAt: seq, reason }.
export async function verifyChain(chain) {
  let prev = GENESIS;
  for (let i = 0; i < chain.length; i++) {
    const e = chain[i];
    if (e.seq !== i + 1) return { ok: false, brokenAt: e.seq, reason: 'seq-gap' };
    if (e.prev !== prev) return { ok: false, brokenAt: e.seq, reason: 'prev-mismatch' };
    if (await sha256Hex(hashInput(e)) !== e.hash) return { ok: false, brokenAt: e.seq, reason: 'hash-mismatch' };
    prev = e.hash;
  }
  return { ok: true };
}

// The chain alone cannot catch two things: dropping the newest records, or rebuilding the whole chain.
// Both are caught by an anchor kept outside the device (the "send to myself" summary carries seq + hash prefix).
// The anchor vouches for records 1..seq only: it says nothing about records after seq.
// The stored hashes up to seq are recomputed first, so an edited record that kept its old hash cannot pass.
// Returns { ok: true } | { ok: false, reason: 'bad-anchor'|'missing'|'broken'|'mismatch', brokenAt? }.
export async function verifyAnchor(chain, seq, hashPrefix) {
  const prefix = String(hashPrefix || '').toLowerCase();
  if (!Number.isInteger(seq) || seq < 1 || !/^[0-9a-f]{12,64}$/.test(prefix)) return { ok: false, reason: 'bad-anchor' };
  if (chain.length < seq) return { ok: false, reason: 'missing' };
  const upTo = await verifyChain(chain.slice(0, seq));
  if (!upTo.ok) return { ok: false, reason: 'broken', brokenAt: upTo.brokenAt };
  return chain[seq - 1].hash.startsWith(prefix) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

// Pull "기록번호 N · 지문 <hex>" out of a pasted summary message.
export function parseAnchor(text) {
  const m = /기록번호\s*(\d+)[\s\S]*?지문\s*([0-9a-fA-F]{12,64})/.exec(String(text || ''));
  return m ? { seq: Number(m[1]), hashPrefix: m[2] } : null;
}

// ---------- corrections ----------

// Apply correction events: the target keeps its seq and ts, but its type/data are replaced.
// Corrections themselves are dropped from the effective view. The raw chain is untouched.
export function effectiveEvents(chain) {
  const repl = new Map();
  for (const e of chain) if (e.type === 'correction') repl.set(e.data.targetSeq, e.data.replacement);
  return chain
    .filter(e => e.type !== 'correction')
    .map(e => (repl.has(e.seq) ? { ...e, ...repl.get(e.seq), corrected: true } : e));
}

// ---------- dates (calendar days, timezone-free) ----------

export function dayNumber(iso) {            // 'YYYY-MM-DD' -> integer day count
  const [y, m, d] = iso.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}
export function daysBetween(fromIso, toIso) { return dayNumber(toIso) - dayNumber(fromIso); }
function lastDayOfMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); } // m is 1-based
function pad(n) { return String(n).padStart(2, '0'); }
export function localToday(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// ---------- obligations: what is owed, when, and how late ----------

export function arrearsLabel(contractType) {
  return contractType === 'labor' ? '임금 체불' : '대금 체불';
}

function workedUnits(promise, close) {
  if (promise.rateUnit === 'hour') return Number(close.hours) || 0;
  return 1;
}

// One obligation per pay period.
//   once:    every closed day in the promise -> due on payDate
//   monthly: days closed in month M -> due on payDay of month M+1 (clamped to month length)
export function computeObligations(promiseId, events, today) {
  const ev = effectiveEvents(events);
  const promise = ev.find(e => e.type === 'promise.create' && e.data.id === promiseId)?.data;
  if (!promise) return [];

  // last close per date wins (a second close of the same date is treated as a re-close)
  const byDate = new Map();
  for (const e of ev) if (e.type === 'day.close' && e.data.promiseId === promiseId) byDate.set(e.data.date, e.data);
  const closes = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  const periods = new Map(); // period -> { dueDate, units, dates[] }
  for (const c of closes) {
    let period, dueDate;
    if (promise.payRule === 'monthly') {
      const [y, m] = c.date.split('-').map(Number);
      period = `${y}-${pad(m)}`;
      const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
      dueDate = `${ny}-${pad(nm)}-${pad(Math.min(promise.payDay, lastDayOfMonth(ny, nm)))}`;
    } else {
      period = 'all';
      dueDate = promise.payDate;
    }
    if (!periods.has(period)) periods.set(period, { dueDate, units: 0, dates: [] });
    const p = periods.get(period);
    p.units += workedUnits(promise, c);
    p.dates.push(c.date);
  }

  const out = [];
  for (const [period, p] of periods) {
    const amountDue = Math.round(p.units * promise.rate);
    const checks = ev.filter(e => e.type === 'payment.check' && e.data.promiseId === promiseId && e.data.period === period);
    const received = checks.reduce((s, e) => s + (Number(e.data.amount) || 0), 0);
    const shortfall = Math.max(0, amountDue - received);
    const late = today > p.dueDate;
    let status;
    if (shortfall === 0) status = 'paid';   // includes amountDue 0: nothing owed is never arrears
    else if (!late) status = 'notdue';
    else status = received > 0 ? 'partial' : 'unpaid';
    out.push({
      period, dueDate: p.dueDate, workedDays: p.dates.length, units: p.units,
      amountDue, received, shortfall, status,
      overdueDays: status === 'partial' || status === 'unpaid' ? daysBetween(p.dueDate, today) : 0,
    });
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

export function contactStats(promiseId, events, today) {
  const attempts = effectiveEvents(events).filter(e => e.type === 'contact.attempt' && e.data.promiseId === promiseId);
  const lastAnswered = attempts.filter(e => e.data.answered).map(e => e.data.date).sort().pop() || null;
  const unansweredSince = attempts.filter(e => !e.data.answered && (!lastAnswered || e.data.date > lastAnswered));
  return {
    noAnswerCount: attempts.filter(e => !e.data.answered).length,
    noAnswerSinceLastReply: unansweredSince.length,
    lastAnswered,
    // "연락 두절 N일": only meaningful when there are unanswered attempts after the last reply
    silentDays: unansweredSince.length
      ? daysBetween(lastAnswered || unansweredSince.map(e => e.data.date).sort()[0], today)
      : 0,
  };
}

// ---------- sharing boundary (for phase 1b) ----------

// Only structured facts may ever leave the device. Private notes and free text never do.
export function shareableFacts(promiseId, events, today) {
  const ev = effectiveEvents(events);
  const promise = ev.find(e => e.type === 'promise.create' && e.data.id === promiseId)?.data;
  if (!promise) return null;
  const obligations = computeObligations(promiseId, events, today);
  const worst = obligations.filter(o => o.overdueDays > 0).sort((a, b) => b.overdueDays - a.overdueDays)[0];
  const c = contactStats(promiseId, events, today);
  return {
    counterpart: promise.counterpart,
    contractType: promise.contractType,
    arrears: worst ? { label: arrearsLabel(promise.contractType), days: worst.overdueDays, shortfall: worst.shortfall } : null,
    contact: { noAnswerCount: c.noAnswerCount, silentDays: c.silentDays },
  };
}

// ---------- daily-close questions (worker side) ----------

export const DAY_QUESTIONS = [
  { key: 'schedule', q: '오늘 일정은 약속대로였나요?',
    options: [['as_promised', '약속대로'], ['changed_notice', '바뀜 (미리 알려 줌)'], ['changed_sameday', '바뀜 (당일 통보)']] },
  { key: 'workState', q: '오늘 작업 상태는?',
    options: [['done', '완료'], ['progress', '진행 중'], ['waiting', '대기 (자재·설비 문제)']] },
  { key: 'info', q: '작업 지시나 정보는 제때 받았나요?',
    options: [['ontime', '제때 받음'], ['late', '늦게 받음'], ['none', '못 받음']] },
  { key: 'safety', q: '안전교육이나 보호구는 제공됐나요?',
    options: [['yes', '제공됨'], ['partial', '일부만'], ['no', '제공 안 됨']] },
  { key: 'treatment', q: '정규직과 다른 대우가 있었나요? (여러 개 선택 가능)', multi: true,
    options: [['none', '없음'], ['schedule', '일정'], ['rest', '휴게·식사'], ['info', '정보 공유'], ['assignment', '업무 배정']] },
];

export function validateAnswers(answers) {
  const missing = [];
  for (const q of DAY_QUESTIONS) {
    const v = answers?.[q.key];
    if (q.multi ? !(Array.isArray(v) && v.length) : !v) missing.push(q.key);
  }
  if (Array.isArray(answers?.treatment) && answers.treatment.includes('none') && answers.treatment.length > 1) {
    missing.push('treatment-conflict');
  }
  return missing;
}
