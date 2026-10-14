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

def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))

with sync_playwright() as p:
    b = p.chromium.launch()
    for scheme in ['light', 'dark']:
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, color_scheme=scheme, locale='ko-KR', timezone_id='Asia/Seoul')
        page = ctx.new_page()
        page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
        page.on('pageerror', lambda e: errors.append(str(e)))
        dialogs = []
        def on_dialog(dl):
            dialogs.append((dl.type, dl.message))
            dl.accept('200000' if dl.type == 'prompt' else None)
        page.on('dialog', on_dialog)
        page.goto('http://127.0.0.1:8811/index.html')
        page.wait_for_selector('#view .card')
        if scheme == 'light':
            check('empty state guides to 약속 tab', '약속' in page.inner_text('#view'))

            # create a promise: 30만/day, service, paid once 4 days ago
            page.click('button[data-tab=promises]')
            page.click('#do-promise')
            check('promise form rejects missing fields', '빠진 항목' in page.inner_text('#view'))
            page.fill('#f-site', '오창 2라인 셋업')
            page.fill('#f-counterpart', '○○테크 김사장')
            page.fill('#f-rate', '300000')
            page.select_option('#f-contract', 'service')
            page.fill('#f-paydate', d(4))
            page.fill('#f-start', d(7))
            page.click('#do-promise')
            page.wait_for_selector('#do-close', timeout=5000)
            check('after saving, app moves to 오늘 마감', page.get_attribute('button[data-tab=today]', 'aria-selected') == 'true')

            # close without answers -> error
            page.click('#do-close')
            check('close requires all answers', '아직 답하지 않은 항목' in page.inner_text('#view'))

            def close_day(date, note=''):
                page.fill('#close-date', date); page.dispatch_event('#close-date', 'change')
                for key, val in [('schedule', 'changed_sameday'), ('workState', 'waiting'), ('info', 'late'), ('safety', 'partial')]:
                    page.click(f'.choices[data-q={key}] .choice[data-v={val}]')
                page.click('.choices[data-q=treatment] .choice[data-v=rest]')
                page.click('.choices[data-q=treatment] .choice[data-v=info]')
                if note: page.fill('#close-note', note)
                page.click('#do-close')
                page.wait_for_selector('.done', timeout=5000)
            # a date before the start date is refused
            page.fill('#close-date', d(8)); page.dispatch_event('#close-date', 'change')
            for key, val in [('schedule', 'as_promised'), ('workState', 'done'), ('info', 'ontime'), ('safety', 'yes'), ('treatment', 'none')]:
                page.click(f'.choices[data-q={key}] .choice[data-v={val}]')
            page.click('#do-close'); page.wait_for_selector('.err', timeout=5000)
            check('close before start date refused', '일 시작일' in page.inner_text('#view'))
            page.click('.choices[data-q=treatment] .choice[data-v=none]')  # untoggle so close_day can pick others
            close_day(d(6), '점심 때 프리랜서만 따로 먹으라고 함')
            page.wait_for_selector('text=마감했습니다', timeout=5000)
            check('close succeeds', '마감했습니다' in page.inner_text('#view'))
            anchor_text = page.get_attribute('#share-self', 'data-text')
            check('summary carries seq and fingerprint', '기록번호' in anchor_text and '지문' in anchor_text, anchor_text)
            close_day(d(5))
            page.screenshot(path=str(out / 'light-1-today.png'), full_page=True)

            # pay tab: arrears 4 days on 600,000
            page.click('button[data-tab=pay]')
            txt = page.inner_text('#view')
            check('pay shows 대금 체불 4일차', '대금 체불 4일차' in txt, txt[:200])
            check('pay shows 600,000원 due', '600,000원' in txt)
            page.click('button[data-pay=partial]')
            page.wait_for_selector('text=400,000원', timeout=5000)
            txt = page.inner_text('#view')
            check('partial payment leaves 400,000원 shortfall', '400,000원' in txt and '대금 체불 4일차' in txt)
            # a fast double tap records once, not twice
            page.evaluate("() => { const b = document.querySelector('[data-contact=\"0\"]'); b.click(); b.click(); }")
            page.wait_for_selector('text=연락 시도 1회 무응답', timeout=5000)
            page.wait_for_timeout(300)
            check('double tap on contact records once', '연락 시도 1회 무응답' in page.inner_text('#view'))
            page.click('button[data-contact="0"]')
            page.wait_for_selector('text=연락 시도 2회 무응답', timeout=5000)
            check('contact attempts counted', '연락 시도 2회 무응답' in page.inner_text('#view'))
            page.screenshot(path=str(out / 'light-2-pay.png'), full_page=True)

            # correction keeps chain valid and changes the amount
            page.click('button[data-fix]')  # prompt answers 200000 again -> same amount, still a correction event
            page.wait_for_selector('text=정정됨', timeout=5000)
            check('correction marked', '정정됨' in page.inner_text('#view'))

            # proof
            page.click('button[data-tab=proof]')
            txt = page.inner_text('#view')
            check('evidence alert line', '대금 체불 4일차' in txt and '연락 시도 2회 무응답' in txt, txt[:300])
            check('backfilled closes marked 사후 기록', txt.count('사후 기록') == 2, str(txt.count('사후 기록')))
            check('private note hidden by default', '따로 먹으라고' not in txt)
            page.check('#inc-notes')
            check('private note shown when opted in', '따로 먹으라고' in page.inner_text('#view'))
            check('header says no tampering', '변조 없음' in page.inner_text('#chain-status'), page.inner_text('#chain-status'))
            page.fill('#anchor-text', anchor_text); page.click('#do-anchor')
            check('anchor from summary matches', '일치합니다' in page.inner_text('#view'))
            page.screenshot(path=str(out / 'light-3-proof.png'), full_page=True)

            # horizontal overflow at phone width
            for t in ['today', 'promises', 'pay', 'proof']:
                page.click(f'button[data-tab={t}]')
                sw = page.evaluate('document.documentElement.scrollWidth')
                check(f'no horizontal scroll on {t}', sw <= 390, f'scrollWidth={sw}')

            # double tap on "전액 받음": only the remaining 400,000 is recorded once
            page.click('button[data-tab=pay]')
            page.evaluate("() => { const b = document.querySelector('[data-pay=\"full\"]'); b.click(); b.click(); }")
            page.wait_for_selector('text=지급 완료', timeout=5000)
            page.wait_for_timeout(300)
            txt = page.inner_text('#view')
            check('double tap on full payment records the shortfall once', '1,000,000원' not in txt and txt.count('400,000원 받음') == 1, txt[:400])

            # hourly promise: more than 24 hours is refused
            page.click('button[data-tab=promises]')
            page.fill('#f-site', '시급 현장'); page.fill('#f-counterpart', '△△'); page.fill('#f-rate', '15000')
            page.select_option('#f-unit', 'hour'); page.fill('#f-paydate', d(0)); page.fill('#f-start', d(3))
            page.click('#do-promise'); page.wait_for_selector('#do-close', timeout=5000)
            page.fill('#close-hours', '25')
            for key, val in [('schedule', 'as_promised'), ('workState', 'done'), ('info', 'ontime'), ('safety', 'yes'), ('treatment', 'none')]:
                page.click(f'.choices[data-q={key}] .choice[data-v={val}]')
            page.click('#do-close'); page.wait_for_selector('.err', timeout=5000)
            check('25 hours refused', '일한 시간(0~24)' in page.inner_text('#view'))

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
            check('dialogs used', len(dialogs) >= 2, str(dialogs))
        else:
            page.screenshot(path=str(out / 'dark-0-empty.png'), full_page=True)
        ctx.close()
    b.close()
srv.shutdown()

for name, ok, detail in results:
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if not ok and detail else ''))
print(f'{sum(ok for _, ok, _ in results)}/{len(results)} passed')
print('console/page errors:', errors or 'none')
