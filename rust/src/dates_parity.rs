// The web app's date tests (web/test/dates.test.js), ported. The web's
// dayBounds returns { error }; natively `Dates::bounds` returns Err, and the
// caller (Hours) shows it, so "reported, not thrown" is the Err itself.

use crate::dates::Dates;

fn manila() -> Dates {
    Dates::new("Asia/Manila").unwrap()
}
fn ok(start: &str, end: &str) -> (Option<String>, Option<String>) {
    manila().bounds(start, end).unwrap()
}
fn err(start: &str, end: &str) -> String {
    manila().bounds(start, end).unwrap_err().to_string()
}

#[test]
fn a_single_day_spans_that_day_0000_to_the_next_0000_manila_time() {
    assert_eq!(
        ok("2026-01-05", "2026-01-05"),
        (Some("2026-01-04T16:00:00.000Z".into()), Some("2026-01-05T16:00:00.000Z".into()))
    );
}

#[test]
fn the_to_date_is_included_not_cut_off_at_its_midnight() {
    assert_eq!(
        ok("2026-01-05", "2026-01-07"),
        (Some("2026-01-04T16:00:00.000Z".into()), Some("2026-01-07T16:00:00.000Z".into()))
    );
}

#[test]
fn the_end_bound_rolls_over_a_month_boundary() {
    assert_eq!(ok("", "2026-01-31").1.unwrap(), "2026-01-31T16:00:00.000Z");
}

#[test]
fn the_end_bound_rolls_over_a_year_boundary() {
    assert_eq!(ok("", "2026-12-31").1.unwrap(), "2026-12-31T16:00:00.000Z");
}

#[test]
fn a_leap_day_is_a_real_date() {
    assert_eq!(ok("2028-02-29", "").0.unwrap(), "2028-02-28T16:00:00.000Z");
}

#[test]
fn blank_boxes_mean_an_unfiltered_report_not_an_error() {
    assert_eq!(ok("", ""), (None, None));
}

#[test]
fn one_blank_box_leaves_that_bound_open() {
    let from = ok("2026-01-05", "");
    assert!(from.0.is_some() && from.1.is_none());
    let to = ok("", "2026-01-05");
    assert!(to.0.is_none() && to.1.is_some());
}

#[test]
fn text_that_is_not_a_date_is_reported_not_thrown() {
    for bad in ["garbage", "05/01/2026", "2026-1-5", "2026-01-05T10:00", "20260105", "-1"] {
        assert!(err(bad, "").to_lowercase().contains("date"), "expected {bad} to be rejected");
    }
}

#[test]
fn a_date_that_does_not_exist_is_rejected_rather_than_rolled_over() {
    for bad in ["2026-02-30", "2026-01-32", "2027-02-29", "2026-13-01", "2026-00-10"] {
        assert!(manila().bounds(bad, "").is_err(), "{bad}");
    }
}

#[test]
fn a_backwards_range_is_reported_instead_of_silently_returning_nothing() {
    assert!(err("2026-05-02", "2026-05-01").contains("after the To date"));
}

#[test]
fn from_and_to_on_the_same_day_is_a_valid_one_day_range() {
    assert!(manila().bounds("2026-05-01", "2026-05-01").is_ok());
}

// Web: "a rejected range still returns null bounds, never an Invalid Date".
// Natively a rejected range is an Err, with no bounds to misuse.
#[test]
fn a_rejected_range_gives_no_bounds_at_all() {
    assert!(manila().bounds("nope", "also-nope").is_err());
}

/// The range follows the configured zone, not the host's clock.
#[test]
fn bounds_come_from_the_configured_zone_not_the_host_default() {
    let utc = Dates::new("UTC").unwrap();
    assert_eq!(utc.bounds("2026-01-05", "2026-01-05").unwrap().0.unwrap(), "2026-01-05T00:00:00.000Z");
}

// Web: "the days of a month are the local month's first and last" (for the
// Hours month shortcuts). Natively the shortcut sets the dates from the
// month's bounds, so those are what is checked.
#[test]
fn a_months_bounds_are_its_first_local_midnight_and_the_next_months() {
    let d = manila();
    assert_eq!(d.month_bounds(2026, 10).unwrap(), ("2026-09-30T16:00:00.000Z".into(), "2026-10-31T16:00:00.000Z".into()));
    assert_eq!(d.month_bounds(2026, 2).unwrap().1, "2026-02-28T16:00:00.000Z");
    assert_eq!(d.month_bounds(2028, 2).unwrap().1, "2028-02-29T16:00:00.000Z");
}

#[test]
fn months_between_two_instants_in_either_order_across_a_year_end() {
    let d = manila();
    let months = vec![(2026, 11), (2026, 12), (2027, 1)];
    assert_eq!(d.months("2026-11-10T04:00:00.000Z", "2027-01-10T04:00:00.000Z").unwrap(), months);
    assert_eq!(d.months("2027-01-10T04:00:00.000Z", "2026-11-10T04:00:00.000Z").unwrap(), months);
    assert_eq!(d.months("2026-11-10T04:00:00.000Z", "2026-11-20T04:00:00.000Z").unwrap(), [(2026, 11)]);
}

#[test]
fn only_the_syncs_own_tabs_match_the_month_tab_pattern() {
    assert!(Dates::month_of_title("October 2026").is_some());
    assert!(Dates::month_of_title("October 2026 Logs").is_some());
    assert!(Dates::month_of_title("Totals").is_none());
    assert!(Dates::month_of_title("October 2026 notes").is_none());
}

#[test]
fn a_date_and_time_read_off_the_sheet_is_the_instant_the_local_clock_showed_it() {
    let d = manila();
    assert_eq!(d.instant("2026-10-01", "18:30:44").unwrap(), "2026-10-01T10:30:44.000Z");
    assert_eq!(d.instant("2026-10-01", "0:30").unwrap(), "2026-09-30T16:30:00.000Z");
    assert_eq!(d.stamp(&d.instant("2026-10-01", "18:30:44").unwrap()).unwrap(), "2026-10-01 18:30:44");
    for (date, time) in [("2026-02-30", "09:00:00"), ("10/1/2026", "09:00:00"), ("2026-10-01", "25:00"), ("2026-10-01", "")] {
        assert!(d.instant(date, time).is_err(), "{date} {time}");
    }
}
