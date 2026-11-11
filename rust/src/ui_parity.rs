use super::*;
use i_slint_backend_testing::ElementHandle;
use slint::platform::{Key, WindowEvent};
use slint::SharedString;

fn key(ui: &AppWindow, text: impl Into<SharedString>) {
    let text = text.into();
    ui.window().dispatch_event(WindowEvent::KeyPressed { text: text.clone() });
    ui.window().dispatch_event(WindowEvent::KeyReleased { text });
}

async fn idle(ui: &AppWindow) {
    until(|| !ui.global::<Admin>().get_busy()).await;
}

async fn until(mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    std::future::poll_fn(|cx| {
        assert!(Instant::now() < deadline, "native operation did not finish");
        if ready() {
            std::task::Poll::Ready(())
        } else {
            let wake = cx.waker().clone();
            Timer::single_shot(Duration::from_millis(5), move || wake.wake());
            std::task::Poll::Pending
        }
    }).await;
}

fn person(name: &str) -> PersonData {
    PersonData { name: name.into(), student_id: "UI001".into(), section: "Web".into(), status: "Regular".into(), telegram: "@test".into() }
}

// One event-loop test exercises the compiled Slint controls and the real
// management callbacks, including asynchronous failures and idle return.
#[test]
fn native_keyboard_drafts_forms_and_shutdown() {
    slint::platform::set_platform(Box::new(i_slint_backend_testing::TestingBackend::new(
        i_slint_backend_testing::TestingBackendOptions {
            threading: true, renderer_name: Some("software".into()), ..Default::default()
        },
    ))).unwrap();
    slint::spawn_local(async {
        let ui = AppWindow::new().unwrap();
        ui.show().unwrap();
        // Every rank must be visible without scrolling, including at kiosk minimum size.
        ui.set_clock("Wed, Nov 11, 10:41 AM".into());
        ui.set_in_title("IN THE OFFICE (0)".into());
        ui.set_people_empty("Nobody is checked in.".into());
        ui.set_board_title("LEADERBOARD · NOVEMBER 2026".into());
        ui.set_view(TapView { kind: "idle".into(), big: "Tap your ID".into(),
            detail: "Once when you arrive, once when you leave.".into(), ..Default::default() });
        let section_names = tls_residency::model::SECTIONS;
        let staffer_names: Vec<_> = (1..=10).map(|i| if i <= 2 {
            format!("DE LOS REYES, Alexandria Dominique Mariella {i:02}")
        } else {
            format!("SANTOS, Alexandria Dominique {i:02}")
        }).collect();
        let bar = |i: usize, name: &str| Bar {
            rank: (i + 1).to_string().into(), label: name.into(), hours: "123.5 h".into(),
            fraction: 1.0, color: hex(0x054805),
        };
        ui.set_sections(model(section_names.iter().enumerate().map(|(i, name)| bar(i, name)).collect()));
        ui.set_staffers(model(staffer_names.iter().enumerate().map(|(i, name)| bar(i, name)).collect()));
        for (width, height) in [(1000.0, 660.0), (1280.0, 800.0)] {
            ui.window().set_size(slint::LogicalSize::new(width, height));
            for christmas in [false, true] {
                ui.set_christmas(christmas);
                let pixels = ui.window().take_snapshot().unwrap();
                let output = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/leaderboard-layout");
                std::fs::create_dir_all(&output).unwrap();
                image::save_buffer(output.join(format!("{width}x{height}-{}.png", if christmas { "christmas" } else { "plain" })),
                    pixels.as_bytes(), pixels.width(), pixels.height(), image::ColorType::Rgba8).unwrap();
                let panel = ElementHandle::find_by_element_id(&ui, "AppWindow::leaderboard").next().unwrap();
                let panel_top = panel.absolute_position().y;
                let panel_bottom = panel_top + panel.size().height;
                assert!(panel_bottom <= height - 24.0 + 1.0,
                    "the leaderboard panel must fit inside the window: top={panel_top}, bottom={panel_bottom}, window={:?}", ui.window().size());
                for name in section_names.iter().copied().chain(staffer_names.iter().map(String::as_str)) {
                    let row = ElementHandle::find_by_accessible_label(&ui, name).next().unwrap();
                    let pos = row.absolute_position();
                    let size = row.size();
                    assert!(size.height > 0.0 && pos.y >= panel_top + 16.0 && pos.y + size.height <= panel_bottom - 16.0,
                        "{name} must fit at {width}×{height}: y={}, height={}", pos.y, size.height);
                    assert!(pos.x >= 0.0 && pos.x + size.width <= width, "{name} must fit horizontally");
                }
                let sections = ElementHandle::find_by_accessible_label(&ui, "SECTIONS").next().unwrap().absolute_position();
                let staffers = ElementHandle::find_by_accessible_label(&ui, "TOP 10 STAFFERS").next().unwrap().absolute_position();
                assert!((sections.y - staffers.y).abs() < 1.0 && staffers.x > sections.x,
                    "sections and staffers must remain side by side");
                let last = ElementHandle::find_by_accessible_label(&ui, staffer_names.last().unwrap()).next().unwrap();
                let bottom_gap = panel_bottom - last.absolute_position().y - last.size().height;
                assert!(bottom_gap <= 24.0, "the leaderboard must hug its rows, not keep empty space: gap={bottom_gap}");
                assert!((panel_bottom - (height - 24.0)).abs() <= 1.0,
                    "the office panel must fill the space above the bottom-aligned leaderboard");
            }
        }
        ui.set_managing(true);
        ui.global::<Admin>().set_admin(true);
        ui.global::<Admin>().set_page("dashboard".into());
        let navigated = Rc::new(RefCell::new(String::new()));
        let nav = Rc::clone(&navigated);
        ui.global::<Admin>().on_navigate(move |page| *nav.borrow_mut() = page.to_string());
        ui.invoke_focus_admin();
        for wanted in ["dashboard", "people", "hours", "appearance", "system", "station"] {
            navigated.borrow_mut().clear();
            for _ in 0..40 {
                key(&ui, Key::Tab);
                key(&ui, Key::Space);
                if navigated.borrow().as_str() == wanted { break; }
            }
            assert_eq!(navigated.borrow().as_str(), wanted, "navigation must work without a mouse");
        }
        let people = ElementHandle::find_by_accessible_label(&ui, "People").next().unwrap();
        people.invoke_accessible_default_action();
        assert_eq!(navigated.borrow().as_str(), "people");
        navigated.borrow_mut().clear();
        people.single_click(slint::platform::PointerEventButton::Left).await;
        assert_eq!(navigated.borrow().as_str(), "people", "keyboard focus targets must not intercept pointer clicks");

        ui.global::<Admin>().set_page("hours".into());
        ui.global::<Admin>().set_hour_rows(model(vec![HourRow {
            name: "Ana".into(), hours: "0.00".into(), uncounted: "1".into(), ..Default::default()
        }]));
        ui.global::<Admin>().set_selected(-1);
        ElementHandle::find_by_accessible_label(&ui, "Ana, 0.00 hours, 1 uncounted sessions").next().unwrap()
            .single_click(slint::platform::PointerEventButton::Left).await;
        assert_eq!(ui.global::<Admin>().get_selected(), 0);
        ui.global::<Admin>().set_selected(-1);
        for _ in 0..60 {
            key(&ui, Key::Tab);
            key(&ui, Key::Return);
            if ui.global::<Admin>().get_selected() == 0 { break; }
        }
        assert_eq!(ui.global::<Admin>().get_selected(), 0, "uncounted sessions must be keyboard-selectable");
        ui.set_managing(false);
        let shutdown_actions = Rc::new(RefCell::new(Vec::new()));
        let cancel = Rc::clone(&shutdown_actions);
        ui.on_shut_cancel(move || cancel.borrow_mut().push("cancel"));
        let confirm = Rc::clone(&shutdown_actions);
        ui.on_shut_confirm(move || confirm.borrow_mut().push("confirm"));
        ui.set_shut_mode("confirm".into());
        ui.set_shut_open(true);
        key(&ui, Key::Return);
        assert_eq!(*shutdown_actions.borrow(), ["cancel"], "shutdown initially focuses Cancel");
        for _ in 0..8 {
            let before = shutdown_actions.borrow().len();
            key(&ui, Key::Tab);
            key(&ui, Key::Return);
            assert_eq!(shutdown_actions.borrow().len(), before + 1, "focus must stay inside shutdown");
        }
        ui.set_shut_open(false);
        ui.hide().unwrap();
        drop(ui);

        let dir = std::env::temp_dir().join(format!("residency-ui-{}", uuid::Uuid::new_v4()));
        let config = Config {
            db_path: dir.join("residency.db"), backup_dir: dir.join("backups"), backup_keep: 60,
            key_file: dir.join("unused.json"), spreadsheet_id: String::new(),
            admin_user: "admin".into(), admin_password: "secret".into(),
            dates: dates::Dates::new("Asia/Manila").unwrap(), max_session_ms: 43_200_000,
        };
        let (core, _) = Core::start(config).unwrap();
        let ui = AppWindow::new().unwrap();
        connect(&ui);
        ui.on_shut_cancel(|| with_app(App::close_shut));
        ui.on_key(|text, modifier| {
            let mut used = false;
            with_app(|app| used = app.key(&text, modifier));
            used
        });
        APP.with(|cell| *cell.borrow_mut() = Some(App {
            ui: ui.clone_strong(), status: core.snapshot().unwrap(), core: Arc::clone(&core),
            christmas: false, background_version: None, background_size: (0, 0), shown: None, hide: Timer::default(),
            sending: HashSet::new(), shut_open: false, shutting_down: false, shut_error: String::new(),
            reader: Reader::new(false), manage_open: false, last_activity: Instant::now(), data: Data::default(),
        }));
        ui.show().unwrap();
        with_app(|app| app.navigate("register"));
        ElementHandle::find_by_accessible_label(&ui, "Card number — tap their ID now").next().unwrap()
            .single_click(slint::platform::PointerEventButton::Left).await;
        for digit in "0099".chars() { key(&ui, digit.to_string().as_str()); }
        assert_eq!(ui.global::<Admin>().get_card(), "0099", "management fields receive scanner digits");
        key(&ui, Key::Return);
        idle(&ui).await;
        assert!(core.unknown().is_empty(), "form input must never reach attendance");
        with_app(|app| {
            app.navigate("register");
            app.fill_person(&person("Ana"), "0001");
            app.action("save-person");
        });
        idle(&ui).await;
        assert!(ui.global::<Admin>().get_notice().contains("registered"));
        assert!(ui.global::<Admin>().get_person_name().is_empty());

        // A duplicate card fails through the worker and retains every field.
        let draft = person("Unsaved registration");
        with_app(|app| { app.fill_person(&draft, "0001"); app.action("save-person"); });
        idle(&ui).await;
        assert!(ui.global::<Admin>().get_error());
        with_app(|app| {
            assert_eq!(app.form_person(), draft);
            assert_eq!(app.adm().get_card(), "0001");
            app.last_activity = Instant::now() - Duration::from_secs(121);
            app.tick();
            assert!(!app.ui.get_managing());
            assert!(!app.core.authenticated());
            app.navigate("register");
            assert_eq!(app.form_person(), draft);
            assert!(app.adm().get_restored_draft());
        });
        ElementHandle::find_by_accessible_label(&ui, "Discard them").next().unwrap().invoke_accessible_default_action();
        with_app(|app| {
            assert_eq!(app.form_person(), PersonData::default());
            assert!(app.adm().get_card().is_empty());
            app.navigate("station");
            app.navigate("register");
            assert!(!app.adm().get_restored_draft());
        });

        assert!(core.login("admin", "secret"));
        with_app(|app| {
            app.status.sync = Some(tls_residency::core::SyncBadge {
                state: "pending".into(), label: "Syncing".into(), uploaded: 12, pending: 3,
                last_synced_at: Some("2026-10-01T01:00:00.000Z".into()),
            });
            app.navigate("dashboard");
            let text = app.adm().get_sheet_text();
            assert!(text.contains("12 uploaded") && text.contains("3 waiting") && text.contains("Last synced:"));
        });
        with_app(|app| app.navigate("people"));
        idle(&ui).await;
        with_app(|app| {
            app.adm().set_selected(0);
            app.action("edit");
            app.adm().set_person_name("Unsaved edit".into());
            app.last_activity = Instant::now() - Duration::from_secs(121);
            app.tick();
            assert!(!app.core.authenticated());
        });
        assert!(core.login("admin", "secret"));
        with_app(|app| app.navigate("people"));
        idle(&ui).await;
        with_app(|app| {
            app.adm().set_selected(0);
            app.action("edit");
            assert_eq!(app.form_person().name, "Unsaved edit");
            assert!(app.adm().get_restored_draft());
            app.action("discard-draft");
            assert_eq!(app.form_person().name, "Ana");
            app.adm().set_person_name("Saved edit".into());
            app.action("save-person");
        });
        idle(&ui).await;
        with_app(|app| {
            app.adm().set_selected(0);
            app.action("edit");
            assert_eq!(app.form_person().name, "Saved edit");
            assert!(!app.adm().get_restored_draft());
            app.adm().set_person_name("Cancelled".into());
            app.action("escape");
        });
        idle(&ui).await;
        with_app(|app| {
            app.adm().set_selected(0);
            app.action("edit");
            assert_eq!(app.form_person().name, "Saved edit");
            app.navigate("station");
            app.open_shut();
        });
        let poweroff = Rc::new(RefCell::new(0));
        let confirm = Rc::clone(&poweroff);
        ui.on_shut_confirm(move || *confirm.borrow_mut() += 1);
        for digit in "9876".chars() { key(&ui, digit.to_string().as_str()); }
        key(&ui, Key::Return);
        until(|| {
            let mut done = false;
            with_app(|app| done = app.sending.is_empty());
            done
        }).await;
        assert_eq!(*poweroff.borrow(), 0, "scanner Enter must not activate shutdown");
        assert!(core.unknown().iter().any(|(card, _)| card == "9876"));
        assert!(ui.get_shut_open());
        key(&ui, Key::Escape);
        assert!(!ui.get_shut_open());

        // Sorting and paging keep row actions tied to the displayed person.
        assert!(core.login("admin", "secret"));
        with_app(|app| {
            app.adm().set_page("people".into());
            app.data.users = (0..117).map(|i| User {
                id: i + 1, person: PersonData { name: format!("Person {i:03}"), student_id: format!("{i:03}"), ..person("Unused") },
                rfid: format!("{i:04}"), active: i % 2 == 0, created_at: String::new(),
            }).collect();
            app.adm().set_query("".into());
            app.adm().set_sort_by("Name".into());
            app.filter_rows();
            assert_eq!(app.adm().get_people_rows().row_count(), 20);
            assert_eq!(app.adm().get_page_caption(), "1–20 of 117");
            app.action("next-page");
            app.adm().set_selected(0);
            assert_eq!(app.selected_user().unwrap().person.name, "Person 020");
            app.adm().set_sort_descending(true);
            app.action("filter");
            app.adm().set_selected(0);
            assert_eq!(app.selected_user().unwrap().person.name, "Person 116");
            app.adm().set_active_filter("Deactivated".into());
            app.action("filter");
            assert!(app.adm().get_people_rows().iter().all(|r| !r.active));
            app.adm().set_query("Person 001".into());
            app.action("search");
            app.adm().set_query("Person 003".into());
            app.action("search");
        });
        until(|| ui.global::<Admin>().get_people_rows().row_count() == 1).await;
        assert_eq!(ui.global::<Admin>().get_people_rows().row_data(0).unwrap().name, "Person 003");
        with_app(|app| {
            app.render_all();
            let people = app.ui.get_people();
            let boards = app.ui.get_staffers();
            let mut snapshot = app.core.snapshot().unwrap();
            snapshot.currently_in = app.status.currently_in.clone();
            snapshot.leaderboards = app.status.leaderboards.clone();
            snapshot.appearance = app.status.appearance.clone();
            snapshot.sync = Some(tls_residency::core::SyncBadge { state: "synced".into(), label: "Synced".into(), ..Default::default() });
            app.apply_snapshot(snapshot);
            assert!(people == app.ui.get_people(), "a sync badge update must preserve the presence model");
            assert!(boards == app.ui.get_staffers(), "a sync badge update must preserve the leaderboard model");
            app.adm().set_page("hours".into());
            app.adm().set_from("2026-01-01".into());
            app.action("previous-month");
            assert_eq!(app.adm().get_from(), "2025-12-01");
            assert_eq!(app.adm().get_to(), "2025-12-31");
        });
        idle(&ui).await;
        APP.with(|cell| cell.borrow_mut().take());
        ui.hide().unwrap();
        drop(ui);
        drop(core);
        std::fs::remove_dir_all(dir).unwrap();
        slint::quit_event_loop().unwrap();
    }).unwrap();
    slint::run_event_loop().unwrap();
}
