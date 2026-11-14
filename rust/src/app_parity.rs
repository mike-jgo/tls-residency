// The web app's people, auth, appearance and flows tests
// (legacy/test/people.test.js, auth.test.js, appearance.test.js, flows.test.js),
// ported where they test a rule rather than a web page. A child of core.rs.
//
// Not ported, as they test the web's HTML, cookies or browser scripts:
//   - auth: Basic-auth caching and cookie rotation (no cookies natively).
//   - appearance: how the tap screen and Appearances page render.
//   - flows: native dialog focus, idle drafts and form recovery are exercised
//     by management::ui_parity in the binary's event-loop test. Live-connection
//     browser states do not apply to the in-process native backend.
//   - guard.test.js: requests from other websites (no web server natively).

use super::*;
use crate::{model::{Person, SECTIONS, STATUSES}, scan::Reader};

fn person(changes: impl FnOnce(&mut Person)) -> Person {
    let mut p = Person {
        name: " Ana Cruz ".into(),
        student_id: "12345678".into(),
        section: "Sports".into(),
        status: "Probie".into(),
        telegram: "ana_cruz".into(),
    };
    changes(&mut p);
    p
}

// ---- People (legacy/test/people.test.js) --------------------------------------

#[test]
fn a_telegram_handle_is_stored_with_one_at_however_it_was_typed() {
    for typed in ["ana_cruz", "@ana_cruz", "  @@ana_cruz "] {
        assert_eq!(person(|p| p.telegram = typed.into()).validated().unwrap().telegram, "@ana_cruz", "{typed:?}");
    }
}

#[test]
fn something_that_is_not_a_telegram_handle_is_refused() {
    for bad in ["ana cruz", "https://t.me/ana", &"a".repeat(33)] {
        assert!(person(|p| p.telegram = bad.to_string()).validated().is_err(), "{bad:?}");
    }
}

#[test]
fn a_filled_in_form_becomes_a_person() {
    let p = person(|_| {}).validated().unwrap();
    assert_eq!(
        (p.name.as_str(), p.student_id.as_str(), p.section.as_str(), p.status.as_str(), p.telegram.as_str()),
        ("Ana Cruz", "12345678", "Sports", "Probie", "@ana_cruz")
    );
}

#[test]
fn every_section_and_every_status_is_accepted() {
    for s in SECTIONS {
        assert!(person(|p| p.section = s.into()).validated().is_ok(), "{s}");
    }
    for s in STATUSES {
        assert!(person(|p| p.status = s.into()).validated().is_ok(), "{s}");
    }
}

#[test]
fn name_id_number_section_and_status_are_all_required() {
    let blanks: [fn(&mut Person); 4] = [
        |p| p.name.clear(),
        |p| p.student_id.clear(),
        |p| p.section.clear(),
        |p| p.status.clear(),
    ];
    for blank in blanks {
        assert!(person(blank).validated().is_err());
    }
}

#[test]
fn a_telegram_handle_can_be_left_out_but_not_mistyped() {
    assert_eq!(person(|p| p.telegram.clear()).validated().unwrap().telegram, "");
    assert_eq!(person(|p| p.telegram = "  ".into()).validated().unwrap().telegram, "");
    assert!(person(|p| p.telegram = "two words".into()).validated().unwrap_err().to_string().contains("Telegram"));
}

/// The dropdowns are only a convenience: the form can carry anything.
#[test]
fn a_section_or_status_that_is_not_on_the_list_is_refused() {
    assert!(person(|p| p.section = "Gossip".into()).validated().is_err());
    assert!(person(|p| p.status = "Boss".into()).validated().is_err());
}

// ---- Admin sign-in (legacy/test/auth.test.js) ---------------------------------

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("residency-app-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        Self(p)
    }
    fn core(&self, password: &str) -> Arc<Core> {
        let config = Config {
            db_path: self.0.join("residency.db"),
            backup_dir: self.0.join("backups"),
            backup_keep: 60,
            key_file: self.0.join("unused.json"),
            spreadsheet_id: String::new(),
            admin_user: "admin".into(),
            admin_password: password.into(),
            dates: dates::Dates::new("Asia/Manila").unwrap(),
        };
        let (core, _) = Core::with_sync(config, None, false).unwrap();
        core.clock.store(true, Ordering::Relaxed);
        core
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn sign_in_accepts_a_colon_password_and_rejects_wrong_credentials() {
    let f = Fixture::new();
    let core = f.core("correct:password");
    assert!(!core.authenticated());
    assert!(!core.login("admin", "wrong"));
    assert!(!core.login("wrong", "correct:password"));
    assert!(core.login("admin", "correct:password"));
    assert!(core.authenticated());
}

#[test]
fn signing_out_ends_the_session() {
    let f = Fixture::new();
    let core = f.core("secret");
    assert!(core.login("admin", "secret"));
    core.logout();
    assert!(!core.authenticated());
}

#[test]
fn sessions_expire_after_inactivity_and_are_lost_on_restart() {
    let f = Fixture::new();
    {
        let core = f.core("secret");
        assert!(core.login("admin", "secret"));
        // Thirty minutes without a change: signed out.
        *core.admin_until.lock().unwrap() = Some(Instant::now() - Duration::from_millis(1));
        assert!(!core.authenticated());
        assert!(core.login("admin", "secret"));
        assert!(core.authenticated());
    }
    assert!(!f.core("secret").authenticated(), "a new run starts signed out");
}

// ---- Appearance (legacy/test/appearance.test.js) ------------------------------

const PNG: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
fn png(dir: &Path, name: &str) -> PathBuf {
    let file = dir.join(name);
    image::RgbaImage::from_pixel(2, 2, image::Rgba([1, 2, 3, 255])).save(&file).unwrap();
    file
}
fn jpeg(dir: &Path, name: &str) -> PathBuf {
    let file = dir.join(name);
    image::RgbImage::from_pixel(2, 2, image::Rgb([1, 2, 3])).save(&file).unwrap();
    file
}
fn signed_in(f: &Fixture) -> Arc<Core> {
    let core = f.core("secret");
    assert!(core.login("admin", "secret"));
    core
}

#[test]
fn no_picture_until_one_is_set_at_the_default_opacity() {
    let f = Fixture::new();
    let a = signed_in(&f).snapshot().unwrap().appearance;
    assert!(a.image.is_none());
    assert_eq!((a.opacity, a.theme.as_str(), a.hidden), (85.0, "none", false));
}

#[test]
fn a_picture_is_stored_beside_the_database_and_versioned() {
    let f = Fixture::new();
    let core = signed_in(&f);
    core.background(&png(&f.0, "a.png")).unwrap();
    let first = core.snapshot().unwrap().appearance.image.unwrap();
    assert!(!first.version.is_empty());
    let stored = fs::read(f.0.join("background.img")).unwrap();
    assert!(stored.starts_with(PNG));
    assert!(!f.0.join("background.img.tmp").exists());

    core.background(&jpeg(&f.0, "b.jpg")).unwrap();
    let second = core.snapshot().unwrap().appearance.image.unwrap();
    assert_ne!(second.version, first.version);
    assert!(fs::read(f.0.join("background.img")).unwrap().starts_with(&[0xff, 0xd8, 0xff]));
}

#[test]
fn what_isnt_a_picture_or_is_too_big_is_refused_and_the_old_one_kept() {
    let f = Fixture::new();
    let core = signed_in(&f);
    core.background(&png(&f.0, "a.png")).unwrap();
    let kept = core.snapshot().unwrap().appearance.image.unwrap().version;

    let script = f.0.join("script.png");
    fs::write(&script, "#!/bin/sh\necho hi\n").unwrap();
    assert!(core.background(&script).is_err());
    let empty = f.0.join("empty.png");
    fs::write(&empty, "").unwrap();
    assert!(core.background(&empty).is_err());
    let big = f.0.join("big.png");
    let mut bytes = fs::read(png(&f.0, "small.png")).unwrap();
    bytes.resize(8 * 1024 * 1024 + 1, 0);
    fs::write(&big, bytes).unwrap();
    assert!(core.background(&big).unwrap_err().to_string().contains("too big"));

    assert_eq!(core.snapshot().unwrap().appearance.image.unwrap().version, kept);
}

#[test]
fn removing_the_picture_keeps_the_opacity() {
    let f = Fixture::new();
    let core = signed_in(&f);
    core.background(&png(&f.0, "a.png")).unwrap();
    core.appearance(60, "none", false).unwrap();
    core.remove_background().unwrap();
    let a = core.snapshot().unwrap().appearance;
    assert!(a.image.is_none());
    assert_eq!(a.opacity, 60.0);
    assert!(!f.0.join("background.img").exists());
    core.remove_background().unwrap(); // twice is fine
}

/// Web: parseOpacity clamps 250 to 100. Natively the slider can't go past
/// 100, and anything outside 0 to 100 is refused, keeping the old value.
#[test]
fn a_bad_opacity_is_refused_and_the_old_one_kept() {
    let f = Fixture::new();
    let core = signed_in(&f);
    core.appearance(20, "none", false).unwrap();
    for bad in [-5, 250] {
        assert!(core.appearance(bad, "none", false).unwrap_err().to_string().contains("0 to 100"));
    }
    assert_eq!(core.snapshot().unwrap().appearance.opacity, 20.0);
}

#[test]
fn a_missing_file_reads_as_no_picture() {
    let f = Fixture::new();
    let core = signed_in(&f);
    core.background(&png(&f.0, "a.png")).unwrap();
    fs::remove_file(f.0.join("background.img")).unwrap();
    assert!(core.snapshot().unwrap().appearance.image.is_none());
}

#[test]
fn the_rankings_show_until_hidden_and_come_back_when_shown_again() {
    let f = Fixture::new();
    let core = signed_in(&f);
    assert!(!core.snapshot().unwrap().leaderboards.unwrap().hidden);
    core.appearance(85, "none", true).unwrap();
    let boards = core.snapshot().unwrap().leaderboards.unwrap();
    assert!(boards.hidden);
    assert!(boards.sections.is_empty() && boards.staffers.is_empty(), "nothing to peek at");
    core.appearance(85, "none", false).unwrap();
    assert!(!core.snapshot().unwrap().leaderboards.unwrap().hidden);
}

#[test]
fn a_season_is_one_of_the_listed_themes_and_a_bad_one_keeps_the_old() {
    let f = Fixture::new();
    let core = signed_in(&f);
    core.appearance(85, "christmas", false).unwrap();
    assert!(core.appearance(85, "halloween", false).is_err());
    assert!(core.appearance(85, "__proto__", false).is_err());
    assert_eq!(core.snapshot().unwrap().appearance.theme, "christmas");
    core.appearance(85, "none", false).unwrap();
    assert_eq!(core.snapshot().unwrap().appearance.theme, "none");
}

// ---- Flows (legacy/test/flows.test.js) ----------------------------------------

/// A lost tap reply keeps its receipt across a restart and reuses it safely.
#[test]
fn a_lost_tap_response_keeps_its_receipt_across_a_restart_and_safely_reuses_it() {
    let f = Fixture::new();
    let first = {
        let core = signed_in(&f);
        core.register(person(|p| p.name = "Ana".into()), "0001").unwrap();
        core.tap("0001").unwrap() // the screen never showed it
    };
    let core = f.core("secret");
    assert_eq!(core.snapshot().unwrap().pending_cards, ["0001"]);
    let again = core.tap("0001").unwrap();
    assert!(again.replayed);
    assert_eq!(again.request_id, first.request_id);
    assert_eq!(core.store.lock().unwrap().events().unwrap().len(), 1);
}

/// A plain Enter (on a focused button) is not the reader's; an oversized
/// burst from the reader is swallowed whole, its Enter included.
#[test]
fn plain_enter_works_but_an_oversized_scanner_burst_cannot_press_a_focused_button() {
    let start = Instant::now();
    let mut r = Reader::new(true);
    assert_eq!(r.key("\n", false, start), (false, None), "plain Enter goes to the button");
    for n in 0..70 {
        assert_eq!(r.key("7", false, start + Duration::from_millis(n)).0, true);
    }
    assert_eq!(r.key("\n", false, start + Duration::from_millis(70)), (true, None), "the burst's Enter is consumed, and taps nothing");
    // A normal tap afterwards still works.
    for (n, d) in "0001".chars().enumerate() {
        r.key(&d.to_string(), false, start + Duration::from_millis(200 + n as u64));
    }
    assert_eq!(r.key("\n", false, start + Duration::from_millis(205)), (true, Some("0001".into())));
}
