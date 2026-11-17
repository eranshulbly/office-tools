"""
Castrol DigiClaim - "CN not adjusted on invoice" auto-filler.

For every row in the "CN not adjusted on invoice" table (all pages):
  1. click the edit (pencil) icon
  2. pick the Reason in the "Scheme Details" popup
  3. click Submit  -> the site then ticks the row's checkbox
Rows whose checkbox is already ticked are skipped.
Each Submit saves the reason on the server, and the site then reloads the table back to
page 1 - so after every row the script jumps back to the page it was working on.
It does NOT click 'Select claim for NDC' / 'Submit Claim for NDC' - do that yourself.

It works on your already-open portal tab. That Chrome window must be opened with
scripts\\open_castrol_chrome.bat (Chrome blocks scripts from controlling normal windows).
Log in there once; the login is remembered for next time.

Run (with the NDC Approval page open in that window):
    python scripts/castrol_ndc_autofill.py              # all rows, all pages
    python scripts/castrol_ndc_autofill.py --limit 3    # test on first 3 rows only

Logs: every step is printed with a timestamp and also written to
scripts/logs/autofill_<time>.log. When a step fails, a screenshot (.png) and the
page HTML (.html) are saved next to the log. If the script seems stuck, the last
"-> ..." line in the log is the step it is waiting on.
"""

import argparse
import logging
import re
import sys
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

from playwright.sync_api import Page, Locator, TimeoutError as PWTimeout, sync_playwright

REASON = "Dealer has an Outstanding amount"
# Chrome started by open_castrol_chrome.bat listens here.
CDP_URL = "http://localhost:9222"
# Max wait for any single click/lookup before it counts as stuck (ms).
STEP_TIMEOUT = 15_000
# The 'CN not adjusted on invoice' table and the URL it loads its rows from.
TABLE_ID = "tblB2CSchemeClaimsGrid"
DATA_URL = "GetSchemeValidatorPendingClaims"
PAGE_SIZE = 60  # largest option in the site's "Show N entries" dropdown

LOG_DIR = Path(__file__).resolve().parent / "logs"
RUN_ID = datetime.now().strftime("%Y%m%d_%H%M%S")
log = logging.getLogger("autofill")


# ---------------------------------------------------------------- logging helpers

def setup_logging() -> Path:
    LOG_DIR.mkdir(exist_ok=True)
    log_file = LOG_DIR / f"autofill_{RUN_ID}.log"
    fmt = logging.Formatter("%(asctime)s.%(msecs)03d %(levelname)-5s %(message)s", "%H:%M:%S")
    for handler in (logging.StreamHandler(sys.stdout), logging.FileHandler(log_file, encoding="utf-8")):
        handler.setFormatter(fmt)
        log.addHandler(handler)
    log.setLevel(logging.DEBUG)
    return log_file


@contextmanager
def step(name: str):
    """Log the start, end and duration of a step, so a hang shows exactly where it is."""
    log.debug(f"-> {name}")
    t0 = time.perf_counter()
    try:
        yield
    except Exception as e:
        log.error(f"XX {name} FAILED after {time.perf_counter() - t0:.1f}s: "
                  f"{e.__class__.__name__}: {first_line(e)}")
        raise
    log.debug(f"ok {name} ({time.perf_counter() - t0:.1f}s)")


def first_line(e: Exception) -> str:
    return (str(e).strip().splitlines() or [""])[0]


def snippet(loc: Locator, n: int = 300) -> str:
    """Short outerHTML of an element, for the log."""
    try:
        html = loc.evaluate("el => el.outerHTML", timeout=2_000)
        html = re.sub(r"\s+", " ", html)
        return html[:n] + ("..." if len(html) > n else "")
    except Exception as e:
        return f"<could not read element: {first_line(e)}>"


def dump_state(page: Page, tag: str) -> None:
    """Save a screenshot and the page HTML for later inspection."""
    base = LOG_DIR / f"{RUN_ID}_{re.sub(r'[^A-Za-z0-9_-]+', '_', tag)[:60]}"
    try:
        page.screenshot(path=f"{base}.png", full_page=True, timeout=10_000)
        Path(f"{base}.html").write_text(page.content(), encoding="utf-8")
        log.warning(f"   saved screenshot + HTML: {base}.png / .html")
    except Exception as e:
        log.warning(f"   could not save page state: {first_line(e)}")


def describe_tables(page: Page) -> None:
    """When the table can't be found, log what tables ARE on the page."""
    info = page.evaluate("""() => [...document.querySelectorAll('table')].map((t, i) => ({
        i, id: t.id, cls: t.className, visible: !!t.offsetParent,
        headers: [...t.querySelectorAll('th')].map(th => th.textContent.trim()).filter(Boolean).slice(0, 12),
        rows: t.querySelectorAll('tbody tr').length }))""")
    log.info(f"   page has {len(info)} <table> elements:")
    for t in info:
        log.info(f"     #{t['i']} id='{t['id']}' visible={t['visible']} rows={t['rows']} headers={t['headers']}")


# ---------------------------------------------------------------- page actions

def find_table(page: Page) -> Locator:
    """The 'CN not adjusted on invoice' table."""
    table = page.locator(f"#{TABLE_ID}")
    with step(f"find 'CN not adjusted on invoice' table (#{TABLE_ID})"):
        try:
            table.wait_for(state="visible", timeout=STEP_TIMEOUT)
        except PWTimeout:
            describe_tables(page)
            raise
    return table


def table_info(page: Page) -> dict:
    """DataTables paging info: page (0-based), pages, length, recordsTotal."""
    return page.evaluate(f"() => $('#{TABLE_ID}').DataTable().page.info()")


def goto_page(page: Page, page_idx: int) -> dict:
    """
    Show page `page_idx` (0-based) with PAGE_SIZE rows. The site reloads the table and
    jumps back to page 1 / 15 rows after every Submit, so this is called before each row.
    """
    info = table_info(page)
    if info["page"] == page_idx and info["length"] == PAGE_SIZE:
        return info
    with step(f"go to page {page_idx + 1} ({PAGE_SIZE} rows/page)"):
        with page.expect_response(lambda r: DATA_URL in r.url, timeout=STEP_TIMEOUT * 2):
            page.evaluate(
                f"([len, p]) => $('#{TABLE_ID}').DataTable().page.len(len).page(p).draw('page')",
                [PAGE_SIZE, page_idx],
            )
        page.wait_for_function(
            f"([len, p]) => {{ const i = $('#{TABLE_ID}').DataTable().page.info();"
            f" return i.page === p && i.length === len; }}",
            arg=[PAGE_SIZE, page_idx], timeout=STEP_TIMEOUT,
        )
        page.wait_for_timeout(300)  # let the rows render
        info = table_info(page)
        log.debug(f"   now on page {info['page'] + 1}/{info['pages']} ({info['recordsTotal']} entries)")
    return info


def edit_button(row: Locator) -> Locator:
    # Prefer the visible link/button wrapping the pencil icon, then the icon itself.
    icon = "[class*='pencil'], [class*='fa-edit'], [title*='edit' i]"
    btn = row.locator("a, button").filter(has=row.page.locator(icon)).locator("visible=true").first
    if btn.count() == 0:
        btn = row.locator(f"{icon}, [class*='edit']").locator("visible=true").first
    if btn.count():
        log.debug(f"   edit button: {snippet(btn, 200)}")
        return btn
    log.warning("   no pencil/edit element found by class - trying the cell before the delete icon")
    trash_cell = row.locator("td").filter(has=row.page.locator("[class*='trash'], [class*='delete']"))
    btn = trash_cell.locator("xpath=preceding-sibling::td[1]").locator("a, button, i, span").first
    log.debug(f"   fallback edit button: {snippet(btn, 200)}")
    log.debug(f"   row HTML: {snippet(row, 1500)}")
    return btn


def choose_reason(modal: Locator) -> None:
    select = modal.locator("select").first
    log.debug(f"   reason dropdown: {snippet(select, 200)}")
    opts = select.locator("option").all_inner_texts()
    log.debug(f"   reason options: {[o.strip() for o in opts]}")
    try:
        select.select_option(label=REASON, timeout=3_000)
        log.debug(f"   selected via select_option -> value={select.input_value()!r}")
        return
    except Exception as e:
        log.debug(f"   select_option didn't work ({first_line(e)}); trying JS fallback")
    # Fallback for hidden/styled selects (select2 etc.): set by text and fire change events.
    ok = select.evaluate(
        """(el, reason) => {
            const opt = [...el.options].find(o => o.text.trim().toLowerCase() === reason.toLowerCase())
                     || [...el.options].find(o => o.text.toLowerCase().includes(reason.toLowerCase()));
            if (!opt) return false;
            el.value = opt.value;
            el.dispatchEvent(new Event('change', {bubbles: true}));
            if (window.jQuery) window.jQuery(el).val(opt.value).trigger('change');
            return true;
        }""",
        REASON,
    )
    if not ok:
        raise RuntimeError(f"Reason option '{REASON}' not found in popup")
    log.debug(f"   selected via JS fallback -> value={select.input_value()!r}")


def dismiss_confirmations(page: Page, wait_ms: int = 3_000) -> bool:
    """
    Wait up to `wait_ms` for the site's green "Notification" popup
    ("Success! Updated Successfully.") and click its Close button.
    Also handles SweetAlert/bootbox style OK popups. Returns True if a popup was closed.
    """
    notification = page.locator(".modal").filter(
        has=page.locator(".modal-header, .modal-title", has_text=re.compile(r"Notification", re.I))
    ).locator("visible=true")
    others = [(".swal2-popup", ".swal2-confirm"), (".sweet-alert", "button.confirm"),
              (".bootbox", ".btn-primary")]

    deadline = time.perf_counter() + wait_ms / 1000
    while time.perf_counter() < deadline:
        if notification.count():
            box = notification.first
            text = " ".join(box.locator(".modal-body").first.inner_text().split()) \
                if box.locator(".modal-body").count() else ""
            log.info(f"   notification: {text[:200]!r} -> clicking Close")
            if "success" not in text.lower():
                log.warning(f"   notification does not say Success: {text[:200]!r}")
            close = box.get_by_role("button", name=re.compile(r"^\s*close\s*$", re.I)).locator("visible=true")
            if close.count() == 0:
                close = box.locator(".modal-footer .btn, .close, [data-dismiss='modal'], "
                                    "[data-bs-dismiss='modal']").locator("visible=true")
            log.debug(f"   close button: {snippet(close.first, 200)}")
            close.first.click(timeout=5_000)
            try:
                box.wait_for(state="hidden", timeout=5_000)
            except PWTimeout:
                log.warning("   notification didn't close after clicking Close")
            page.wait_for_timeout(300)
            return True
        for popup_sel, ok_sel in others:
            btn = page.locator(f"{popup_sel} {ok_sel}").locator("visible=true")
            if btn.count():
                text = page.locator(popup_sel).first.inner_text(timeout=2_000)
                log.info(f"   popup ({popup_sel}): {' '.join(text.split())[:200]!r} -> clicking OK")
                btn.first.click()
                page.wait_for_timeout(300)
                return True
        page.wait_for_timeout(200)
    log.debug(f"   no notification popup appeared within {wait_ms / 1000:.0f}s")
    return False


def close_leftover_popups(page: Page) -> None:
    """A popup left open by a previous row blocks every click - close it first."""
    open_modals = page.locator(".modal.show, .modal.in").locator("visible=true")
    if open_modals.count() == 0:
        return
    log.warning(f"   {open_modals.count()} popup(s) still open from before - closing")
    for i in range(open_modals.count()):
        log.debug(f"     open popup {i}: {snippet(open_modals.nth(i), 300)}")
    close = open_modals.locator(".close, [data-dismiss='modal'], [data-bs-dismiss='modal']").locator("visible=true")
    if close.count():
        close.first.click(timeout=5_000)
    else:
        page.keyboard.press("Escape")
    try:
        open_modals.first.wait_for(state="hidden", timeout=5_000)
    except PWTimeout:
        log.warning("   popup would not close")
    page.wait_for_timeout(300)


def click_submit(modal: Locator) -> None:
    """Click the green Submit button in the popup (it may be a <button>, <a> or <input>)."""
    candidates = [
        modal.get_by_role("button", name=re.compile(r"submit", re.I)),
        modal.locator("button, a, input[type=submit], input[type=button]").filter(
            has_text=re.compile(r"submit", re.I)),
        modal.locator("input[type=submit], input[value*='Submit' i]"),
        modal.locator(".modal-footer .btn-success, .modal-footer .btn-primary"),
    ]
    for i, cand in enumerate(candidates, 1):
        btn = cand.locator("visible=true").first
        if btn.count() == 0:
            log.debug(f"   submit lookup #{i}: nothing")
            continue
        log.debug(f"   submit lookup #{i} found: {snippet(btn, 250)}")
        btn.scroll_into_view_if_needed()
        try:
            btn.click(timeout=5_000)
        except PWTimeout:
            log.warning("   normal click on Submit timed out (covered by something?) - forcing a JS click")
            btn.evaluate("el => el.click()")
        return
    buttons = modal.locator("button, a, input")
    log.error(f"   no Submit button found. Clickable things in popup: "
              f"{[snippet(buttons.nth(i), 150) for i in range(min(buttons.count(), 15))]}")
    raise RuntimeError("Submit button not found in popup")


def process_row(page: Page, row: Locator) -> None:
    close_leftover_popups(page)
    with step("click edit (pencil)"):
        btn = edit_button(row)
        btn.scroll_into_view_if_needed()
        try:
            btn.click(timeout=5_000)
        except PWTimeout as e:
            log.warning(f"   normal click on pencil timed out ({first_line(e)}) - forcing a JS click")
            btn.evaluate("el => el.click()")

    modal = page.locator(".modal").filter(has_text="Scheme Details").filter(
        has=page.locator("select")
    ).first
    with step("wait for 'Scheme Details' popup"):
        try:
            modal.wait_for(state="visible", timeout=10_000)
        except PWTimeout:
            visible = page.locator(".modal:visible")
            log.warning(f"   visible modals on page: {visible.count()}")
            for i in range(visible.count()):
                log.warning(f"     modal {i}: {snippet(visible.nth(i), 400)}")
            raise

    with step(f"choose reason '{REASON}'"):
        choose_reason(modal)

    with step("click Submit in popup (site saves the reason, then reloads the table)"):
        # The site reloads the table right after saving; wait for that reload so the
        # next step doesn't race it.
        try:
            with page.expect_response(lambda r: DATA_URL in r.url, timeout=STEP_TIMEOUT * 2):
                click_submit(modal)
        except PWTimeout:
            log.warning("   table did not reload after Submit - the save may have failed")

    with step("close 'Success! Updated Successfully' notification"):
        if not dismiss_confirmations(page, wait_ms=10_000):
            log.warning("   expected a 'Notification' popup after Submit but none appeared")

    with step("wait for popup to close"):
        try:
            modal.wait_for(state="hidden", timeout=10_000)
        except PWTimeout:
            log.warning("   popup still open after Submit - closing it manually")
            log.debug(f"   popup content: {modal.inner_text()[:500]!r}")
            close = modal.locator(".close, [data-dismiss='modal'], [data-bs-dismiss='modal']").first
            if close.count():
                close.click()
            modal.wait_for(state="hidden", timeout=5_000)


def read_rows(table: Locator) -> list:
    """Checkbox id, ticked state and cell texts for every row on the current page (one JS call)."""
    return table.evaluate("""t => [...t.querySelectorAll('tbody tr')].map(tr => {
        const c = tr.querySelector('input[type=checkbox]');
        return c ? {id: c.value, checked: c.checked, cells: [...tr.cells].map(td => td.innerText.trim())} : null;
    })""")


# ---------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="stop after N rows (for testing)")
    args = ap.parse_args()

    log_file = setup_logging()
    log.info(f"Log file: {log_file}")
    log.info(f"Options: limit={args.limit or 'none'}")

    with sync_playwright() as p:
        with step(f"connect to Chrome at {CDP_URL}"):
            try:
                browser = p.chromium.connect_over_cdp(CDP_URL, timeout=STEP_TIMEOUT)
            except Exception:
                log.error("Could not reach Chrome. Open the portal with scripts\\open_castrol_chrome.bat "
                          "(a normal Chrome window can't be controlled by scripts), then run this again.")
                sys.exit(1)

        pages = [pg for ctx in browser.contexts for pg in ctx.pages]
        log.debug(f"   open tabs: {[pg.url for pg in pages]}")
        page = next((pg for pg in pages if "NDCApproval" in pg.url), None) or \
               next((pg for pg in pages if "castroldigiclaim" in pg.url), None)
        if page is None:
            log.error("No DigiClaim tab found in that Chrome window - open the NDC Approval page there.")
            sys.exit(1)
        page.bring_to_front()
        page.set_default_timeout(STEP_TIMEOUT)

        def on_dialog(d):
            log.info(f"   browser {d.type} dialog: {d.message!r} -> accepting")
            d.accept()
        page.on("dialog", on_dialog)
        page.on("pageerror", lambda e: log.debug(f"   [page JS error] {first_line(e)}"))
        page.on("console", lambda m: m.type == "error" and log.debug(f"   [page console error] {m.text[:200]}"))
        page.on("requestfailed", lambda r: log.debug(f"   [request failed] {r.method} {r.url[:150]} {r.failure}"))
        log.info(f"Using open tab: {page.url}")

        # Rows are tracked by their checkbox id (e.g. '1148003_B2CFOC').
        attempted = {}     # id -> label: submitted by this run
        confirmed = set()  # submitted and now shown ticked
        failed = set()     # errored, or submitted but still not ticked - not retried
        already = set()    # were ticked before this run
        page_idx = 0
        logged_page = -1
        try:
            while True:
                table = find_table(page)
                info = goto_page(page, page_idx)
                rows = read_rows(table)
                if page_idx != logged_page:
                    log.info(f"--- Page {page_idx + 1}/{info['pages']} "
                             f"({len(rows)} rows, {info['recordsTotal']} entries in total) ---")
                    logged_page = page_idx

                target = None
                for i, r in enumerate(rows):
                    if r is None:  # "No data available" row
                        continue
                    cid, label = r["id"], " | ".join(r["cells"][2:4])  # dealer | parent id
                    if r["checked"]:
                        if cid in attempted and cid not in confirmed:
                            confirmed.add(cid)
                            log.info(f"  OK      {label} - now ticked")
                        elif cid not in attempted and cid not in already:
                            already.add(cid)
                            log.debug(f"   skip {label} (already ticked)")
                        continue
                    if cid in failed:
                        continue
                    if cid in attempted:
                        failed.add(cid)
                        log.warning(f"  NOT TICKED {label} - submitted but still unticked, skipping it")
                        continue
                    target = (i, cid, label, r["cells"])
                    break

                if target is None:
                    if page_idx + 1 >= info["pages"]:
                        log.info("No unticked rows left on the last page - done")
                        break
                    page_idx += 1
                    continue

                if args.limit and len(attempted) >= args.limit:
                    log.info(f"Reached --limit {args.limit}")
                    break

                i, cid, label, cells = target
                attempted[cid] = label
                log.info(f"  ROW {i + 1} on page {page_idx + 1}: {label}  cells={cells[1:]}")
                t0 = time.perf_counter()
                try:
                    process_row(page, table.locator("tbody tr").nth(i))
                    log.debug(f"   submitted in {time.perf_counter() - t0:.1f}s - "
                              f"will confirm the tick after returning to page {page_idx + 1}")
                except Exception as e:
                    failed.add(cid)
                    log.error(f"  FAILED  {label}: {e.__class__.__name__}: {first_line(e)}")
                    log.debug("   traceback:", exc_info=True)
                    dump_state(page, f"failed_{label}")
                    page.keyboard.press("Escape")
                    page.wait_for_timeout(500)
        except KeyboardInterrupt:
            log.warning("Stopped by user (Ctrl+C)")
        except Exception as e:
            log.exception(f"Stopped on unexpected error: {e.__class__.__name__}: {first_line(e)}")
            dump_state(page, "fatal")

        unconfirmed = set(attempted) - confirmed - failed
        log.info(f"Finished. Ticked now: {len(confirmed)}, were already ticked: {len(already)}, "
                 f"failed: {len(failed)}, submitted but not re-checked: {len(unconfirmed)}")
        for cid in failed:
            log.info(f"   failed: {attempted.get(cid, cid)}")
        log.info("Next step is yours: review, then 'Select claim for NDC' / 'Submit Claim for NDC'.")
        log.info(f"Full log: {log_file}")
        # Leave the Chrome window open - only the script disconnects.


if __name__ == "__main__":
    sys.exit(main())
