import {
  makeEvent, verifyChain, effectiveEvents, computeObligations, contactStats, arrearsLabel,
  DAY_QUESTIONS, validateAnswers, localToday, daysBetween, parseAnchor, verifyAnchor,
} from './core.js';

// ---------- storage: IndexedDB, append-only ----------

const DB_NAME = 'promise-ledger', STORE = 'events';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'seq' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function loadAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.seq - b.seq));
    req.onerror = () => reject(req.error);
  });
}
async function putNew(events) {          // add() fails if a seq already exists: no overwrite possible
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    for (const e of events) tx.objectStore(STORE).add(e);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- state ----------

let chain = [];
let chainOk = null;
let tab = 'today';
const ui = {
  promiseId: null,
  // daily close flow
  step: 0, answers: {}, closeDate: '', hours: '', note: '', reclose: false, err: '',
  // promise form
  formOpen: false, form: {}, formErr: '',
  // proof
  proofIncludeNotes: false, anchorMsg: '',
};

// Appends run one at a time: a fast double tap must not compute the same seq twice.
let appendQueue = Promise.resolve();
function append(type, data) {
  const run = appendQueue.then(async () => {
    const e = await makeEvent(chain, type, data);
    await putNew([e]);
    chain.push(e);
    return e;
  });
  appendQueue = run.catch(() => {});
  return run;
}
// Like append, but the data is computed inside the queue from the current chain; null = skip.
function appendWith(type, build) {
  const run = appendQueue.then(async () => {
    const data = build();
    if (!data) return null;
    const e = await makeEvent(chain, type, data);
    await putNew([e]);
    chain.push(e);
    return e;
  });
  appendQueue = run.catch(() => {});
  return run;
}
// One action at a time from the UI: a double tap records once, not twice.
let busy = false;
const guarded = fn => async (...args) => {
  if (busy) return;
  busy = true;
  try { await fn(...args); } finally { busy = false; }
};

async function refresh() {
  chain = await loadAll();
  chainOk = await verifyChain(chain);
  render();
}

// ---------- helpers ----------

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = n => `${Math.round(n).toLocaleString('ko-KR')}원`;
const $ = sel => document.querySelector(sel);
const today = () => localToday();
const shiftDay = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return localToday(new Date(y, m - 1, d + n)); };
// device-local time, e.g. 2026-10-14 21:05 (the stored ts stays UTC ISO for hashing)
const fmtTs = iso => { const d = new Date(iso); return `${localToday(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const longDate = iso => { const [y, m, d] = iso.split('-').map(Number); return `${m}월 ${d}일 ${WEEK[new Date(y, m - 1, d).getDay()]}요일`; };
const shortDate = iso => { const [, m, d] = iso.split('-').map(Number); return `${m}월 ${d}일`; };
// keep digits, +, - only; empty -> undefined so it is not stored
const cleanPhone = s => { const t = String(s || '').replace(/[^\d+-]/g, ''); return t || undefined; };
const dialable = ph => String(ph).replace(/[^\d+]/g, '');
const digits = s => Number(String(s ?? '').replace(/[^\d]/g, '')) || 0;

function promises() {
  const ev = effectiveEvents(chain);
  const ended = new Map(ev.filter(e => e.type === 'promise.end').map(e => [e.data.promiseId, e.data.endDate]));
  return ev.filter(e => e.type === 'promise.create').map(e => ({ ...e.data, endDate: ended.get(e.data.id) || null }));
}
function promiseById(id) { return promises().find(p => p.id === id); }
function activePromises() { return promises().filter(p => !p.endDate); }
function ensurePromiseId(list) {
  if (!list.find(p => p.id === ui.promiseId)) ui.promiseId = list[0]?.id || null;
  return ui.promiseId;
}
const promiseName = p => p.site ? `${p.site} · ${p.counterpart}` : p.counterpart;

const CONTRACT_LABEL = { labor: '근로 (지시받아 일함)', service: '용역·도급 (일을 맡아 완성)', unknown: '모름' };
const METHOD_LABEL = { transfer: '계좌이체', cash: '현금', other: '기타' };
const CHANNEL_LABEL = { phone: '전화', sms: '문자', kakao: '카카오톡', visit: '방문' };
const ANS_LABEL = Object.fromEntries(DAY_QUESTIONS.map(q => [q.key, Object.fromEntries(q.options)]));

// Where the money stands for one promise, in one line.
function payState(p) {
  const t = today();
  const obs = computeObligations(p.id, chain, t);
  const label = arrearsLabel(p.contractType);
  const worst = obs.filter(o => o.overdueDays > 0).sort((a, b) => b.overdueDays - a.overdueDays)[0];
  if (worst) {
    const owed = obs.filter(o => o.overdueDays > 0).reduce((s, o) => s + o.shortfall, 0);
    return { tone: 'bad', head: `${label} ${worst.overdueDays}일차`, line: `못 받은 돈 ${won(owed)}` };
  }
  const dueToday = obs.find(o => o.dueDate === t && o.status !== 'paid');
  if (dueToday) return { tone: 'warn', head: '오늘 지급일', line: `받을 돈 ${won(dueToday.shortfall)}` };
  const next = obs.filter(o => o.status === 'notdue').sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
  if (next) return { tone: '', head: `지급일까지 D-${daysBetween(t, next.dueDate)}`, line: `${shortDate(next.dueDate)} · 받을 예정 ${won(next.amountDue)}` };
  if (obs.length && obs.every(o => o.status === 'paid')) return { tone: 'ok', head: '지급 완료', line: `받은 돈 ${won(obs.reduce((s, o) => s + o.received, 0))}` };
  return { tone: '', head: '아직 근무 기록 없음', line: '하루를 마감하면 받을 돈이 쌓입니다' };
}
const pillOf = s => `<span class="pill ${s.tone || 'muted'}">${esc(s.head)}</span>`;

function switcher(list, pid) {
  if (list.length < 2) return '';
  return `<div class="switcher" role="group" aria-label="약속 선택">${list.map(p =>
    `<button data-pid="${esc(p.id)}" aria-pressed="${p.id === pid}">${esc(promiseName(p))}</button>`).join('')}</div>`;
}
function bindSwitcher(view, after) {
  view.querySelectorAll('[data-pid]').forEach(b => b.addEventListener('click', () => {
    ui.promiseId = b.dataset.pid; after?.(); render();
  }));
}

// ---------- sheet & toast (replace browser prompt/alert) ----------

function sheet({ title, text = '', fields = [], ok = '저장', body = '' }) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'backdrop';
    wrap.innerHTML = `
      <form class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="grab"></div>
        <h2>${esc(title)}</h2>
        ${text ? `<p class="sub">${text}</p>` : ''}
        ${body}
        ${fields.map(f => `<label class="field">${esc(f.label)}
          <input id="${f.id}" type="${f.type || 'text'}" ${f.inputmode ? `inputmode="${f.inputmode}"` : ''} placeholder="${esc(f.placeholder || '')}" value="${esc(f.value ?? '')}" autocomplete="off"></label>`).join('')}
        <button class="btn" id="sheet-ok" type="submit">${esc(ok)}</button>
        <button class="btn plain" id="sheet-cancel" type="button">취소</button>
      </form>`;
    const close = val => { wrap.remove(); resolve(val); };
    wrap.addEventListener('click', e => { if (e.target === wrap) close(null); });
    wrap.querySelector('#sheet-cancel').addEventListener('click', () => close(null));
    wrap.querySelector('form').addEventListener('submit', e => {
      e.preventDefault();
      close(Object.fromEntries(fields.map(f => [f.id, wrap.querySelector('#' + f.id).value])));
    });
    document.body.appendChild(wrap);
    wrap.querySelector('input')?.focus();
  });
}

function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

async function shareText(text) {
  try { if (navigator.share) { await navigator.share({ text }); return; } } catch { /* cancelled: fall back to copy */ }
  try { await navigator.clipboard.writeText(text); toast('복사했어요. 카카오톡 "나와의 채팅"에 붙여 넣어 주세요.'); }
  catch {
    await sheet({ title: '요약 복사', text: '아래 내용을 길게 눌러 복사한 뒤 나에게 보내 주세요.', ok: '닫기',
      body: `<textarea readonly>${esc(text)}</textarea>` });
  }
}

// ---------- shell ----------

const TITLES = { today: '오늘', promises: '약속', pay: '지급', proof: '증빙' };

function renderShell() {
  $('#page-title').textContent = TITLES[tab];
  document.querySelectorAll('.tabbar button').forEach(b => {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  const el = $('#chain-status');
  el.className = 'chain-pill';
  if (!chain.length) { el.textContent = '기록 0건'; return; }
  if (chainOk.ok) { el.classList.add('ok'); el.textContent = `기록 ${chain.length}건 · 변조 없음`; }
  else { el.classList.add('bad'); el.textContent = `⚠ ${chainOk.brokenAt}번 기록부터 변조 의심`; }
}

// Every redraw bumps this. A pending auto-advance only fires if nothing redrew the screen in the meantime.
let renderCount = 0;
function render() {
  renderCount++;
  renderShell();
  document.querySelector('.fab')?.remove();
  const view = $('#view');
  view.innerHTML = { today: viewToday, promises: viewPromises, pay: viewPay, proof: viewProof }[tab]();
  bind[tab]?.(view);
}
const bind = {};

// ================= 오늘 =================

function closeSteps(p) {
  return [...(p.rateUnit === 'hour' ? ['hours'] : []), ...DAY_QUESTIONS.map(q => q.key), 'note'];
}
function closeOf(pid, date) {
  return effectiveEvents(chain).filter(e => e.type === 'day.close' && e.data.promiseId === pid && e.data.date === date).pop() || null;
}
let advancing = false;
function resetFlow() { ui.step = 0; ui.answers = {}; ui.hours = ''; ui.note = ''; ui.err = ''; ui.reclose = false; }

function viewToday() {
  const list = activePromises();
  if (!list.length) {
    return `<div class="card empty">
      <svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="M9 14.5l2 2 4-4"/></svg>
      <p class="title">약속한 돈, 제때 받으셨나요?</p>
      <p class="sub">일의 단가와 지급일을 적어 두고 매일 10초씩 하루를 마감하면,<br>지급일이 지났을 때 기록이 바로 증거가 됩니다.</p>
      <button class="btn" id="go-new">첫 약속 적기</button>
      <p class="sub">기록은 이 폰에만 저장됩니다.</p>
    </div>`;
  }
  const pid = ensurePromiseId(list);
  const p = promiseById(pid);
  const date = ui.closeDate || today();
  const closed = closeOf(pid, date);
  const s = payState(p);
  return `
  ${switcher(list, pid)}
  <section class="card hero">
    <p class="date">${esc(longDate(today()))}</p>
    <p class="title">${esc(promiseName(p))}</p>
    <div class="status ${s.tone}"><b>${esc(s.head)}</b><span>${esc(s.line)}</span></div>
  </section>
  ${closed && !ui.reclose ? doneCard(p, closed, date) : flowCard(p, date)}`;
}

function dateChips(p, date) {
  const t = today(), y = shiftDay(t, -1);
  const canYesterday = !p.startDate || y >= p.startDate;
  return `<div class="datechips">
    <button class="chipbtn" data-date="${t}" aria-pressed="${date === t}">오늘</button>
    ${canYesterday ? `<button class="chipbtn" data-date="${y}" aria-pressed="${date === y}">어제</button>` : ''}
    <input type="date" id="close-date" aria-label="다른 날짜" value="${esc(date)}" min="${esc(p.startDate || '')}" max="${t}">
  </div>`;
}

function flowCard(p, date) {
  const steps = closeSteps(p);
  const i = Math.min(ui.step, steps.length - 1);
  const key = steps[i];
  const dots = steps.map((_, k) => `<i class="${k === i ? 'on' : k < i ? 'past' : ''}"></i>`).join('');
  let body;
  if (key === 'hours') {
    body = `<p class="q-title">${esc(shortDate(date))}에 몇 시간 일했나요?</p>
      <div class="hourpad">
        <button class="round" data-hstep="-0.5" aria-label="30분 줄이기">−</button>
        <input id="close-hours" type="number" inputmode="decimal" min="0" max="24" step="0.5" placeholder="0" value="${esc(ui.hours)}" aria-label="일한 시간">
        <button class="round" data-hstep="0.5" aria-label="30분 늘리기">+</button>
      </div>
      <div class="datechips" style="justify-content:center">${[4, 8, 10, 12].map(h => `<button class="chipbtn" data-hours="${h}">${h}시간</button>`).join('')}</div>
      <button class="btn" id="step-next">다음</button>`;
  } else if (key === 'note') {
    const rows = DAY_QUESTIONS.map(q => {
      const v = ui.answers[q.key];
      const txt = q.multi ? (v || []).map(k => ANS_LABEL[q.key][k]).join(', ') : ANS_LABEL[q.key][v];
      return `<li><span>${esc(q.q.replace(/\s*\(.*\)$/, '').replace(/\?$/, ''))}</span><button data-jump="${steps.indexOf(q.key)}">${esc(txt || '고르기')}</button></li>`;
    }).join('');
    body = `<p class="q-title">마지막으로, 특이사항이 있었나요?</p>
      <textarea id="close-note" placeholder="오늘 있었던 일을 그대로 적어 두세요. 나만 보는 기록이에요. (선택)">${esc(ui.note)}</textarea>
      <ul class="summary"><li><span>날짜</span><button data-jump="0">${esc(shortDate(date))}</button></li>${p.rateUnit === 'hour' ? `<li><span>일한 시간</span><button data-jump="0">${esc(ui.hours || '0')}시간</button></li>` : ''}${rows}</ul>
      ${ui.err}
      <button class="btn" id="do-close">하루 마감</button>`;
  } else {
    const q = DAY_QUESTIONS.find(x => x.key === key);
    const cur = ui.answers[key];
    body = `<p class="q-title">${esc(q.q.replace(/\s*\(여러 개 선택 가능\)/, ''))}</p>
      ${q.multi ? '<p class="sub">해당하는 것을 모두 고르세요.</p>' : ''}
      <div class="choices" data-q="${q.key}" ${q.multi ? 'data-multi="1"' : ''}>
        ${q.options.map(([v, label]) => {
          const on = q.multi ? (cur || []).includes(v) : cur === v;
          return `<button class="opt" data-v="${v}" aria-pressed="${on}">${esc(label)}</button>`;
        }).join('')}
      </div>
      ${q.multi ? `<button class="btn" id="step-next" ${(cur || []).length ? '' : 'disabled'}>다음</button>` : ''}`;
  }
  return `<section class="card">
    <div class="flowhead"><span class="eyebrow">하루 마감 · ${i + 1}/${steps.length}</span><span class="dots">${dots}</span></div>
    ${i === 0 ? dateChips(p, date) : `<p class="sub">${esc(longDate(date))}</p>`}
    <div class="step" data-step="${key}">${body}</div>
    ${i > 0 ? '<button class="linkbtn" id="step-back">← 이전</button>' : ''}
  </section>`;
}

function summaryOf(p, e) {
  return `[약속장부] ${e.data.date} 마감 · ${p.site || '현장'} · ${p.counterpart} · 기록번호 ${e.seq} · 지문 ${e.hash.slice(0, 16)}`;
}

function doneCard(p, e, date) {
  return `<section class="card donecard">
    <div class="check"><svg viewBox="0 0 24 24"><path d="M5.5 12.5l4.5 4.5 8.5-9.5"/></svg></div>
    <p class="title done">${esc(shortDate(date))} 마감했습니다</p>
    <p class="sub">기록번호 ${e.seq} · ${esc(fmtTs(e.ts))} 기록</p>
    ${date !== today() && !closeOf(p.id, today()) ? `<button class="btn" data-date="${today()}">오늘(${esc(shortDate(today()))}) 마감하기</button>` : ''}
    <button class="btn soft" id="share-self" data-text="${esc(summaryOf(p, e))}">이 기록 요약 나에게 보내기</button>
    <p class="sub">카톡 "나와의 채팅"에 보내 두면, 이 시각에 기록이 있었다는 증거가 됩니다.</p>
    <div class="row" style="justify-content:center">
      ${dateChips(p, date)}
    </div>
    <button class="linkbtn" id="reclose">이 날짜 다시 마감하기</button>
  </section>`;
}

bind.today = view => {
  view.querySelector('#go-new')?.addEventListener('click', () => { tab = 'promises'; ui.formOpen = true; render(); });
  bindSwitcher(view, resetFlow);
  // changing the date keeps the answers given so far, whether picked by chip or by the date field
  view.querySelectorAll('[data-date]').forEach(b => b.addEventListener('click', () => { ui.closeDate = b.dataset.date; ui.reclose = false; ui.err = ''; render(); }));
  view.querySelector('#close-date')?.addEventListener('change', e => {
    const v = e.target.value, p0 = promiseById(ui.promiseId);
    // refuse an impossible date right where it is picked, not five questions later
    if (!v || v > today()) { toast('미래 날짜는 마감할 수 없어요.'); return render(); }
    if (p0?.startDate && v < p0.startDate) { toast(`일 시작일(${shortDate(p0.startDate)})보다 앞선 날짜는 마감할 수 없어요.`); return render(); }
    ui.closeDate = v; ui.reclose = false; ui.err = ''; render();   // answers given so far are kept
  });
  view.querySelector('#reclose')?.addEventListener('click', () => { resetFlow(); ui.reclose = true; render(); });
  view.querySelector('#share-self')?.addEventListener('click', ev => shareText(ev.currentTarget.dataset.text));

  const p = promiseById(ui.promiseId);
  if (!p) return;
  const steps = closeSteps(p);
  const next = () => { ui.step = Math.min(ui.step + 1, steps.length - 1); render(); };
  view.querySelector('#step-back')?.addEventListener('click', () => { ui.step = Math.max(0, ui.step - 1); ui.err = ''; render(); });
  view.querySelectorAll('[data-jump]').forEach(b => b.addEventListener('click', () => { ui.step = Number(b.dataset.jump); ui.err = ''; render(); }));

  const hours = view.querySelector('#close-hours');
  hours?.addEventListener('input', e => { ui.hours = e.target.value; });
  view.querySelectorAll('[data-hours]').forEach(b => b.addEventListener('click', () => { ui.hours = b.dataset.hours; render(); }));
  view.querySelectorAll('[data-hstep]').forEach(b => b.addEventListener('click', () => {
    const h = Math.min(24, Math.max(0, (Number(ui.hours) || 0) + Number(b.dataset.hstep)));
    ui.hours = String(h); render();
  }));
  view.querySelector('#step-next')?.addEventListener('click', () => {
    if (steps[ui.step] === 'hours') {
      const h = Number(ui.hours);
      if (!(h > 0 && h <= 24)) { toast('일한 시간을 0~24 사이로 적어 주세요.'); return; }
    }
    next();
  });

  view.querySelectorAll('.choices').forEach(group => {
    group.addEventListener('click', e => {
      const b = e.target.closest('.opt'); if (!b) return;
      const key = group.dataset.q, v = b.dataset.v;
      if (group.dataset.multi) {
        let cur = new Set(ui.answers[key] || []);
        if (v === 'none') cur = cur.has('none') ? new Set() : new Set(['none']);
        else { cur.delete('none'); cur.has(v) ? cur.delete(v) : cur.add(v); }
        ui.answers[key] = [...cur];
        render();
      } else {
        if (advancing) return;   // a second quick tap must not skip the next question
        ui.answers[key] = v;
        group.querySelectorAll('.opt').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
        advancing = true;
        // let the check mark show before moving on, but only if no other action redrew the screen meanwhile
        const at = renderCount;
        setTimeout(() => {
          advancing = false;
          if (at === renderCount) next();
        }, 160);
      }
    });
  });

  view.querySelector('#close-note')?.addEventListener('input', e => { ui.note = e.target.value; });
  view.querySelector('#do-close')?.addEventListener('click', guarded(async () => {
    const date = ui.closeDate || today();
    const missing = validateAnswers(ui.answers);
    const h = Number(ui.hours);
    if (p.rateUnit === 'hour' && !(h > 0 && h <= 24)) missing.push('hours');
    const names = { schedule: '일정', workState: '작업 상태', info: '작업 지시', safety: '안전', treatment: '다른 대우', 'treatment-conflict': '"없음"과 다른 항목 동시 선택', hours: '일한 시간(0~24)' };
    if (missing.length) { ui.err = `<p class="err">아직 답하지 않은 항목: ${missing.map(k => names[k]).join(', ')}</p>`; return render(); }
    if (date > today()) { ui.err = `<p class="err">미래 날짜는 마감할 수 없습니다.</p>`; return render(); }
    if (p.startDate && date < p.startDate) { ui.err = `<p class="err">일 시작일(${esc(p.startDate)})보다 앞선 날짜는 마감할 수 없습니다.</p>`; return render(); }
    const data = { promiseId: p.id, date, answers: { ...ui.answers } };
    if (p.rateUnit === 'hour') data.hours = h;
    await append('day.close', data);
    if (ui.note.trim()) await append('note.private', { promiseId: p.id, date, text: ui.note.trim() });
    resetFlow();
    navigator.vibrate?.(30);
    render();
  }));
};

// ================= 약속 =================

function seg(name, options, cur) {
  return `<div class="seg" data-seg="${name}">${options.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${cur === v}">${esc(l)}</button>`).join('')}</div>`;
}

function defaultForm() {
  return { site: '', counterpart: '', phone: '', rate: '', unit: 'day', payrule: 'once', paydate: '', payday: '', contract: 'unknown', method: 'transfer', start: today() };
}

function viewPromises() {
  const list = promises();
  if (ui.formOpen || !list.length) return promiseForm(!list.length);
  return `
  ${list.map(p => {
    const s = payState(p);
    return `<section class="card">
      <div class="spread"><p class="title">${esc(promiseName(p))}</p>${pillOf(s)}</div>
      <div class="kv"><span>단가</span><span class="money">${p.rateUnit === 'hour' ? '시급' : '일당'} ${won(p.rate)}</span></div>
      <div class="kv"><span>지급</span><span>${p.payRule === 'monthly' ? `매월 ${p.payDay}일` : esc(shortDate(p.payDate))} · ${esc(METHOD_LABEL[p.method] || '')}</span></div>
      <div class="kv"><span>일하는 방식</span><span>${esc(CONTRACT_LABEL[p.contractType])}</span></div>
      ${p.endDate ? `<p class="sub">${esc(shortDate(p.endDate))}에 일이 끝났습니다.</p>` : `<button class="linkbtn" data-end="${esc(p.id)}">일이 끝났어요</button>`}
    </section>`;
  }).join('')}
  <div style="height:56px"></div>`;
}

function promiseForm(first) {
  const f = ui.form = { ...defaultForm(), ...ui.form };
  return `<section class="card">
    ${first ? '<p class="title">어떤 일을 약속받았나요?</p><p class="sub">말로만 한 약속이라도 그대로 적어 두세요. 적은 날짜와 시각이 함께 남습니다.</p>'
            : '<div class="spread"><p class="title">새 약속</p><button class="linkbtn" id="cancel-promise">닫기</button></div>'}
    <label class="field">현장<input id="f-site" placeholder="예: 오창 2라인 셋업" value="${esc(f.site)}" autocomplete="off"></label>
    <label class="field">상대 (업체 또는 소사장)<input id="f-counterpart" placeholder="예: ○○테크 김사장" value="${esc(f.counterpart)}" autocomplete="off"></label>
    <label class="field">상대 연락처 (선택)<input id="f-phone" type="tel" inputmode="tel" placeholder="010-0000-0000" value="${esc(f.phone)}" autocomplete="off"></label>
  </section>
  <section class="card">
    <p class="eyebrow">얼마를 받기로 했나요?</p>
    ${seg('unit', [['day', '일당'], ['hour', '시급']], f.unit)}
    <label class="field">단가 (원)<input id="f-rate" type="number" inputmode="numeric" min="0" step="1000" placeholder="300000" value="${esc(f.rate)}"></label>
    <p class="eyebrow">언제 받기로 했나요?</p>
    ${seg('payrule', [['once', '끝나고 한 번에'], ['monthly', '매월 정해진 날']], f.payrule)}
    ${f.payrule === 'monthly'
      ? `<label class="field">매월 며칠<input id="f-payday" type="number" inputmode="numeric" min="1" max="31" placeholder="10" value="${esc(f.payday)}"></label><p class="help">전월에 일한 만큼을 이날 받습니다.</p>`
      : `<label class="field">지급일<input id="f-paydate" type="date" value="${esc(f.paydate)}"></label>`}
    <p class="eyebrow">받는 수단</p>
    ${seg('method', Object.entries(METHOD_LABEL), f.method)}
  </section>
  <section class="card">
    <p class="eyebrow">어떤 방식으로 일하나요?</p>
    ${seg('contract', [['labor', '근로'], ['service', '용역·도급'], ['unknown', '모름']], f.contract)}
    <p class="help">근로면 못 받은 돈이 <b>임금 체불</b>(노동청), 용역·도급이면 <b>대금 체불</b>(지급명령)로 표시돼요. 회사가 시간·방법을 지시하면 근로에 가깝습니다. 모르면 "모름"으로 두세요.</p>
    <label class="field">일 시작일<input id="f-start" type="date" value="${esc(f.start)}"></label>
    ${ui.formErr}
    <button class="btn" id="do-promise">약속 저장</button>
  </section>`;
}

function readForm(view) {
  const g = id => view.querySelector(id)?.value;
  const f = ui.form;
  for (const [k, id] of [['site', '#f-site'], ['counterpart', '#f-counterpart'], ['phone', '#f-phone'], ['rate', '#f-rate'],
                         ['paydate', '#f-paydate'], ['payday', '#f-payday'], ['start', '#f-start']]) {
    const v = g(id); if (v !== undefined) f[k] = v;
  }
}

bind.promises = view => {
  const list = promises();
  if (!(ui.formOpen || !list.length)) {
    const fab = document.createElement('button');
    fab.className = 'fab'; fab.id = 'new-promise'; fab.textContent = '+ 새 약속';
    fab.addEventListener('click', () => { ui.formOpen = true; ui.form = {}; ui.formErr = ''; render(); });
    document.body.appendChild(fab);
  }
  view.querySelectorAll('[data-end]').forEach(b => b.addEventListener('click', guarded(async () => {
    const ok = await sheet({ title: '일이 끝났나요?', text: '오늘 날짜로 이 약속의 일을 끝낸 것으로 기록합니다. 받을 돈 기록은 그대로 남아요.', ok: '끝났어요' });
    if (!ok) return;
    await append('promise.end', { promiseId: b.dataset.end, endDate: today() });
    render();
  })));
  view.querySelector('#cancel-promise')?.addEventListener('click', () => { ui.formOpen = false; ui.formErr = ''; render(); });
  view.querySelectorAll('[data-seg]').forEach(group => group.addEventListener('click', e => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    readForm(view);
    ui.form[group.dataset.seg] = b.dataset.v;
    render();
  }));
  view.querySelector('#do-promise')?.addEventListener('click', guarded(async () => {
    readForm(view);
    const f = ui.form, errs = [];
    const counterpart = f.counterpart.trim(), rate = digits(f.rate);
    if (!counterpart) errs.push('상대');
    if (!(rate > 0)) errs.push('단가');
    const data = { id: crypto.randomUUID(), site: f.site.trim(), counterpart, phone: cleanPhone(f.phone), rate, rateUnit: f.unit,
      contractType: f.contract, payRule: f.payrule, method: f.method, startDate: f.start };
    if (f.payrule === 'monthly') { data.payDay = Number(f.payday); if (!(data.payDay >= 1 && data.payDay <= 31)) errs.push('매월 지급일(1~31)'); }
    else { data.payDate = f.paydate; if (!data.payDate) errs.push('지급일'); }
    if (errs.length) { ui.formErr = `<p class="err">빠진 항목: ${errs.join(', ')}</p>`; return render(); }
    await append('promise.create', data);
    ui.formOpen = false; ui.form = {}; ui.formErr = '';
    ui.promiseId = data.id; ui.closeDate = ''; resetFlow();
    tab = 'today';
    toast('약속을 저장했어요. 이제 매일 하루를 마감해 주세요.');
    render();
  }));
};

// ================= 지급 =================

function viewPay() {
  const list = promises();
  if (!list.length) return `<div class="card empty"><p class="title">아직 약속이 없어요</p><p class="sub">약속 탭에서 먼저 적어 주세요.</p></div>`;
  const pid = ensurePromiseId(list);
  const p = promiseById(pid);
  const t = today();
  const obs = computeObligations(pid, chain, t);
  const c = contactStats(pid, chain, t);
  const label = arrearsLabel(p.contractType);
  const payEvents = effectiveEvents(chain).filter(e => e.type === 'payment.check' && e.data.promiseId === pid);
  return `
  ${switcher(list, pid)}
  ${obs.length ? obs.map(o => {
    const before = t < o.dueDate, onDay = t === o.dueDate;
    const pct = o.amountDue ? Math.min(100, Math.round(o.received / o.amountDue * 100)) : 0;
    const pill = o.status === 'paid' ? '<span class="pill ok">지급 완료</span>'
      : before ? `<span class="pill muted">D-${daysBetween(t, o.dueDate)}</span>`
      : onDay ? '<span class="pill warn">오늘 지급일</span>'
      : `<span class="pill bad">${label} ${o.overdueDays}일차</span>`;
    return `<section class="card">
      <div class="spread"><span class="eyebrow">${o.period === 'all' ? '전체 기간' : `${esc(o.period)} 근무분`} · 근무 ${o.workedDays}일${p.rateUnit === 'hour' ? ` · ${o.units}시간` : ''}</span>${pill}</div>
      <div><p class="sub">${before ? '받을 예정' : '받을 돈'}</p><p class="amount" style="margin:0">${won(o.amountDue)}</p></div>
      ${!before || o.received ? `<div class="bar" aria-label="받은 비율 ${pct}%"><i style="width:${pct}%"></i></div>
        <div class="kv"><span>받은 돈</span><span class="money">${won(o.received)}</span></div>` : ''}
      ${o.shortfall && !before ? `<div class="kv ${onDay ? '' : 'bad'}"><span>${onDay ? '남은 돈' : '못 받은 돈'}</span><span class="money">${won(o.shortfall)}</span></div>` : ''}
      <div class="kv"><span>지급일</span><span>${esc(longDate(o.dueDate))}</span></div>
      ${before ? `<p class="sub">지급일이 되면 받았는지 여쭤볼게요.</p>` : ''}
      ${o.status !== 'paid' && !before ? `
      <div class="noprint" style="display:grid;gap:10px">
        <p class="title" style="font-size:17px">약속한 돈 받으셨나요?</p>
        <div class="btngrid">
          <button class="btn" data-pay="full" data-period="${esc(o.period)}">전액 받음</button>
          <button class="btn soft" data-pay="partial" data-period="${esc(o.period)}">일부만</button>
          <button class="btn danger" data-pay="none" data-period="${esc(o.period)}">못 받음</button>
        </div>
      </div>` : ''}
    </section>`;
  }).join('') : `<div class="card empty"><p class="title">아직 마감한 날이 없어요</p><p class="sub">오늘 탭에서 하루를 마감하면 받을 돈이 쌓입니다.</p></div>`}
  ${payEvents.length ? `<section class="card"><p class="eyebrow">지급 기록</p><ul class="list">${payEvents.map(e => `
    <li><div class="spread"><span>${esc(shortDate(fmtTs(e.ts).slice(0, 10)))} · ${e.data.result === 'none' ? '못 받음' : won(e.data.amount) + ' 받음'}${e.corrected ? ' <span class="pill muted">정정됨</span>' : ''}</span>
      <button class="linkbtn noprint" data-fix="${e.seq}">정정</button></div></li>`).join('')}</ul>
    <p class="sub">잘못 적은 기록은 지워지지 않고, 정정했다는 기록이 함께 남아요.</p></section>` : ''}
  ${contactCard(p, obs, c)}`;
}

// Before any pay date: only the counterpart's number (if known). From the first pay date: the attempt log too.
function contactCard(p, obs, c) {
  const due = obs.some(o => today() >= o.dueDate) || c.noAnswerCount > 0;
  const phoneLine = p.phone
    ? `<div class="spread"><span class="money" style="font-size:18px;font-weight:700">${esc(p.phone)}</span>
         <span class="row"><a class="btn soft small" href="tel:${esc(dialable(p.phone))}">전화</a><a class="btn soft small" href="sms:${esc(dialable(p.phone))}">문자</a></span></div>`
    : `<button class="btn plain small noprint" id="add-phone">상대 연락처 적기</button>`;
  if (!due) return p.phone ? `<section class="card"><p class="eyebrow">상대 연락처</p>${phoneLine}</section>` : '';
  return `<section class="card">
    <div class="spread"><p class="eyebrow">연락 시도</p>
      <span class="row">${c.noAnswerCount ? `<span class="pill bad">연락 시도 ${c.noAnswerCount}회 무응답</span>` : ''}${c.silentDays ? `<span class="pill bad">연락 두절 ${c.silentDays}일</span>` : ''}</span></div>
    ${phoneLine}
    <p class="sub">연락했는데 답이 없었다면 기록해 두세요. 무응답 횟수가 증거가 됩니다.</p>
    ${seg('channel', Object.entries(CHANNEL_LABEL), ui.channel || 'phone')}
    <label class="field">날짜<input type="date" id="c-date" value="${today()}" max="${today()}"></label>
    <div class="two"><button class="btn danger" data-contact="0">응답 없음</button><button class="btn plain" data-contact="1">응답 있음</button></div>
  </section>`;
}

bind.pay = view => {
  bindSwitcher(view);
  view.querySelectorAll('[data-seg=channel]').forEach(g => g.addEventListener('click', e => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    ui.channel = b.dataset.v; render();
  }));
  view.querySelectorAll('[data-pay]').forEach(b => b.addEventListener('click', guarded(async () => {
    const result = b.dataset.pay, period = b.dataset.period, promiseId = ui.promiseId;
    let partial = 0;
    if (result === 'partial') {
      const r = await sheet({ title: '얼마 받으셨나요?', text: '이번에 실제로 들어온 금액만 적어 주세요.', ok: '기록하기',
        fields: [{ id: 'sheet-amount', label: '받은 금액 (원)', type: 'number', inputmode: 'numeric', placeholder: '200000' }] });
      if (!r) return;
      partial = digits(r['sheet-amount']);
      if (!(partial > 0)) { toast('금액을 숫자로 적어 주세요.'); return; }
    }
    if (result === 'none') {
      const r = await sheet({ title: '아직 못 받으셨나요?', text: '못 받았다고 기록합니다. 지급일 다음 날부터 체불 일수가 계속 세어집니다.', ok: '못 받음으로 기록' });
      if (!r) return;
    }
    await appendWith('payment.check', () => {
      // "full" means: whatever is still owed right now. If nothing is owed any more, record nothing.
      const o = computeObligations(promiseId, chain, today()).find(x => x.period === period);
      if (result === 'full') return o && o.shortfall > 0 ? { promiseId, period, result, amount: o.shortfall } : null;
      return { promiseId, period, result, amount: result === 'partial' ? partial : 0 };
    });
    toast(result === 'full' ? '전액 받은 것으로 기록했어요.' : result === 'partial' ? `${won(partial)} 받은 것으로 기록했어요.` : '못 받은 것으로 기록했어요.');
    render();
  })));
  view.querySelectorAll('[data-fix]').forEach(b => b.addEventListener('click', guarded(async () => {
    const target = effectiveEvents(chain).find(e => e.seq === Number(b.dataset.fix));
    const r = await sheet({ title: '받은 금액 정정', text: '원래 기록은 남고, 정정했다는 기록이 추가돼요. 못 받았으면 0.', ok: '정정하기',
      fields: [{ id: 'sheet-amount', label: '올바른 받은 금액 (원)', type: 'number', inputmode: 'numeric', value: target.data.amount }] });
    if (!r) return;
    const amount = digits(r['sheet-amount']);
    await append('correction', { targetSeq: target.seq, replacement: { type: 'payment.check',
      data: { ...target.data, amount, result: amount === 0 ? 'none' : target.data.result === 'none' ? 'partial' : target.data.result } } });
    toast('정정했어요.');
    render();
  })));
  view.querySelector('#add-phone')?.addEventListener('click', guarded(async () => {
    const r = await sheet({ title: '상대 연락처', ok: '저장',
      fields: [{ id: 'sheet-phone', label: '전화번호', type: 'tel', inputmode: 'tel', placeholder: '010-0000-0000' }] });
    const phone = cleanPhone(r?.['sheet-phone']);
    if (!phone) return;
    const target = effectiveEvents(chain).find(e => e.type === 'promise.create' && e.data.id === ui.promiseId);
    await append('correction', { targetSeq: target.seq, replacement: { type: 'promise.create', data: { ...target.data, phone } } });
    render();
  }));
  view.querySelectorAll('[data-contact]').forEach(b => b.addEventListener('click', guarded(async () => {
    await append('contact.attempt', { promiseId: ui.promiseId, date: view.querySelector('#c-date').value || today(),
      channel: ui.channel || 'phone', answered: b.dataset.contact === '1' });
    toast(b.dataset.contact === '1' ? '응답 있음으로 기록했어요.' : '응답 없음으로 기록했어요.');
    render();
  })));
};

// ================= 증빙 =================

function viewProof() {
  const list = promises();
  const anchor = `
  <section class="card noprint">
    <p class="eyebrow">예전 기록과 대조</p>
    <p class="sub">하루 마감 때 나에게 보낸 요약(기록번호·지문)을 붙여 넣으면, 그 뒤로 기록이 지워지거나 통째로 다시 만들어지지 않았는지 확인해요.</p>
    <textarea id="anchor-text" placeholder="[약속장부] … 기록번호 12 · 지문 3fa9c1…"></textarea>
    <button class="btn plain" id="do-anchor">대조하기</button>
    ${ui.anchorMsg}
  </section>`;
  const backup = `
  <section class="card noprint">
    <p class="eyebrow">백업</p>
    <p class="sub">기록은 이 폰에만 있어요. 폰을 바꾸거나 앱 데이터를 지우면 사라지니 가끔 백업 파일을 저장해 두세요.</p>
    <button class="btn plain" id="do-export">백업 파일 저장</button>
    ${chain.length ? '' : '<label class="btn plain">백업 불러오기<input type="file" id="do-import" accept="application/json" hidden></label>'}
    ${chainOk && chainOk.ok && chain.length ? `<p class="mono">마지막 기록 지문 ${esc(chain[chain.length - 1].hash)}</p>` : ''}
  </section>`;
  if (!list.length) return `<div class="card empty"><p class="title">아직 약속이 없어요</p></div>${anchor}${backup}`;
  const pid = ensurePromiseId(list);
  return `
  ${switcher(list, pid)}
  <section class="card noprint">
    <label class="toggle">특이사항(나만 보는 기록)도 넣기<input type="checkbox" id="inc-notes" ${ui.proofIncludeNotes ? 'checked' : ''}></label>
    <button class="btn" id="do-print">확인서 PDF로 저장</button>
    <p class="help">인쇄 화면에서 "PDF로 저장"을 고르면 파일로 남길 수 있어요.</p>
  </section>
  ${evidenceDoc(pid, ui.proofIncludeNotes)}
  ${anchor}
  ${backup}`;
}

// A close recorded more than one day after the work date is labelled, so same-day records keep their weight.
const lateMark = e => (daysBetween(e.data.date, fmtTs(e.ts).slice(0, 10)) > 1 ? '<br><b>사후 기록</b>' : '');

function evidenceDoc(pid, includeNotes) {
  const p = promiseById(pid);
  const ev = effectiveEvents(chain);
  const t = today();
  const obs = computeObligations(pid, chain, t);
  const c = contactStats(pid, chain, t);
  const label = arrearsLabel(p.contractType);
  const byDate = new Map();
  for (const e of ev) if (e.type === 'day.close' && e.data.promiseId === pid) byDate.set(e.data.date, e);
  const closes = [...byDate.values()].sort((a, b) => a.data.date.localeCompare(b.data.date));
  const pays = ev.filter(e => e.type === 'payment.check' && e.data.promiseId === pid);
  const contacts = ev.filter(e => e.type === 'contact.attempt' && e.data.promiseId === pid);
  const notes = ev.filter(e => e.type === 'note.private' && e.data.promiseId === pid);
  const created = ev.find(e => e.type === 'promise.create' && e.data.id === pid);
  const overdue = obs.filter(o => o.overdueDays > 0);
  const totalShort = overdue.reduce((s, o) => s + o.shortfall, 0);
  const head = chain[chain.length - 1];
  return `
  <section class="doc">
    <h3>근무 및 지급 기록 확인서</h3>
    <p style="margin:0;font-size:13px">작성일 ${esc(t)} · 약속장부 기록 기준 · ${chainOk?.ok ? '기록 변조 검사 통과' : '<b>기록 변조 검사 실패</b>'}</p>
    ${overdue.length ? `<div class="alert">${label} ${Math.max(...overdue.map(o => o.overdueDays))}일차 · 못 받은 돈 ${won(totalShort)}${c.noAnswerCount ? ` · 연락 시도 ${c.noAnswerCount}회 무응답` : ''}${c.silentDays ? ` · 연락 두절 ${c.silentDays}일` : ''}</div>` : ''}
    <h4>1. 약속 내용 (기록 시각 ${esc(fmtTs(created.ts))})</h4>
    <table><tbody>
      <tr><th>현장</th><td>${esc(p.site || '')}</td></tr>
      <tr><th>상대</th><td>${esc(p.counterpart)}</td></tr>
      ${p.phone ? `<tr><th>상대 연락처</th><td>${esc(p.phone)}</td></tr>` : ''}
      <tr><th>단가</th><td>${p.rateUnit === 'hour' ? '시급' : '일당'} ${won(p.rate)}</td></tr>
      <tr><th>지급 약속</th><td>${p.payRule === 'monthly' ? `매월 ${p.payDay}일 (전월 근무분)` : esc(p.payDate)} · ${esc(METHOD_LABEL[p.method] || '')}</td></tr>
      <tr><th>일하는 방식 (본인 기재)</th><td>${esc(CONTRACT_LABEL[p.contractType])}</td></tr>
      <tr><th>시작일</th><td>${esc(p.startDate || '')}${p.endDate ? ` ~ 종료 ${esc(p.endDate)}` : ''}</td></tr>
    </tbody></table>
    <h4>2. 지급 현황</h4>
    <div class="tablewrap"><table class="wide"><thead><tr><th>기간</th><th>근무일</th><th>지급일</th><th>받을 돈</th><th>받은 돈</th><th>상태</th></tr></thead><tbody>
      ${obs.map(o => `<tr><td>${o.period === 'all' ? '전체' : esc(o.period)}</td><td>${o.workedDays}${p.rateUnit === 'hour' ? ` (${o.units}h)` : ''}</td><td>${esc(o.dueDate)}</td><td>${won(o.amountDue)}</td><td>${won(o.received)}</td>
        <td>${o.status === 'paid' ? '지급 완료' : o.status === 'notdue' ? '지급일 전' : `${label} ${o.overdueDays}일차`}</td></tr>`).join('')}
    </tbody></table></div>
    <h4>3. 근무일 기록 (매일 마감, 기록 시각 포함)</h4>
    <div class="tablewrap"><table class="wide"><thead><tr><th>날짜</th><th>기록 시각 (폰 시간)</th>${p.rateUnit === 'hour' ? '<th>시간</th>' : ''}<th>일정</th><th>작업</th><th>지시</th><th>안전</th><th>다른 대우</th></tr></thead><tbody>
      ${closes.map(e => { const a = e.data.answers; return `<tr><td>${esc(e.data.date)}</td><td>${esc(fmtTs(e.ts))}${lateMark(e)}</td>${p.rateUnit === 'hour' ? `<td>${e.data.hours}</td>` : ''}
        <td>${esc(ANS_LABEL.schedule[a.schedule])}</td><td>${esc(ANS_LABEL.workState[a.workState])}</td><td>${esc(ANS_LABEL.info[a.info])}</td><td>${esc(ANS_LABEL.safety[a.safety])}</td>
        <td>${esc((a.treatment || []).map(k => ANS_LABEL.treatment[k]).join(', '))}</td></tr>`; }).join('')}
    </tbody></table></div>
    <h4>4. 지급 확인 기록</h4>
    ${pays.length ? `<table><tbody>${pays.map(e => `<tr><td>${esc(fmtTs(e.ts))}</td><td>${e.data.result === 'none' ? '못 받음' : won(e.data.amount) + ' 받음'}${e.corrected ? ' (정정됨)' : ''}</td></tr>`).join('')}</tbody></table>` : '<p style="margin:0">없음</p>'}
    <h4>5. 연락 시도 기록</h4>
    ${contacts.length ? `<table><tbody>${contacts.map(e => `<tr><td>${esc(e.data.date)}</td><td>${esc(CHANNEL_LABEL[e.data.channel])}</td><td>${e.data.answered ? '응답 있음' : '응답 없음'}</td></tr>`).join('')}</tbody></table>` : '<p style="margin:0">없음</p>'}
    ${includeNotes ? `<h4>6. 특이사항 (본인 기록)</h4>${notes.length ? `<table><tbody>${notes.map(e => `<tr><td>${esc(e.data.date)}</td><td style="white-space:pre-wrap">${esc(e.data.text)}</td></tr>`).join('')}</tbody></table>` : '<p style="margin:0">없음</p>'}` : ''}
    <p style="margin:0;font-size:11px;color:#555">이 확인서는 본인이 매일 남긴 기록을 모은 것입니다. 각 기록은 앞 기록과 SHA-256 지문으로 연결되어 있어 중간 기록을 고치거나 지우면 검사에서 드러납니다.
      마지막 기록 지문: <span class="mono">${esc(head?.hash || '')}</span></p>
  </section>`;
}

bind.proof = view => {
  bindSwitcher(view);
  view.querySelector('#inc-notes')?.addEventListener('change', e => { ui.proofIncludeNotes = e.target.checked; render(); });
  view.querySelector('#do-print')?.addEventListener('click', () => window.print());
  view.querySelector('#do-anchor')?.addEventListener('click', async () => {
    const a = parseAnchor(view.querySelector('#anchor-text').value);
    const r = a ? await verifyAnchor(chain, a.seq, a.hashPrefix) : { ok: false, reason: 'bad-anchor' };
    ui.anchorMsg = r.ok
      ? `<p class="done">일치합니다. 1번부터 ${a.seq}번까지의 기록은 그 요약을 보낸 때와 같습니다.</p>
         <p class="sub">${a.seq}번 이후의 기록은 이 대조로 보증되지 않습니다. 더 최근에 보낸 요약으로 대조하면 범위가 넓어집니다.</p>`
      : r.reason === 'bad-anchor' ? `<p class="err">요약에서 기록번호와 지문을 찾지 못했습니다.</p>`
      : r.reason === 'missing' ? `<p class="err">${a.seq}번 기록이 없습니다. 기록이 지워졌을 수 있습니다.</p>`
      : r.reason === 'broken' ? `<p class="err">${r.brokenAt}번 기록의 내용이 저장된 지문과 맞지 않습니다. 기록이 고쳐졌을 수 있습니다.</p>`
      : `<p class="err">${a.seq}번 기록의 지문이 요약과 다릅니다. 기록이 다시 만들어졌을 수 있습니다.</p>`;
    render();
  });
  view.querySelector('#do-export')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ app: 'promise-ledger', version: 1, exportedAt: new Date().toISOString(), events: chain }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `약속장부-백업-${today()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  view.querySelector('#do-import')?.addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const events = parsed.events;
      if (!Array.isArray(events) || !events.length) throw new Error('기록이 없는 파일입니다.');
      const v = await verifyChain(events);
      if (!v.ok) throw new Error(`${v.brokenAt}번 기록에서 변조가 감지되어 불러오지 않았습니다.`);
      if (chain.length) throw new Error('이미 기록이 있는 폰에는 불러올 수 없습니다.');
      await putNew(events);
      await refresh();
      toast('백업을 불러왔어요.');
    } catch (err) { toast(err.message); }
  });
};

// ---------- boot ----------

document.querySelector('.tabbar').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]'); if (!b) return;
  tab = b.dataset.tab; ui.anchorMsg = ''; ui.formErr = '';
  if (tab !== 'promises') ui.formOpen = false;
  render();
  window.scrollTo(0, 0);
});

// Ask the browser not to evict our records under storage pressure (granted silently on most installed PWAs).
navigator.storage?.persist?.().catch(() => {});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

refresh().catch(err => { $('#view').innerHTML = `<div class="card"><p class="err">저장소를 열 수 없습니다: ${esc(err.message)}</p></div>`; });
