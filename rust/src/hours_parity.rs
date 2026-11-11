// The web app's hours and report tests (web/test/hours.test.js and
// report.test.js), ported. Sessions come from `model::sessions`; the range
// filter and rounding the web keeps in hours.js are in `Store::report`.

use crate::{
    model::{hours_csv, leaderboards, sessions, Event, Person, ReportRow, Session, SECTIONS},
    store::Store,
};
use chrono::{TimeZone, Utc};

const HOUR: i64 = 3_600_000;
const DAY: i64 = 24 * HOUR;
const MAX: i64 = 10 * HOUR;
const BOOT: &str = "boot";

fn at(ms: i64) -> String {
    // 2026-01-05 09:00 Manila
    let base = Utc.with_ymd_and_hms(2026, 1, 5, 1, 0, 0).unwrap().timestamp_millis();
    crate::dates::iso(Utc.timestamp_millis_opt(base + ms).unwrap())
}
fn ev(kind: &str, ms: i64) -> Event {
    Event { id: 0, user_id: 1, kind: kind.into(), ts: at(ms), boot_id: Some(BOOT.into()), request_id: None }
}
fn build(events: &[Event]) -> Vec<Session> {
    sessions(events, BOOT, MAX)
}
fn total(s: &[Session]) -> i64 {
    s.iter().map(|s| s.ms).sum()
}
fn hours(ms: i64) -> f64 {
    (ms as f64 / HOUR as f64 * 100.0).round() / 100.0
}

#[test]
fn pairs_each_check_in_with_the_following_check_out() {
    let s = build(&[ev("in", 0), ev("out", 2 * HOUR)]);
    assert_eq!(s.len(), 1);
    assert_eq!(s[0].ms, 2 * HOUR);
    assert!(!s[0].open && !s[0].invalid);
}

#[test]
fn totals_several_sessions_across_a_day() {
    let s = build(&[ev("in", 0), ev("out", 3 * HOUR), ev("in", 5 * HOUR), ev("out", 13 * HOUR / 2)]);
    assert_eq!(s.len(), 2);
    assert_eq!(hours(total(&s)), 4.5);
}

#[test]
fn an_open_session_counts_as_zero_until_they_tap_out() {
    let s = build(&[ev("in", 0), ev("out", HOUR), ev("in", 4 * HOUR)]);
    let open: Vec<_> = s.iter().filter(|s| s.open).collect();
    assert_eq!(open.len(), 1);
    assert_eq!(open[0].out_at, None);
    assert_eq!(total(&s), HOUR);
}

/// Forgetting to tap out costs you the session. It must not be worth the
/// limit either: that would reward the mistake.
#[test]
fn a_session_past_the_limit_is_discarded_not_capped() {
    let s = build(&[ev("in", 0), ev("out", 3 * DAY)]);
    assert!(s[0].invalid);
    assert_eq!(s[0].ms, 0);
    assert_eq!(total(&s), 0);
}

#[test]
fn a_session_exactly_at_the_limit_still_counts_in_full() {
    let s = build(&[ev("in", 0), ev("out", 10 * HOUR)]);
    assert!(!s[0].invalid);
    assert_eq!(hours(s[0].ms), 10.0);
}

#[test]
fn a_session_just_past_the_limit_is_worth_nothing() {
    let s = build(&[ev("in", 0), ev("out", 10 * HOUR + 1)]);
    assert!(s[0].invalid);
    assert_eq!(s[0].ms, 0);
}

#[test]
fn one_discarded_session_does_not_affect_the_others() {
    let s = build(&[
        ev("in", 0), ev("out", 2 * HOUR),
        ev("in", DAY), ev("out", DAY + 3 * DAY),
        ev("in", 8 * DAY), ev("out", 8 * DAY + HOUR),
    ]);
    assert_eq!(hours(total(&s)), 3.0);
    assert_eq!(s.iter().filter(|s| s.invalid).count(), 1);
}

/// The shape a forgotten check-out leaves behind: two check-ins in a row.
#[test]
fn an_abandoned_check_in_is_flagged_and_worth_nothing() {
    let s = build(&[ev("in", 0), ev("in", 2 * HOUR), ev("out", 3 * HOUR)]);
    assert_eq!(s.len(), 2);
    assert_eq!((s[0].open, s[0].invalid, s[0].ms), (true, true, 0));
    assert_eq!(s[1].ms, HOUR);
    assert_eq!(hours(total(&s)), 1.0);
}

/// "Still in" is open && !invalid, so the two open sessions must differ, or
/// someone who went home last week shows as present forever.
#[test]
fn the_live_check_in_is_open_but_not_flagged_unlike_an_abandoned_one() {
    let s = build(&[ev("in", 0), ev("in", 2 * DAY)]);
    assert_eq!(s.iter().map(|s| (s.open, s.invalid)).collect::<Vec<_>>(), [(true, true), (true, false)]);
}

#[test]
fn a_check_out_with_no_matching_check_in_is_ignored() {
    let s = build(&[ev("out", 0), ev("in", HOUR), ev("out", 2 * HOUR)]);
    assert_eq!(s.len(), 1);
    assert_eq!(s[0].ms, HOUR);
}

#[test]
fn no_events_means_no_sessions() {
    assert!(build(&[]).is_empty());
    assert_eq!(total(&[]), 0);
}

/// A backward clock jump on a Pi with no RTC can date a check-out before its
/// check-in. Zero, never subtracted from the person's total.
#[test]
fn a_negative_span_from_a_clock_jump_counts_as_zero_never_negative() {
    let s = build(&[ev("in", 2 * HOUR), ev("out", 0)]);
    assert_eq!(s[0].ms, 0);
}

// The range filter, as Store::report applies it.
fn report(events: &[(&str, i64)], start: Option<String>, end: Option<String>) -> ReportRow {
    let store = Store::memory().unwrap();
    let id = store
        .create(&Person { name: "Ana".into(), student_id: "1".into(), section: "Web".into(), status: "Regular".into(), telegram: String::new() }, "1", true)
        .unwrap();
    for (kind, ms) in events {
        store.add_event(id, kind, &at(*ms), Some(BOOT), None).unwrap();
    }
    store.report(BOOT, MAX, start.as_deref(), end.as_deref()).unwrap().remove(0)
}

#[test]
fn the_range_keeps_sessions_by_check_in_start_inclusive_and_end_exclusive() {
    let days = [("in", 0), ("out", HOUR), ("in", DAY), ("out", DAY + HOUR), ("in", 2 * DAY), ("out", 2 * DAY + HOUR)];
    let r = report(&days, Some(at(DAY)), Some(at(2 * DAY)));
    assert_eq!(r.sessions, 1);
    assert_eq!(r.hours, 1.0);
}

#[test]
fn the_range_treats_a_missing_bound_as_open_ended() {
    let days = [("in", 0), ("out", HOUR), ("in", DAY), ("out", DAY + HOUR)];
    assert_eq!(report(&days, None, None).sessions, 2);
    assert_eq!(report(&days, Some(at(DAY)), None).sessions, 1);
    assert_eq!(report(&days, None, Some(at(DAY))).sessions, 1);
}

#[test]
fn hours_are_rounded_to_two_decimals_for_the_report() {
    assert_eq!(report(&[("in", 0), ("out", HOUR)], None, None).hours, 1.0);
    assert_eq!(report(&[("in", 0), ("out", 90 * 60_000)], None, None).hours, 1.5);
    assert_eq!(report(&[("in", 0), ("out", HOUR / 3)], None, None).hours, 0.33);
}

/// Web: "the limit the scanner uses is the same one the totals use". Natively
/// both take Config::max_session_ms; the default is 12 hours, as on the Pi.
#[test]
fn the_default_session_limit_is_the_pis() {
    assert!(include_str!("config.rs").contains("get(\"MAX_SESSION_HOURS\", \"12\")"));
}

// ---- The report: CSV and leaderboards (web/test/report.test.js) ----------

fn row(name: &str, f: impl FnOnce(&mut ReportRow)) -> ReportRow {
    let mut r = ReportRow {
        user_id: 0,
        name: name.into(),
        student_id: "111".into(),
        section: String::new(),
        status: "Regular".into(),
        active: true,
        hours: 1.5,
        sessions: 2,
        open: false,
        any: true,
        uncounted: vec![],
    };
    f(&mut r);
    r
}
const HEAD: &str = "Name,Student ID,Hours,Sessions,Still in,Uncounted sessions,Deactivated";
fn cells(r: ReportRow) -> String {
    hours_csv(&[r]).lines().skip(1).collect::<Vec<_>>().join("\n")
}
fn line(r: ReportRow) -> String {
    hours_csv(&[r])[HEAD.len() + 1..].trim_end_matches('\n').to_string()
}

#[test]
fn the_csv_has_a_header_and_a_line_per_person() {
    let ben = row("Ben Dy", |r| {
        r.open = true;
        r.uncounted = vec![Session { in_at: String::new(), out_at: None, ms: 0, open: true, invalid: true }];
        r.active = false;
    });
    let csv = hours_csv(&[row("Ana Cruz", |_| {}), ben]);
    assert_eq!(csv.trim_end(), [HEAD, "Ana Cruz,111,1.50,2,,,", "Ben Dy,111,1.50,2,yes,1,yes"].join("\n"));
}

#[test]
fn commas_quotes_and_line_breaks_are_quoted() {
    assert_eq!(cells(row("Cruz, Ana \"AC\"", |_| {})), "\"Cruz, Ana \"\"AC\"\"\",111,1.50,2,,,");
    assert_eq!(line(row("Ana\r\nCruz", |_| {})), "\"Ana\r\nCruz\",111,1.50,2,,,");
}

/// The name and ID number are whatever was typed at registration.
#[test]
fn a_name_or_id_number_a_spreadsheet_would_run_as_a_formula_is_made_text() {
    assert_eq!(cells(row("=1+1", |r| r.student_id = "AUDITCSV".into())), "'=1+1,AUDITCSV,1.50,2,,,");
    for start in ["=", "+", "-", "@", "\t"] {
        assert!(cells(row(&format!("{start}cmd"), |_| {})).starts_with(&format!("'{start}cmd,")), "{start:?}");
        assert!(cells(row("Ana Cruz", |r| r.student_id = format!("{start}1"))).starts_with(&format!("Ana Cruz,'{start}1,")), "{start:?}");
    }
    assert_eq!(line(row("\r=1+1", |_| {})), "\"'\r=1+1\",111,1.50,2,,,");
    assert_eq!(cells(row("=HYPERLINK(\"http://x\",\"y\")", |_| {})), "\"'=HYPERLINK(\"\"http://x\"\",\"\"y\"\")\",111,1.50,2,,,");
}

#[test]
fn an_ordinary_name_is_left_alone() {
    assert_eq!(cells(row("Mary-Ann = O'Brien", |_| {})), "Mary-Ann = O'Brien,111,1.50,2,,,");
}

#[test]
fn sections_are_ranked_by_their_staffers_hours_and_every_section_is_listed() {
    let b = leaderboards(
        &[
            row("a", |r| { r.section = "Web".into(); r.hours = 1.25 }),
            row("b", |r| { r.section = "Web".into(); r.hours = 2.5 }),
            row("c", |r| { r.section = "Photo".into(); r.hours = 3.0 }),
            row("d", |r| { r.section = "Photo".into(); r.hours = 2.0; r.active = false }),
            row("e", |r| { r.section = String::new(); r.hours = 9.0 }),
        ],
        "January 2026".into(),
        false,
    );
    assert_eq!(b.sections[..2].iter().map(|s| (s.section.as_str(), s.hours)).collect::<Vec<_>>(), [("Photo", 5.0), ("Web", 3.75)]);
    assert_eq!(b.sections.len(), SECTIONS.len());
    assert!(b.sections[2..].iter().all(|s| s.hours == 0.0));
}

#[test]
fn the_top_ten_staffers_are_active_people_with_hours_most_first() {
    let mut people: Vec<_> = (0..12).map(|i| row(&format!("P{i:02}"), |r| { r.section = "Web".into(); r.hours = i as f64 })).collect();
    people.push(row("Gone", |r| { r.hours = 99.0; r.active = false }));
    let b = leaderboards(&people, String::new(), false);
    assert_eq!(b.staffers.len(), 10);
    assert_eq!((b.staffers[0].name.as_str(), b.staffers[0].section.as_str(), b.staffers[0].hours), ("P11", "Web", 11.0));
    assert!(!b.staffers.iter().any(|p| p.name == "Gone" || p.hours == 0.0));
}

#[test]
fn dummy_staffers_are_left_out_of_the_report_so_out_of_every_total() {
    let store = Store::memory().unwrap();
    for (name, status, card) in [("Ana Cruz", "Regular", "1"), ("Bobet", "Dummy", "2")] {
        store
            .create(&Person { name: name.into(), student_id: card.into(), section: "Web".into(), status: status.into(), telegram: String::new() }, card, true)
            .unwrap();
    }
    let names: Vec<_> = store.report(BOOT, MAX, None, None).unwrap().into_iter().map(|r| r.name).collect();
    assert_eq!(names, ["Ana Cruz"]);
}

#[test]
fn eb_and_eal_staffers_count_for_their_section_but_are_left_out_of_the_top_ten() {
    let b = leaderboards(
        &[
            row("Eb", |r| { r.section = "Web".into(); r.status = "EB".into(); r.hours = 9.0 }),
            row("Eal", |r| { r.section = "Web".into(); r.status = "EAL".into(); r.hours = 8.0 }),
            row("Reg", |r| { r.section = "Web".into(); r.hours = 1.0 }),
        ],
        String::new(),
        false,
    );
    assert_eq!(b.staffers.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["Reg"]);
    assert_eq!((b.sections[0].section.as_str(), b.sections[0].hours), ("Web", 18.0));
}
