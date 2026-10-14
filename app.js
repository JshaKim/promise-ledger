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
const ui = { promiseId: null, answers: {}, msg: '', proofIncludeNotes: false };

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
  renderStatus();
  render();
}

// ---------- helpers ----------

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = n => `${Math.round(n).toLocaleString('ko-KR')}원`;
const $ = sel => document.querySelector(sel);
const today = () => localToday();
// device-local time, e.g. 2026-10-14 21:05 (the stored ts stays UTC ISO for hashing)
const fmtTs = iso => { const d = new Date(iso); return `${localToday(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

function promises() {
  const ev = effectiveEvents(chain);
  const ended = new Map(ev.filter(e => e.type === 'promise.end').map(e => [e.data.promiseId, e.data.endDate]));
  return ev.filter(e => e.type === 'promise.create').map(e => ({ ...e.data, endDate: ended.get(e.data.id) || null }));
}
function promiseById(id) { return promises().find(p => p.id === id); }
function activePromises() { return promises().filter(p => !p.endDate); }

function statusChip(p) {
  const obs = computeObligations(p.id, chain, today());
  const worst = obs.filter(o => o.overdueDays > 0).sort((a, b) => b.overdueDays - a.overdueDays)[0];
  if (worst) return `<span class="chip bad">${arrearsLabel(p.contractType)} ${worst.overdueDays}일차</span>`;
  if (obs.some(o => o.status === 'notdue' && o.amountDue > 0)) return `<span class="chip warn">지급 대기</span>`;
  if (obs.length && obs.every(o => o.status === 'paid')) return `<span class="chip ok">지급 완료</span>`;
  return `<span class="chip muted">기록 없음</span>`;
}

const CONTRACT_LABEL = { labor: '근로 (지시받아 일함)', service: '용역·도급 (일을 맡아 완성)', unknown: '모름' };
const METHOD_LABEL = { transfer: '계좌이체', cash: '현금', other: '기타' };

// ---------- render ----------

function renderStatus() {
  const el = $('#chain-status');
  if (!chain.length) { el.textContent = '기록 0건'; return; }
  el.textContent = chainOk.ok
    ? `기록 ${chain.length}건 · 변조 없음`
    : `⚠ ${chainOk.brokenAt}번 기록부터 변조 의심`;
}

function render() {
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  const view = $('#view');
  view.innerHTML = { today: viewToday, promises: viewPromises, pay: viewPay, proof: viewProof }[tab]();
  bind[tab]?.(view);
}

function promiseSelect(id, list) {
  return `<label class="field">약속
    <select id="sel-promise">${list.map(p => `<option value="${esc(p.id)}" ${p.id === id ? 'selected' : ''}>${esc(p.site || '현장')} · ${esc(p.counterpart)}</option>`).join('')}</select>
  </label>`;
}

function ensurePromiseId(list) {
  if (!list.find(p => p.id === ui.promiseId)) ui.promiseId = list[0]?.id || null;
  return ui.promiseId;
}

// ----- 오늘 마감 -----

function viewToday() {
  const list = activePromises();
  if (!list.length) return `<div class="card"><p class="empty">먼저 <b>약속</b> 탭에서 일의 약속(단가·지급일)을 적어 주세요.<br>그다음부터 매일 여기서 하루를 마감합니다.</p></div>`;
  const pid = ensurePromiseId(list);
  const p = promiseById(pid);
  const already = effectiveEvents(chain).find(e => e.type === 'day.close' && e.data.promiseId === pid && e.data.date === (ui.closeDate || today()));
  return `
  <div class="card">
    ${list.length > 1 ? promiseSelect(pid, list) : `<div class="spread"><h2>${esc(p.site || '현장')} · ${esc(p.counterpart)}</h2>${statusChip(p)}</div>`}
    <div class="two">
      <label class="field">날짜<input type="date" id="close-date" value="${esc(ui.closeDate || today())}" min="${esc(p.startDate || '')}" max="${today()}"></label>
      ${p.rateUnit === 'hour' ? `<label class="field">일한 시간<input type="number" id="close-hours" min="0" max="24" step="0.5" inputmode="decimal" value="${esc(ui.hours ?? '')}"></label>` : '<div></div>'}
    </div>
    ${already ? `<p class="sub">이 날짜는 이미 마감했습니다. 다시 마감하면 마지막 내용이 기준이 됩니다 (이전 기록도 남습니다).</p>` : ''}
  </div>
  <div class="card">
    ${DAY_QUESTIONS.map(q => `
      <div class="q"><span>${esc(q.q)}</span>
        <div class="choices" data-q="${q.key}" ${q.multi ? 'data-multi="1"' : ''}>
          ${q.options.map(([v, label]) => {
            const cur = ui.answers[q.key];
            const on = q.multi ? (cur || []).includes(v) : cur === v;
            return `<button type="button" class="choice" data-v="${v}" aria-pressed="${on}">${esc(label)}</button>`;
          }).join('')}
        </div>
      </div>`).join('')}
  </div>
  <div class="card">
    <label class="field">특이사항 (나만 봅니다 · 선택)
      <textarea id="close-note" placeholder="오늘 있었던 일을 그대로 적어 두세요. 이 내용은 밖으로 나가지 않습니다.">${esc(ui.note || '')}</textarea>
    </label>
    ${ui.msg ? ui.msg : ''}
    <button class="btn" id="do-close">하루 마감</button>
  </div>`;
}

const ANSWER_KEYS_KO = { schedule: '일정', workState: '작업 상태', info: '작업 지시', safety: '안전', treatment: '정규직과 다른 대우', 'treatment-conflict': '"없음"과 다른 항목을 같이 고를 수 없음' };

const bind = {};
bind.today = view => {
  view.querySelector('#sel-promise')?.addEventListener('change', e => { ui.promiseId = e.target.value; ui.answers = {}; ui.msg = ''; render(); });
  view.querySelector('#close-date')?.addEventListener('change', e => { ui.closeDate = e.target.value; render(); });
  view.querySelector('#close-hours')?.addEventListener('input', e => { ui.hours = e.target.value; });
  view.querySelector('#close-note')?.addEventListener('input', e => { ui.note = e.target.value; });
  view.querySelectorAll('.choices').forEach(group => {
    group.addEventListener('click', e => {
      const b = e.target.closest('.choice'); if (!b) return;
      const key = group.dataset.q, v = b.dataset.v;
      if (group.dataset.multi) {
        let cur = new Set(ui.answers[key] || []);
        if (v === 'none') cur = cur.has('none') ? new Set() : new Set(['none']);
        else { cur.delete('none'); cur.has(v) ? cur.delete(v) : cur.add(v); }
        ui.answers[key] = [...cur];
      } else ui.answers[key] = v;
      render();
    });
  });
  view.querySelector('#do-close')?.addEventListener('click', guarded(async () => {
    const p = promiseById(ui.promiseId);
    const date = ui.closeDate || today();
    const missing = validateAnswers(ui.answers);
    const h = Number(ui.hours);
    if (p.rateUnit === 'hour' && !(h > 0 && h <= 24)) missing.push('hours');
    if (missing.length) {
      ui.msg = `<p class="err">아직 답하지 않은 항목: ${missing.map(k => k === 'hours' ? '일한 시간(0~24)' : ANSWER_KEYS_KO[k]).join(', ')}</p>`;
      return render();
    }
    if (date > today()) { ui.msg = `<p class="err">미래 날짜는 마감할 수 없습니다.</p>`; return render(); }
    if (p.startDate && date < p.startDate) { ui.msg = `<p class="err">일 시작일(${esc(p.startDate)})보다 앞선 날짜는 마감할 수 없습니다.</p>`; return render(); }
    const data = { promiseId: p.id, date, answers: { ...ui.answers } };
    if (p.rateUnit === 'hour') data.hours = Number(ui.hours);
    const e = await append('day.close', data);
    if (ui.note?.trim()) await append('note.private', { promiseId: p.id, date, text: ui.note.trim() });
    const summary = `[약속장부] ${date} 마감 · ${p.site || '현장'} · ${p.counterpart} · 기록번호 ${e.seq} · 지문 ${e.hash.slice(0, 16)}`;
    ui.answers = {}; ui.note = ''; ui.hours = '';
    ui.msg = `<p class="done">${esc(date)} 마감했습니다.</p>
      <p class="sub">아래 버튼으로 오늘 기록 요약을 <b>나에게</b> 보내 두면, 그 시각에 기록이 있었다는 제3자 증거가 됩니다.</p>
      <button class="btn ghost" id="share-self" data-text="${esc(summary)}">오늘 기록 요약 나에게 보내기</button>`;
    renderStatus(); render();
    document.querySelector('#share-self')?.addEventListener('click', ev => shareText(ev.currentTarget.dataset.text));
  }));
};

async function shareText(text) {
  try {
    if (navigator.share) { await navigator.share({ text }); return; }
  } catch { /* user cancelled or not allowed: fall through to copy */ }
  try { await navigator.clipboard.writeText(text); alert('복사했습니다. 카카오톡 "나와의 채팅"에 붙여 넣어 주세요.'); }
  catch { prompt('아래 내용을 복사해서 나에게 보내 주세요.', text); }
}

// ----- 약속 -----

function viewPromises() {
  const list = promises();
  return `
  <div class="card">
    <h2>새 약속 적기</h2>
    <p class="sub">말로만 한 약속이라도 그대로 적어 두세요. 적은 날짜와 시각이 함께 남습니다.</p>
    <label class="field">현장 (예: 오창 2라인 셋업)<input id="f-site" autocomplete="off"></label>
    <label class="field">상대 (업체명 또는 소사장 이름)<input id="f-counterpart" autocomplete="off"></label>
    <div class="two">
      <label class="field">단가 (원)<input id="f-rate" type="number" min="0" step="1000" inputmode="numeric"></label>
      <label class="field">기준<select id="f-unit"><option value="day">일당</option><option value="hour">시급</option></select></label>
    </div>
    <label class="field">일하는 방식
      <select id="f-contract">${Object.entries(CONTRACT_LABEL).map(([v, l]) => `<option value="${v}" ${v === 'unknown' ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </label>
    <p class="sub">근로면 못 받은 돈이 <b>임금 체불</b>(노동청), 용역·도급이면 <b>대금 체불</b>(지급명령)로 표시됩니다. 모르면 "모름"으로 두세요.</p>
    <div class="two">
      <label class="field">지급 방식
        <select id="f-payrule"><option value="once">끝나고 한 번에</option><option value="monthly">매월 정해진 날</option></select>
      </label>
      <label class="field" id="f-paywhen-wrap">지급일<input id="f-paydate" type="date"></label>
    </div>
    <div class="two">
      <label class="field">일 시작일<input id="f-start" type="date" value="${today()}"></label>
      <label class="field">받는 수단<select id="f-method">${Object.entries(METHOD_LABEL).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
    </div>
    ${ui.msg || ''}
    <button class="btn" id="do-promise">약속 저장</button>
  </div>
  <div class="card">
    <h2>내 약속</h2>
    ${list.length ? `<ul class="list">${list.map(p => `
      <li><div class="spread"><b>${esc(p.site || '현장')} · ${esc(p.counterpart)}</b>${statusChip(p)}</div>
        <span class="sub">${p.rateUnit === 'hour' ? '시급' : '일당'} ${won(p.rate)} · ${p.payRule === 'monthly' ? `매월 ${p.payDay}일 지급` : `${esc(p.payDate)} 지급`} · ${esc(CONTRACT_LABEL[p.contractType])}${p.endDate ? ` · ${esc(p.endDate)} 종료` : ''}</span>
        ${p.endDate ? '' : `<div class="row noprint"><button class="btn ghost small" data-end="${esc(p.id)}">일 끝남</button></div>`}
      </li>`).join('')}</ul>` : `<p class="empty">아직 적은 약속이 없습니다.</p>`}
  </div>`;
}

bind.promises = view => {
  const rule = view.querySelector('#f-payrule');
  const swap = () => {
    view.querySelector('#f-paywhen-wrap').innerHTML = rule.value === 'monthly'
      ? `지급일 (매월)<input id="f-payday" type="number" min="1" max="31" inputmode="numeric" placeholder="예: 10">`
      : `지급일<input id="f-paydate" type="date">`;
  };
  rule.addEventListener('change', swap);
  view.querySelector('#do-promise').addEventListener('click', guarded(async () => {
    const v = id => view.querySelector(id)?.value?.trim();
    const errs = [];
    const counterpart = v('#f-counterpart'), rate = Number(v('#f-rate')), payRule = v('#f-payrule');
    if (!counterpart) errs.push('상대');
    if (!(rate > 0)) errs.push('단가');
    const data = { id: crypto.randomUUID(), site: v('#f-site'), counterpart, rate, rateUnit: v('#f-unit'),
      contractType: v('#f-contract'), payRule, method: v('#f-method'), startDate: v('#f-start') };
    if (payRule === 'monthly') { data.payDay = Number(v('#f-payday')); if (!(data.payDay >= 1 && data.payDay <= 31)) errs.push('매월 지급일(1~31)'); }
    else { data.payDate = v('#f-paydate'); if (!data.payDate) errs.push('지급일'); }
    if (errs.length) { ui.msg = `<p class="err">빠진 항목: ${errs.join(', ')}</p>`; return render(); }
    await append('promise.create', data);
    ui.msg = ''; ui.promiseId = data.id; tab = 'today';
    ui.answers = {}; ui.hours = ''; ui.closeDate = '';   // a new promise starts with a clean close form
    renderStatus(); render();
  }));
  view.querySelectorAll('[data-end]').forEach(b => b.addEventListener('click', guarded(async () => {
    await append('promise.end', { promiseId: b.dataset.end, endDate: today() });
    renderStatus(); render();
  })));
};

// ----- 지급 -----

function viewPay() {
  const list = promises();
  if (!list.length) return `<div class="card"><p class="empty">약속이 없습니다.</p></div>`;
  const pid = ensurePromiseId(list);
  const p = promiseById(pid);
  const obs = computeObligations(pid, chain, today());
  const c = contactStats(pid, chain, today());
  const label = arrearsLabel(p.contractType);
  const payEvents = effectiveEvents(chain).filter(e => e.type === 'payment.check' && e.data.promiseId === pid);
  return `
  <div class="card">
    ${list.length > 1 ? promiseSelect(pid, list) : `<h2>${esc(p.site || '현장')} · ${esc(p.counterpart)}</h2>`}
  </div>
  ${obs.length ? obs.map(o => `
  <div class="card">
    <div class="spread"><h2>${o.period === 'all' ? '전체 기간' : `${esc(o.period)} 근무분`}</h2>
      ${o.status === 'paid' ? '<span class="chip ok">지급 완료</span>'
        : o.status === 'notdue' ? '<span class="chip warn">지급일 전</span>'
        : `<span class="chip bad">${label} ${o.overdueDays}일차</span>`}
    </div>
    <div class="spread"><span class="sub">근무 ${o.workedDays}일${p.rateUnit === 'hour' ? ` · ${o.units}시간` : ''} · 지급일 ${esc(o.dueDate)}</span></div>
    ${(() => {
      // before the pay date nothing is owed yet: no question, no red line
      const t = today();
      const before = t < o.dueDate, onDay = t === o.dueDate;
      return `
    <div class="spread"><span>${before ? '받을 예정' : '받을 돈'}</span><span class="money big">${won(o.amountDue)}</span></div>
    ${!before || o.received ? `<div class="spread"><span>받은 돈</span><span class="money">${won(o.received)}</span></div>` : ''}
    ${o.shortfall && !before ? (onDay
      ? `<div class="spread"><span>남은 돈</span><span class="money">${won(o.shortfall)}</span></div>`
      : `<div class="spread"><span>못 받은 돈</span><span class="money" style="color:var(--bad);font-weight:700">${won(o.shortfall)}</span></div>`) : ''}
    ${before ? `<p class="sub">지급일(${esc(o.dueDate)})이 되면 받았는지 여쭤볼게요.</p>` : ''}`;
    })()}
    ${o.status !== 'paid' && today() >= o.dueDate ? `
    <div class="q noprint"><span>약속한 돈 받으셨나요?</span>
      <div class="row">
        <button class="btn small" data-pay="full" data-period="${esc(o.period)}">전액 받음</button>
        <button class="btn ghost small" data-pay="partial" data-period="${esc(o.period)}">일부만 받음</button>
        <button class="btn ghost small" data-pay="none" data-period="${esc(o.period)}">못 받음</button>
      </div>
    </div>` : ''}
  </div>`).join('') : `<div class="card"><p class="empty">마감한 근무일이 아직 없습니다.</p></div>`}
  ${payEvents.length ? `<div class="card"><h2>지급 기록</h2><ul class="list">${payEvents.map(e => `
    <li><div class="spread"><span>${esc(fmtTs(e.ts).slice(0, 10))} · ${e.data.result === 'none' ? '못 받음' : won(e.data.amount) + ' 받음'}${e.corrected ? ' <span class="chip muted">정정됨</span>' : ''}</span>
      <button class="btn ghost small noprint" data-fix="${e.seq}">정정</button></div></li>`).join('')}</ul>
    <p class="sub">잘못 적은 기록은 지워지지 않습니다. 정정하면 정정했다는 기록이 함께 남습니다.</p></div>` : ''}
  <div class="card">
    <h2>연락 시도</h2>
    <div class="row">${c.noAnswerCount ? `<span class="chip bad">연락 시도 ${c.noAnswerCount}회 무응답</span>` : ''}${c.silentDays ? `<span class="chip bad">연락 두절 ${c.silentDays}일</span>` : ''}${!c.noAnswerCount ? '<span class="sub">기록 없음</span>' : ''}</div>
    <div class="two">
      <label class="field">수단<select id="c-channel"><option value="phone">전화</option><option value="sms">문자</option><option value="kakao">카카오톡</option><option value="visit">방문</option></select></label>
      <label class="field">날짜<input type="date" id="c-date" value="${today()}" max="${today()}"></label>
    </div>
    <div class="row"><button class="btn ghost small" data-contact="0">응답 없음</button><button class="btn ghost small" data-contact="1">응답 있음</button></div>
  </div>
  ${ui.msg || ''}`;
}

bind.pay = view => {
  view.querySelector('#sel-promise')?.addEventListener('change', e => { ui.promiseId = e.target.value; render(); });
  view.querySelectorAll('[data-pay]').forEach(b => b.addEventListener('click', guarded(async () => {
    const result = b.dataset.pay, period = b.dataset.period, promiseId = ui.promiseId;
    let partial = 0;
    if (result === 'partial') {
      const s = prompt('이번에 받은 금액(원)을 숫자로 적어 주세요.');
      partial = Number(String(s || '').replace(/[^\d]/g, ''));
      if (!(partial > 0)) return;
    }
    await appendWith('payment.check', () => {
      // "full" means: whatever is still owed right now. If nothing is owed any more, record nothing.
      const o = computeObligations(promiseId, chain, today()).find(x => x.period === period);
      if (result === 'full') return o && o.shortfall > 0 ? { promiseId, period, result, amount: o.shortfall } : null;
      return { promiseId, period, result, amount: result === 'partial' ? partial : 0 };
    });
    renderStatus(); render();
  })));
  view.querySelectorAll('[data-fix]').forEach(b => b.addEventListener('click', guarded(async () => {
    const target = effectiveEvents(chain).find(e => e.seq === Number(b.dataset.fix));
    const s = prompt('올바른 받은 금액(원)을 적어 주세요. 못 받았으면 0.', String(target.data.amount));
    if (s === null) return;
    const amount = Number(String(s).replace(/[^\d]/g, '')) || 0;
    await append('correction', { targetSeq: target.seq, replacement: { type: 'payment.check',
      data: { ...target.data, amount, result: amount === 0 ? 'none' : target.data.result === 'none' ? 'partial' : target.data.result } } });
    renderStatus(); render();
  })));
  view.querySelectorAll('[data-contact]').forEach(b => b.addEventListener('click', guarded(async () => {
    await append('contact.attempt', { promiseId: ui.promiseId, date: view.querySelector('#c-date').value || today(),
      channel: view.querySelector('#c-channel').value, answered: b.dataset.contact === '1' });
    renderStatus(); render();
  })));
};

// ----- 증빙 -----

function viewProof() {
  const list = promises();
  const anchor = `
  <div class="card noprint">
    <h2>예전 기록과 대조</h2>
    <p class="sub">하루 마감 때 나에게 보낸 요약(기록번호·지문)을 붙여 넣으면, 그 뒤로 기록이 지워지거나 통째로 다시 만들어지지 않았는지 확인합니다.</p>
    <textarea id="anchor-text" placeholder="[약속장부] … 기록번호 12 · 지문 3fa9c1…"></textarea>
    <button class="btn ghost small" id="do-anchor">대조하기</button>
    ${ui.anchorMsg || ''}
  </div>`;
  const backup = `
  <div class="card noprint">
    <h2>백업</h2>
    <p class="sub">폰을 바꾸거나 앱 데이터를 지우면 기록이 사라집니다. 가끔 백업 파일을 저장해 두세요.</p>
    <div class="row">
      <button class="btn ghost small" id="do-export">백업 파일 저장</button>
      ${chain.length ? '' : '<label class="btn ghost small" style="text-align:center">백업 불러오기<input type="file" id="do-import" accept="application/json" hidden></label>'}
    </div>
    ${chainOk && chainOk.ok && chain.length ? `<p class="sub mono">마지막 기록 지문: ${esc(chain[chain.length - 1].hash)}</p>` : ''}
  </div>`;
  if (!list.length) return `<div class="card"><p class="empty">약속이 없습니다.</p></div>${anchor}${backup}`;
  const pid = ensurePromiseId(list);
  return `
  <div class="card noprint">
    ${list.length > 1 ? promiseSelect(pid, list) : ''}
    <label class="row"><input type="checkbox" id="inc-notes" style="width:auto" ${ui.proofIncludeNotes ? 'checked' : ''}> 특이사항(비공개 기록)도 포함</label>
    <button class="btn" id="do-print">인쇄 / PDF로 저장</button>
  </div>
  ${evidenceDoc(pid, ui.proofIncludeNotes)}
  ${anchor}
  ${backup}`;
}

// A close recorded more than one day after the work date is labelled, so same-day records keep their weight.
const lateMark = e => (daysBetween(e.data.date, fmtTs(e.ts).slice(0, 10)) > 1 ? '<br><b>사후 기록</b>' : '');

const ANS_LABEL = Object.fromEntries(DAY_QUESTIONS.map(q => [q.key, Object.fromEntries(q.options)]));

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
    ${contacts.length ? `<table><tbody>${contacts.map(e => `<tr><td>${esc(e.data.date)}</td><td>${esc({ phone: '전화', sms: '문자', kakao: '카카오톡', visit: '방문' }[e.data.channel])}</td><td>${e.data.answered ? '응답 있음' : '응답 없음'}</td></tr>`).join('')}</tbody></table>` : '<p style="margin:0">없음</p>'}
    ${includeNotes ? `<h4>6. 특이사항 (본인 기록)</h4>${notes.length ? `<table><tbody>${notes.map(e => `<tr><td>${esc(e.data.date)}</td><td style="white-space:pre-wrap">${esc(e.data.text)}</td></tr>`).join('')}</tbody></table>` : '<p style="margin:0">없음</p>'}` : ''}
    <p style="margin:0;font-size:11px;color:#555">이 확인서는 본인이 매일 남긴 기록을 모은 것입니다. 각 기록은 앞 기록과 SHA-256 지문으로 연결되어 있어 중간 기록을 고치거나 지우면 검사에서 드러납니다.
      마지막 기록 지문: <span class="mono">${esc(head?.hash || '')}</span></p>
  </section>`;
}

bind.proof = view => {
  view.querySelector('#sel-promise')?.addEventListener('change', e => { ui.promiseId = e.target.value; render(); });
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
    } catch (err) { alert(err.message); }
  });
};

// ---------- boot ----------

document.querySelector('.tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]'); if (!b) return;
  tab = b.dataset.tab; ui.msg = ''; ui.anchorMsg = ''; render();
});

// Ask the browser not to evict our records under storage pressure (granted silently on most installed PWAs).
navigator.storage?.persist?.().catch(() => {});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

refresh().catch(err => { $('#view').innerHTML = `<div class="card"><p class="err">저장소를 열 수 없습니다: ${esc(err.message)}</p></div>`; });
