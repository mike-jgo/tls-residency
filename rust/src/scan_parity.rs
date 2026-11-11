// The web app's scanner tests (web/test/scan.test.js), ported one for one so
// the native scanner is held to the same rules. Test names match the web
// file's, in the same order and sections.
//
// Two differences in how the scanner is driven:
//   - The web page sends a request id with each tap. Natively the store keeps
//     a receipt per card until the screen has shown the result
//     (`acknowledge`). `tap` acknowledges, as the screen does; `tap_unseen`
//     doesn't, as when the result never reached the screen.
//   - The web result also says whether a stale check-in was measured with
//     certainty. The native Tap has no such field, so those assertions are
//     left out; the direction and staleness they guard are still checked.

use crate::{
    dates,
    model::{self, Person},
    scan::Scanner,
    store::Store,
};
use chrono::{TimeZone, Utc};

const SECOND: i64 = 1000;
const HOUR: i64 = 3_600_000;
// The same 10-hour limit the web tests pin.
const MAX_MS: i64 = 10 * HOUR;
// web/lib/scan.js REPEAT_IGNORE_MS and UNKNOWN_KEEP.
const REPEAT_IGNORE_MS: i64 = 5000;
const UNKNOWN_KEEP: usize = 20;
const BOOT: &str = "boot-monday";

/// Two clocks, because on a Pi with no RTC they disagree.
///   advance()    real time passes: both clocks move together.
///   jump_clock() NTP corrects the wall clock; no real time passes.
struct World {
    store: Store,
    scanner: Scanner,
    clock: i64,
    elapsed: i64,
    boot: String,
    ready: bool,
    cards: u32,
}

impl World {
    fn new() -> Self {
        Self::with_store(Store::memory().unwrap())
    }
    fn with_store(store: Store) -> Self {
        Self {
            store,
            scanner: Scanner::default(),
            // 2026-01-05 09:00 Manila
            clock: Utc.with_ymd_and_hms(2026, 1, 5, 1, 0, 0).unwrap().timestamp_millis(),
            elapsed: 0,
            boot: BOOT.into(),
            ready: true,
            cards: 0,
        }
    }
    fn now(&self) -> String {
        dates::iso(Utc.timestamp_millis_opt(self.clock).unwrap())
    }
    fn advance(&mut self, ms: i64) {
        self.clock += ms;
        self.elapsed += ms;
    }
    fn jump_clock(&mut self, ms: i64) {
        self.clock += ms;
    }
    /// A fresh scanner is what a restarted app has: no memory of any tap.
    fn restart(&mut self) {
        self.scanner = Scanner::default();
    }
    /// The machine was switched off and on again.
    fn reboot(&mut self, boot: &str) {
        self.restart();
        self.boot = boot.into();
    }
    fn register(&mut self, name: &str) -> String {
        self.cards += 1;
        let card = (1_000_000_000 + self.cards).to_string();
        self.store
            .create(
                &Person {
                    name: name.into(),
                    student_id: format!("S{}", self.cards),
                    ..Person::default()
                },
                &card,
                true,
            )
            .unwrap();
        card
    }
    fn id(&self, card: &str) -> i64 {
        self.store.by_card(card).unwrap().unwrap().id
    }
    fn types(&self, card: &str) -> Vec<String> {
        self.store
            .events_for(self.id(card))
            .unwrap()
            .into_iter()
            .map(|e| e.kind)
            .collect()
    }
    fn is_in(&self, boot: &str, card: &str) -> bool {
        let id = self.id(card);
        self.store.currently_in(boot).unwrap().iter().any(|(u, _)| u.id == id)
    }
    /// The tap whose result never reached the screen.
    fn tap_unseen(&mut self, card: &str) -> model::Tap {
        let now = self.now();
        self.scanner
            .tap(&self.store, card, &self.boot, self.ready, MAX_MS, &now, self.elapsed as u64)
            .unwrap()
    }
    /// A tap as the screen makes it: shown, then acknowledged.
    fn handle(&mut self, card: &str) -> model::Tap {
        let tap = self.tap_unseen(card);
        self.store.acknowledge(card, &tap.request_id).unwrap();
        tap
    }
    /// Taps are at least the repeat window apart unless a test says otherwise.
    fn tap(&mut self, card: &str) -> model::Tap {
        self.advance(REPEAT_IGNORE_MS);
        self.handle(card)
    }
    fn unknown(&self) -> Vec<String> {
        self.scanner.unknown.iter().map(|(c, _)| c.clone()).collect()
    }
}

// ---- Toggling ------------------------------------------------------------

#[test]
fn the_first_tap_checks_a_person_in() {
    let mut w = World::new();
    let card = w.register("Ana");
    let result = w.tap(&card);
    assert_eq!(result.status, "ok");
    assert_eq!(result.direction, "in");
    assert_eq!(result.name, "Ana");
    assert!(!result.stale);
}

#[test]
fn the_next_tap_checks_them_out() {
    let mut w = World::new();
    let card = w.register("Ben");
    w.tap(&card);
    assert_eq!(w.tap(&card).direction, "out");
}

#[test]
fn taps_keep_alternating() {
    let mut w = World::new();
    let card = w.register("Cara");
    let directions: Vec<_> = (0..6)
        .map(|_| {
            w.advance(HOUR);
            w.handle(&card).direction
        })
        .collect();
    assert_eq!(directions, ["in", "out", "in", "out", "in", "out"]);
}

#[test]
fn the_toggle_follows_the_database_so_a_restart_cannot_desync_it() {
    let mut w = World::new();
    let card = w.register("Dita");
    w.tap(&card);
    w.restart();
    w.advance(HOUR);
    assert_eq!(w.handle(&card).direction, "out");
}

#[test]
fn a_lost_reply_can_be_retried_beyond_the_repeat_window_and_across_a_restart_without_toggling() {
    let mut w = World::new();
    let card = w.register("Receipt test");
    w.advance(REPEAT_IGNORE_MS);
    let first = w.tap_unseen(&card);
    w.advance(2 * REPEAT_IGNORE_MS);
    w.restart();
    let retried = w.handle(&card);
    assert_eq!(retried.direction, "in");
    assert_eq!(retried.time, first.time);
    assert!(retried.replayed);
    assert_eq!(w.types(&card).len(), 1);
    w.advance(REPEAT_IGNORE_MS);
    assert_eq!(w.handle(&card).direction, "out");
}

// Web: "a tap receipt cannot be reused for another card". Natively the store
// issues each card its own receipt, so one can't be handed to another card;
// what's left to check is that two cards never share one.
#[test]
fn each_card_gets_its_own_tap_receipt() {
    let mut w = World::new();
    let card = w.register("Receipt owner");
    let other = w.register("Other receipt owner");
    w.advance(REPEAT_IGNORE_MS);
    let mine = w.tap_unseen(&card);
    let theirs = w.tap_unseen(&other);
    assert_ne!(mine.request_id, theirs.request_id);
    assert_eq!(w.types(&other), ["in"]);
}

#[test]
fn a_failed_database_write_does_not_swallow_an_immediate_retry() {
    let mut w = World::new();
    let card = w.register("Retry after disk failure");
    w.store.db.execute_batch("CREATE TRIGGER fail_tap BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;").unwrap();
    let now = w.now();
    assert!(w.scanner.tap(&w.store, &card, BOOT, true, MAX_MS, &now, 0).is_err());
    assert!(w.store.events().unwrap().is_empty());
    assert!(w.store.pending_cards().unwrap().is_empty(), "receipt creation rolls back too");
    w.store.db.execute_batch("DROP TRIGGER fail_tap").unwrap();
    assert_eq!(w.handle(&card).direction, "in", "no elapsed time or restart required");
    assert_eq!(w.types(&card), ["in"]);
}

#[test]
fn each_person_toggles_independently() {
    let mut w = World::new();
    let one = w.register("Eli");
    let two = w.register("Fay");
    w.tap(&one);
    w.tap(&two);
    assert_eq!(w.tap(&one).direction, "out");
    assert_eq!(w.tap(&two).direction, "out");
}

// ---- Repeat suppression --------------------------------------------------

#[test]
fn a_second_tap_of_the_same_card_within_the_window_is_ignored() {
    let mut w = World::new();
    let card = w.register("Gio");
    assert_eq!(w.tap(&card).direction, "in");
    w.advance(SECOND);
    let result = w.handle(&card);
    assert_eq!(result.status, "ignored");
    assert_eq!(result.rfid, card);
}

#[test]
fn an_ignored_tap_writes_nothing_and_leaves_them_checked_in() {
    let mut w = World::new();
    let card = w.register("Hana");
    w.tap(&card);
    let before = w.types(&card).len();
    w.advance(SECOND);
    w.handle(&card);
    w.advance(SECOND);
    w.handle(&card);
    assert_eq!(w.types(&card).len(), before);
    assert_eq!(w.store.last_event(w.id(&card)).unwrap().unwrap().kind, "in");
}

#[test]
fn a_tap_after_the_window_is_honoured() {
    let mut w = World::new();
    let card = w.register("Ivo");
    w.tap(&card);
    w.advance(REPEAT_IGNORE_MS);
    assert_eq!(w.handle(&card).direction, "out");
}

#[test]
fn the_window_runs_from_the_tap_that_was_acted_on_not_the_ignored_one() {
    let mut w = World::new();
    let card = w.register("Jun");
    w.tap(&card);
    w.advance(REPEAT_IGNORE_MS - 1);
    assert_eq!(w.handle(&card).status, "ignored");
    w.advance(2);
    assert_eq!(w.handle(&card).direction, "out");
}

#[test]
fn a_backwards_clock_jump_does_not_start_ignoring_taps() {
    let mut w = World::new();
    let card = w.register("Xandra");
    w.tap(&card);
    w.jump_clock(-8 * HOUR);
    w.advance(REPEAT_IGNORE_MS);
    assert_ne!(w.handle(&card).status, "ignored");
    assert_eq!(w.types(&card).len(), 2);
}

#[test]
fn a_forwards_clock_jump_does_not_stop_a_repeat_tap_being_suppressed() {
    let mut w = World::new();
    let card = w.register("Yara");
    w.tap(&card);
    w.advance(SECOND);
    w.jump_clock(4 * HOUR);
    assert_eq!(w.handle(&card).status, "ignored");
    assert_eq!(w.types(&card).len(), 1);
}

#[test]
fn the_window_is_per_card_so_two_people_tapping_together_both_register() {
    let mut w = World::new();
    let one = w.register("Kit");
    let two = w.register("Lia");
    w.advance(REPEAT_IGNORE_MS);
    assert_eq!(w.handle(&one).direction, "in");
    assert_eq!(w.handle(&two).direction, "in");
}

// ---- Stale check-ins -----------------------------------------------------

#[test]
fn an_arrival_after_a_forgotten_check_out_checks_them_in_not_out() {
    let mut w = World::new();
    let card = w.register("Mika");
    w.tap(&card);
    w.advance(20 * HOUR);
    let result = w.handle(&card);
    assert_eq!(result.direction, "in");
    assert!(result.stale);
}

#[test]
fn the_sequence_recovers_the_tap_after_a_stale_arrival_is_a_check_out() {
    let mut w = World::new();
    let card = w.register("Noel");
    w.tap(&card);
    w.advance(20 * HOUR);
    w.handle(&card);
    w.advance(3 * HOUR);
    let result = w.handle(&card);
    assert_eq!(result.direction, "out");
    assert!(!result.stale);
}

#[test]
fn a_genuine_long_day_still_taps_out_at_exactly_the_limit() {
    let mut w = World::new();
    let card = w.register("Ofel");
    w.tap(&card);
    w.advance(10 * HOUR);
    let result = w.handle(&card);
    assert_eq!(result.direction, "out");
    assert!(!result.stale);
}

#[test]
fn a_check_in_one_millisecond_past_the_limit_is_stale() {
    let mut w = World::new();
    let card = w.register("Pia");
    w.tap(&card);
    w.advance(10 * HOUR + 1);
    assert!(w.handle(&card).stale);
}

#[test]
fn staleness_applies_only_to_an_open_check_in_never_to_a_check_out() {
    let mut w = World::new();
    let card = w.register("Quin");
    w.tap(&card);
    w.tap(&card);
    w.advance(30 * HOUR);
    let result = w.handle(&card);
    assert_eq!(result.direction, "in");
    assert!(!result.stale);
}

#[test]
fn a_backwards_clock_does_not_make_a_check_in_look_stale() {
    let mut w = World::new();
    let card = w.register("Rex");
    w.tap(&card);
    w.jump_clock(-30 * HOUR);
    w.advance(HOUR);
    let result = w.handle(&card);
    assert_eq!(result.direction, "out");
    assert!(!result.stale);
}

/// The regression this section exists for: a check-in recorded before NTP
/// corrects the clock, and a tap after it, are hours apart on the wall clock
/// while barely any real time has passed.
#[test]
fn a_forwards_clock_correction_does_not_turn_a_departure_into_an_arrival() {
    let mut w = World::new();
    let card = w.register("Yuki");
    w.tap(&card);
    w.advance(HOUR);
    w.jump_clock(24 * HOUR);
    let result = w.handle(&card);
    assert_eq!(result.direction, "out", "a departure must stay a departure");
    assert!(!result.stale);
    assert_eq!(w.types(&card), ["in", "out"]);
    assert!(!w.is_in(BOOT, &card), "they went home");
}

#[test]
fn a_forwards_correction_does_not_delay_a_genuinely_stale_check_in_either() {
    let mut w = World::new();
    let card = w.register("Zane");
    w.tap(&card);
    w.advance(20 * HOUR);
    w.jump_clock(-3 * HOUR);
    assert!(w.handle(&card).stale);
}

#[test]
fn after_a_restart_the_age_comes_from_the_stored_timestamp() {
    let mut w = World::new();
    let card = w.register("Adel");
    w.tap(&card);
    w.restart();
    w.advance(20 * HOUR);
    let result = w.handle(&card);
    assert_eq!(result.direction, "in");
    assert!(result.stale);
}

#[test]
fn a_restart_does_not_by_itself_make_a_recent_check_in_look_stale() {
    let mut w = World::new();
    let card = w.register("Bex");
    w.tap(&card);
    w.restart();
    w.advance(2 * HOUR);
    assert_eq!(w.handle(&card).direction, "out");
}

/// End to end: before the stale rule, the second day's arrival was recorded
/// as a check-out, and every tap after it was inverted too.
#[test]
fn a_forgotten_check_out_costs_that_session_and_nothing_else() {
    let mut w = World::new();
    let card = w.register("Sam");
    w.tap(&card);
    w.advance(20 * HOUR);
    w.handle(&card);
    w.advance(4 * HOUR);
    w.handle(&card);
    let sessions = model::sessions(&w.store.events_for(w.id(&card)).unwrap(), BOOT, MAX_MS);
    assert_eq!(sessions.iter().map(|s| s.invalid).collect::<Vec<_>>(), [true, false]);
    assert_eq!(sessions.iter().map(|s| s.ms).sum::<i64>(), 4 * HOUR);
    assert_eq!(w.store.last_event(w.id(&card)).unwrap().unwrap().kind, "out");
}

// ---- The daily shutdown --------------------------------------------------

#[test]
fn a_check_in_from_before_the_shutdown_is_abandoned_whatever_the_clock_says() {
    let mut w = World::new();
    let card = w.register("Cyd");
    w.tap(&card);
    // Tuesday morning; the Pi boots believing it is still Monday evening.
    w.reboot("boot-tuesday");
    w.advance(REPEAT_IGNORE_MS);
    let result = w.handle(&card);
    assert_eq!(result.direction, "in", "an arrival must stay an arrival");
    assert!(result.stale);
    w.advance(3 * HOUR);
    assert_eq!(w.handle(&card).direction, "out", "and the day carries on normally");
}

#[test]
fn a_check_out_from_before_the_shutdown_is_not_an_abandoned_session() {
    let mut w = World::new();
    let card = w.register("Dov");
    w.tap(&card);
    w.tap(&card);
    w.reboot("boot-tuesday-2");
    w.advance(REPEAT_IGNORE_MS);
    let result = w.handle(&card);
    assert_eq!(result.direction, "in");
    assert!(!result.stale);
}

#[test]
fn an_old_check_in_with_no_boot_id_counts_as_from_an_earlier_boot() {
    let mut w = World::new();
    let card = w.register("Ely");
    let now = w.now();
    w.store.add_event(w.id(&card), "in", &now, None, None).unwrap();
    w.advance(REPEAT_IGNORE_MS);
    assert!(w.handle(&card).stale);
}

#[test]
fn someone_who_never_tapped_out_yesterday_is_not_shown_as_in_today() {
    let mut w = World::new();
    let card = w.register("Fio");
    w.tap(&card);
    assert!(w.is_in(BOOT, &card), "in on Monday");
    assert!(!w.is_in("boot-wednesday", &card), "not in after the machine was switched off and on again");
}

#[test]
fn the_report_flags_a_check_in_left_open_at_shutdown_and_counts_it_as_zero() {
    let mut w = World::new();
    let card = w.register("Gus");
    w.tap(&card);
    let events = w.store.events_for(w.id(&card)).unwrap();
    let monday = model::sessions(&events, BOOT, MAX_MS);
    assert_eq!(monday.iter().map(|s| (s.open, s.invalid)).collect::<Vec<_>>(), [(true, false)], "still in on Monday");
    let later = model::sessions(&events, "boot-thursday", MAX_MS);
    assert_eq!(later.iter().map(|s| (s.open, s.invalid)).collect::<Vec<_>>(), [(true, true)], "abandoned after shutdown");
    assert_eq!(later.iter().map(|s| s.ms).sum::<i64>(), 0);
}

// ---- The clock check -----------------------------------------------------

#[test]
fn a_tap_before_the_clock_is_set_records_nothing() {
    let mut w = World::new();
    w.ready = false;
    let card = w.register("Hal");
    w.advance(REPEAT_IGNORE_MS);
    let result = w.handle(&card);
    assert_eq!(result.status, "clock");
    assert_eq!(result.rfid, card);
    assert!(w.types(&card).is_empty());
}

#[test]
fn an_unknown_card_before_the_clock_is_set_is_refused_too_not_listed() {
    let mut w = World::new();
    w.ready = false;
    w.advance(REPEAT_IGNORE_MS);
    assert_eq!(w.handle("7777777001").status, "clock");
    assert!(w.unknown().is_empty());
}

/// They were told "wait a moment and tap again". That retry must count, not
/// be swallowed as a repeat of a tap that was never acted on.
#[test]
fn the_retry_once_the_clock_is_set_is_recorded_straight_away() {
    let mut w = World::new();
    w.ready = false;
    let card = w.register("Ines");
    w.advance(REPEAT_IGNORE_MS);
    w.handle(&card);
    w.ready = true;
    w.advance(SECOND);
    let result = w.handle(&card);
    assert_eq!(result.status, "ok");
    assert_eq!(result.direction, "in");
}

// ---- Unknown cards -------------------------------------------------------

#[test]
fn an_unknown_card_records_nothing_and_is_offered_for_registration() {
    let mut w = World::new();
    w.advance(REPEAT_IGNORE_MS);
    let result = w.handle("9999999001");
    assert_eq!(result.status, "unknown");
    assert_eq!(result.rfid, "9999999001");
    assert_eq!(w.unknown()[0], "9999999001");
    assert!(w.store.events().unwrap().is_empty());
}

#[test]
fn unknown_cards_are_listed_newest_first_without_duplicates() {
    let mut w = World::new();
    for card in ["9999999002", "9999999003", "9999999002"] {
        w.advance(REPEAT_IGNORE_MS);
        w.handle(card);
    }
    let listed = w.unknown();
    assert_eq!(listed[..2], ["9999999002", "9999999003"]);
    assert_eq!(listed.iter().filter(|c| *c == "9999999002").count(), 1);
}

#[test]
fn the_unknown_list_stays_bounded() {
    let mut w = World::new();
    for i in 0..UNKNOWN_KEEP + 5 {
        w.advance(REPEAT_IGNORE_MS);
        w.handle(&format!("888800{i:04}"));
    }
    assert_eq!(w.unknown().len(), UNKNOWN_KEEP);
}

#[test]
fn registering_a_card_drops_it_from_the_unknown_list() {
    let mut w = World::new();
    w.advance(REPEAT_IGNORE_MS);
    w.handle("9999999004");
    assert!(w.unknown().iter().any(|c| c == "9999999004"));
    w.scanner.forget_unknown("9999999004");
    assert!(!w.unknown().iter().any(|c| c == "9999999004"));
}

// ---- Database persistence ------------------------------------------------

struct TempDb(std::path::PathBuf);
impl TempDb {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("tls-scan-parity-{}-{name}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
    fn file(&self) -> std::path::PathBuf {
        self.0.join("residency.db")
    }
}
impl Drop for TempDb {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A second connection opening the same file shares no memory with the first,
/// so anything it sees was genuinely committed.
#[test]
fn events_are_written_to_the_file_not_just_held_in_memory() {
    let tmp = TempDb::new("persist");
    let card;
    {
        let mut w = World::with_store(Store::open(tmp.file()).unwrap());
        card = w.register("Tala");
        w.tap(&card);
        w.tap(&card);
    }
    let reopened = Store::open(tmp.file()).unwrap();
    let user = reopened.by_card(&card).unwrap().unwrap();
    assert_eq!(user.person.name, "Tala");
    let types: Vec<_> = reopened.events_for(user.id).unwrap().into_iter().map(|e| e.kind).collect();
    assert_eq!(types, ["in", "out"]);
}

/// What lets the toggle survive a clock that jumps: events are ordered by
/// insertion, never by timestamp. Written out of order on purpose.
#[test]
fn the_last_event_is_the_last_one_inserted_even_if_its_timestamp_is_older() {
    let mut w = World::new();
    let card = w.register("Uma");
    let id = w.id(&card);
    let now = w.now();
    w.store.add_event(id, "in", &now, None, None).unwrap();
    w.jump_clock(-6 * HOUR);
    let earlier = w.now();
    w.store.add_event(id, "out", &earlier, None, None).unwrap();
    assert_eq!(w.store.last_event(id).unwrap().unwrap().kind, "out");
    assert_eq!(w.types(&card), ["in", "out"]);
}

#[test]
fn a_stale_dated_arrival_still_shows_the_person_as_currently_in() {
    let mut w = World::new();
    let card = w.register("Vito");
    let id = w.id(&card);
    let now = w.now();
    w.store.add_event(id, "out", &now, Some(BOOT), None).unwrap();
    w.jump_clock(-6 * HOUR);
    let earlier = w.now();
    w.store.add_event(id, "in", &earlier, Some(BOOT), None).unwrap();
    assert!(w.is_in(BOOT, &card), "expected the last-inserted \"in\" to count");
}

// ---- Deactivation --------------------------------------------------------
// People are never deleted: that would take their residency history too.

#[test]
fn deactivating_a_person_keeps_every_one_of_their_events() {
    let mut w = World::new();
    let card = w.register("Wren");
    w.tap(&card);
    w.tap(&card);
    let id = w.id(&card);
    w.store.set_active(id, false).unwrap();
    assert!(!w.store.by_card(&card).unwrap().unwrap().active);
    assert_eq!(w.types(&card), ["in", "out"]);
    assert!(w.store.users().unwrap().iter().any(|u| u.id == id), "still listed, for the hours report");
}

// Web: "there is no way to delete a person". Natively the only delete is for
// someone the Staffers tab no longer lists, and it never touches anyone who
// has tapped.
#[test]
fn a_person_with_history_can_never_be_deleted() {
    let mut w = World::new();
    let card = w.register("Kept");
    w.tap(&card);
    let id = w.id(&card);
    w.store.delete_unlisted(id).unwrap();
    assert!(w.store.user(id).unwrap().is_some());
    assert_eq!(w.types(&card), ["in"]);
}

#[test]
fn a_deactivated_card_records_nothing_and_is_not_offered_for_registration() {
    let mut w = World::new();
    let card = w.register("Xavi");
    let id = w.id(&card);
    w.store.set_active(id, false).unwrap();
    let result = w.tap(&card);
    assert_eq!(result.status, "inactive");
    assert_eq!(result.name, "Xavi");
    assert!(w.types(&card).is_empty());
    assert!(!w.unknown().contains(&card));
}

#[test]
fn someone_deactivated_while_checked_in_stops_showing_as_in() {
    let mut w = World::new();
    let card = w.register("Yael");
    w.tap(&card);
    assert!(w.is_in(BOOT, &card));
    w.store.set_active(w.id(&card), false).unwrap();
    assert!(!w.is_in(BOOT, &card));
}

#[test]
fn a_reactivated_card_works_again_carrying_on_from_their_history() {
    let mut w = World::new();
    let card = w.register("Zed");
    w.tap(&card);
    w.tap(&card);
    let id = w.id(&card);
    w.store.set_active(id, false).unwrap();
    w.store.set_active(id, true).unwrap();
    assert_eq!(w.tap(&card).direction, "in");
    assert_eq!(w.types(&card).len(), 3);
}

/// The Pi's database was created before people could be deactivated.
#[test]
fn a_database_from_before_deactivation_opens_with_everyone_active() {
    let tmp = TempDb::new("old");
    {
        let old = rusqlite::Connection::open(tmp.file()).unwrap();
        old.execute_batch(
            "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, student_id TEXT,
               role TEXT, rfid TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
             CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
               type TEXT NOT NULL CHECK (type IN ('in','out')), ts TEXT NOT NULL, boot_id TEXT,
               FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
             INSERT INTO users (name, rfid, created_at) VALUES ('Old Hand', '777', '2026-01-01T00:00:00.000Z');
             INSERT INTO events (user_id, type, ts) VALUES (1, 'in', '2026-01-02T01:00:00.000Z');",
        )
        .unwrap();
    }
    let store = Store::open(tmp.file()).unwrap();
    let user = store.by_card("777").unwrap().unwrap();
    assert!(user.active);
    assert_eq!(store.events_for(user.id).unwrap().len(), 1);
}
