"""End-to-end self test for promise_ledger at phone width. Usage: python e2e_ledger.py <app_dir> <out_dir>"""
import datetime as dt, functools, http.server, sys, threading, pathlib
from playwright.sync_api import sync_playwright

app_dir, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(app_dir))
handler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8811), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()

today = dt.date.today()
d = lambda n: (today - dt.timedelta(days=n)).isoformat()
results, errors = [], []
WIDTH = 390

def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))

ALL_OK = [('schedule', 'as_promised'), ('workState', 'done'), ('info', 'ontime'), ('safety', 'yes')]
ALL_BAD = [('schedule', 'changed_sameday'), ('workState', 'waiting'), ('info', 'late'), ('safety', 'partial')]

with sync_playwright() as p:
    b = p.chromium.launch()
    for scheme in ['light', 'dark']:
        ctx = b.new_context(viewport={'width': WIDTH, 'height': 844}, color_scheme=scheme, locale='ko-KR', timezone_id='Asia/Seoul')
        page = ctx.new_page()
        page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto('http://127.0.0.1:8811/index.html')
        page.wait_for_selector('#view .card')
        view = lambda: page.inner_text('#view')

        def open_form():
            page.click('button[data-tab=promises]')
            if page.query_selector('#new-promise'):
                page.click('#new-promise')
            page.wait_for_selector('#do-promise')

        def create_promise(site, counterpart, rate, paydate, start, contract='service', unit='day', phone=''):
            open_form()
            page.fill('#f-site', site); page.fill('#f-counterpart', counterpart)
            if phone: page.fill('#f-phone', phone)
            if unit != 'day': page.click(f'[data-seg=unit] [data-v={unit}]')
            page.fill('#f-rate', str(rate))
            page.fill('#f-paydate', paydate)
            page.click(f'[data-seg=contract] [data-v={contract}]')
            page.fill('#f-start', start)
            page.click('#do-promise')
            page.wait_for_selector('.flowhead', timeout=5000)

        def close_day(date, singles, multi, note='', hours=None):
            page.fill('#close-date', date); page.dispatch_event('#close-date', 'change')
            if hours is not None:
                page.fill('#close-hours', str(hours)); page.click('#step-next')
            for key, val in singles:
                page.click(f'.choices[data-q={key}] .opt[data-v={val}]')
            for v in multi:
                page.click(f'.choices[data-q=treatment] .opt[data-v={v}]')
            page.click('#step-next')
            if note: page.fill('#close-note', note)
            page.click('#do-close')
            page.wait_for_selector('.donecard', timeout=5000)

        if scheme == 'light':
            check('empty state invites the first promise', '첫 약속 적기' in view())
            page.screenshot(path=str(out / 'light-0-empty.png'))
            page.click('#go-new'); page.wait_for_selector('#do-promise')
            page.click('#do-promise')
            check('promise form rejects missing fields', '빠진 항목' in view())
            check('contract type defaults to 모름', page.query_selector('[data-seg=contract] [data-v=unknown][aria-pressed=true]') is not None)
            page.screenshot(path=str(out / 'light-1-form.png'), full_page=True)

            create_promise('오창 2라인 셋업', '○○테크 김사장', 300000, d(4), d(7))
            check('after saving, app moves to 오늘', page.get_attribute('button[data-tab=today]', 'aria-current') == 'page')
            check('hero shows the arrears state is not yet there (no closes)', '아직 근무 기록 없음' in view())

            # a fast double tap on an answer must not skip the next question
            page.evaluate("() => { const b = document.querySelector('.choices[data-q=schedule] .opt[data-v=as_promised]'); b.click(); b.click(); }")
            page.wait_for_selector('.step[data-step=workState]', timeout=5000)
            page.wait_for_timeout(400)
            check('double tap on an answer does not skip a question', page.query_selector('.step[data-step=workState]') is not None)
            page.click('#step-back'); page.wait_for_selector('.step[data-step=schedule]')

            # Codex UI round 1: a date chip keeps the answers; a chip tapped inside the 160 ms advance window cancels the advance
            page.click('.datechips [data-date]:nth-of-type(2)')   # 어제
            page.wait_for_timeout(200)
            check('date chip keeps answers given so far', page.query_selector('.choices[data-q=schedule] .opt[data-v=as_promised][aria-pressed=true]') is not None)
            page.click('.datechips [data-date]:nth-of-type(1)')   # back to 오늘
            page.evaluate("() => { document.querySelector('.choices[data-q=schedule] .opt[data-v=changed_notice]').click(); document.querySelectorAll('.datechips [data-date]')[1].click(); }")
            page.wait_for_timeout(400)
            check('date change inside the advance window does not skip a question', page.query_selector('.step[data-step=schedule]') is not None)
            while page.query_selector('#step-back'):   # recover so a failure above is reported, not a crash
                page.click('#step-back')
            page.click('.datechips [data-date]:nth-of-type(1)')

            # multi-select step: 다음 disabled until something is picked
            for key, val in ALL_OK:
                page.click(f'.choices[data-q={key}] .opt[data-v={val}]')
            page.wait_for_selector('.step[data-step=treatment]')
            check('multi-select step blocks 다음 until a choice', page.is_disabled('#step-next'))
            page.screenshot(path=str(out / 'light-2-step.png'), full_page=True)
            page.reload(); page.wait_for_selector('.flowhead')  # a reload starts the flow over

            # a date before the start date is refused the moment it is picked
            page.fill('#close-date', d(8)); page.dispatch_event('#close-date', 'change')
            page.wait_for_selector('.toast', timeout=5000)
            check('close before start date refused at the date step', '일 시작일' in page.inner_text('.toast') and page.input_value('#close-date') == d(0))

            close_day(d(6), ALL_BAD, ['rest', 'info'], '점심 때 프리랜서만 따로 먹으라고 함')
            check('close succeeds', '마감했습니다' in view())
            anchor_text = page.get_attribute('#share-self', 'data-text')
            check('summary carries seq and fingerprint', '기록번호' in anchor_text and '지문' in anchor_text, anchor_text)
            page.screenshot(path=str(out / 'light-3-done.png'), full_page=True)
            close_day(d(5), ALL_BAD, ['rest', 'info'])
            check('hero shows arrears after the pay date', '대금 체불 4일차' in view() and '600,000원' in view(), view()[:200])
            page.screenshot(path=str(out / 'light-4-today.png'), full_page=True)

            # pay
            page.click('button[data-tab=pay]')
            txt = view()
            check('pay shows 대금 체불 4일차', '대금 체불 4일차' in txt, txt[:200])
            check('pay shows 600,000원 due', '600,000원' in txt)
            page.click('button[data-pay=partial]'); page.fill('#sheet-amount', '200000'); page.click('#sheet-ok')
            page.wait_for_selector('text=400,000원', timeout=5000)
            check('partial payment leaves 400,000원 shortfall', '400,000원' in view() and '대금 체불 4일차' in view())
            page.evaluate("() => { const b = document.querySelector('[data-contact=\"0\"]'); b.click(); b.click(); }")
            page.wait_for_selector('text=연락 시도 1회 무응답', timeout=5000)
            page.wait_for_timeout(300)
            check('double tap on contact records once', '연락 시도 1회 무응답' in view())
            page.click('button[data-contact="0"]')
            page.wait_for_selector('text=연락 시도 2회 무응답', timeout=5000)
            page.click('#add-phone'); page.fill('#sheet-phone', '010-5555-6666'); page.click('#sheet-ok')
            page.wait_for_selector('a[href^="tel:"]', timeout=5000)
            check('number added later shows call link', page.get_attribute('a[href^="tel:"]', 'href') == 'tel:01055556666')
            check('adding a number keeps the chain valid', '변조 없음' in page.inner_text('#chain-status'))
            page.screenshot(path=str(out / 'light-5-pay.png'), full_page=True)
            page.click('button[data-fix]'); page.click('#sheet-ok')
            page.wait_for_selector('text=정정됨', timeout=5000)
            check('correction marked', '정정됨' in view())

            # proof
            page.click('button[data-tab=proof]')
            txt = view()
            check('evidence alert line', '대금 체불 4일차' in txt and '연락 시도 2회 무응답' in txt, txt[:300])
            check('backfilled closes marked 사후 기록', txt.count('사후 기록') == 2, str(txt.count('사후 기록')))
            check('evidence shows the added number', '010-5555-6666' in txt)
            check('private note hidden by default', '따로 먹으라고' not in txt)
            page.check('#inc-notes')
            check('private note shown when opted in', '따로 먹으라고' in view())
            check('header says no tampering', '변조 없음' in page.inner_text('#chain-status'), page.inner_text('#chain-status'))
            page.fill('#anchor-text', anchor_text); page.click('#do-anchor')
            check('anchor from summary matches', '일치합니다' in view())
            page.screenshot(path=str(out / 'light-6-proof.png'), full_page=True)

            for t in ['today', 'promises', 'pay', 'proof']:
                page.click(f'button[data-tab={t}]')
                sw = page.evaluate('document.documentElement.scrollWidth')
                check(f'no horizontal scroll on {t}', sw <= WIDTH, f'scrollWidth={sw}')
            page.click('button[data-tab=promises]')
            page.screenshot(path=str(out / 'light-7-promises.png'), full_page=True)

            # double tap on "전액 받음": only the remaining 400,000 is recorded once
            page.click('button[data-tab=pay]')
            page.evaluate("() => { const b = document.querySelector('[data-pay=\"full\"]'); b.click(); b.click(); }")
            page.wait_for_selector('text=지급 완료', timeout=5000)
            page.wait_for_timeout(300)
            txt = view()
            check('double tap on full payment records the shortfall once', '1,000,000원' not in txt and txt.count('400,000원 받음') == 1, txt[:400])

            # hourly promise: more than 24 hours is refused at the hours step
            create_promise('시급 현장', '△△', 15000, d(0), d(3), unit='hour')
            page.fill('#close-hours', '25'); page.click('#step-next')
            page.wait_for_selector('.toast', timeout=5000)
            check('25 hours refused', '0~24' in page.inner_text('.toast') and page.query_selector('#close-hours') is not None)

            # pay-date timing
            def promise_and_close(name, paydate, phone=''):
                create_promise(name, name, 100000, paydate, d(1), phone=phone)
                close_day(d(0), ALL_OK, ['none'])
                page.click('button[data-tab=pay]')
                return view()
            txt = promise_and_close('미래무번호', d(-30))
            check('before pay date: no question, no red shortfall', '약속한 돈 받으셨나요' not in txt and '못 받은 돈' not in txt and '받을 예정' in txt and '여쭤볼게요' in txt, txt[:300])
            check('before pay date, no phone: no contact box', '연락 시도' not in txt and '상대 연락처' not in txt, txt[-200:])
            txt = promise_and_close('미래지급', d(-30), '010-2222-3333')
            check('before pay date with phone: number only, no attempt log', '010-2222-3333' in txt and '응답 없음' not in txt and '연락 시도' not in txt, txt[-250:])
            check('call link dials the number', page.get_attribute('a[href^="tel:"]', 'href') == 'tel:01022223333')
            page.screenshot(path=str(out / 'light-8-before-due.png'), full_page=True)
            txt = promise_and_close('오늘지급', d(0))
            check('on pay date without phone: attempt log + add-number button', '연락 시도' in txt and '상대 연락처 적기' in txt, txt[-250:])
            check('on pay date: question shown, remainder neutral', '약속한 돈 받으셨나요' in txt and '남은 돈' in txt and '못 받은 돈' not in txt and '체불' not in txt, txt[:300])

            # Codex UI round 1: switching promise inside the advance window starts the new promise at question 1
            page.click('button[data-tab=today]'); page.wait_for_selector('.switcher')
            page.evaluate("() => { const o = document.querySelector('.choices[data-q=schedule] .opt'); if (o) o.click(); document.querySelectorAll('.switcher [data-pid]')[0].click(); }")
            page.wait_for_timeout(400)
            check('promise switch inside the advance window does not skip a question', page.query_selector('.step[data-step=schedule]') is not None or page.query_selector('.donecard') is not None)
            # Codex UI round 2: re-tapping the promise that is already selected must not skip either
            page.evaluate("() => { const o = document.querySelector('.choices[data-q=schedule] .opt'); if (o) o.click(); document.querySelector('.switcher [aria-pressed=true]').click(); }")
            page.wait_for_timeout(400)
            check('re-selecting the current promise inside the advance window does not skip', page.query_selector('.step[data-step=schedule]') is not None or page.query_selector('.donecard') is not None)

            # tamper: edit event #3 directly in IndexedDB, reload -> must be flagged
            page.evaluate("""() => new Promise((res, rej) => {
              const r = indexedDB.open('promise-ledger', 1);
              r.onsuccess = () => { const tx = r.result.transaction('events', 'readwrite'); const st = tx.objectStore('events');
                const g = st.get(3); g.onsuccess = () => { const e = g.result; e.data.date = '2020-01-01'; st.put(e); };
                tx.oncomplete = res; tx.onerror = rej; };
            })""")
            page.reload(); page.wait_for_selector('#view .card')
            st = page.inner_text('#chain-status')
            check('tampering detected after direct DB edit', '변조 의심' in st and '3번' in st, st)
        else:
            page.screenshot(path=str(out / 'dark-0-empty.png'))
            page.click('#go-new'); page.wait_for_selector('#do-promise')
            page.fill('#f-counterpart', '다크'); page.fill('#f-rate', '250000'); page.fill('#f-paydate', d(2)); page.fill('#f-start', d(5))
            page.click('#do-promise'); page.wait_for_selector('.flowhead')
            page.screenshot(path=str(out / 'dark-1-today.png'), full_page=True)
        ctx.close()
    b.close()
srv.shutdown()

for name, ok, detail in results:
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if not ok and detail else ''))
print(f'{sum(ok for _, ok, _ in results)}/{len(results)} passed')
print('console/page errors:', errors or 'none')
