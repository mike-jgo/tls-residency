// The web app's Sheets client tests (web/test/sheets.test.js), ported to the
// native client, which talks HTTP to a stand-in for Google on this machine.
//
// The key in testdata/throwaway-test-key.pem was made for these tests only
// and belongs to no account.
//
// Differences from the web client:
//   - Tab dressing, styling, column fitting and column deletion are built by
//     sheet_layout.rs and sync.rs and sent through `batch`; the requests they
//     build are checked in sync_parity.rs. Here `batch` is checked to send
//     them as given.
//   - "several ranges are read in one request": the native client reads one
//     range per request. Not ported; there is no batched read to test.

use crate::{
    config::spreadsheet_id_from,
    sheet_layout,
    sheets::{self, Google, Range, Sheets, Tab},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    path::PathBuf,
    sync::{
        atomic::{AtomicI64, Ordering},
        Arc, Mutex,
    },
};

#[derive(Debug, Clone)]
struct Call {
    path: String,
    authorization: String,
    body: String,
}
type Answer = Box<dyn Fn(&Call) -> (u16, Value) + Send>;

/// A stand-in for Google: answers the token exchange, records every call,
/// and hands API calls to `answer`.
struct FakeGoogle {
    base: String,
    calls: Arc<Mutex<Vec<Call>>>,
}
impl FakeGoogle {
    fn new(answer: impl Fn(&Call) -> (u16, Value) + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let calls = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&calls);
        let answer: Answer = Box::new(answer);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
                let mut parts = line.split_whitespace();
                let method = parts.next().unwrap_or_default().to_string();
                let path = parts.next().unwrap_or_default().to_string();
                let (mut length, mut authorization) = (0, String::new());
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    let header = header.trim_end();
                    if header.is_empty() {
                        break;
                    }
                    let (name, value) = header.split_once(':').unwrap_or((header, ""));
                    match name.to_ascii_lowercase().as_str() {
                        "content-length" => length = value.trim().parse().unwrap_or(0),
                        "authorization" => authorization = value.trim().to_string(),
                        _ => {}
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let _ = method;
                let call = Call { path, authorization, body: String::from_utf8_lossy(&body).into_owned() };
                let (status, reply) = if call.path == "/token" {
                    let n = recorded.lock().unwrap().len() + 1;
                    (200, json!({"access_token": format!("token-{n}"), "expires_in": 3600}))
                } else {
                    answer(&call)
                };
                recorded.lock().unwrap().push(call);
                let text = reply.to_string();
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
                    text.len()
                );
            }
        });
        Self { base, calls }
    }
    fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }
    fn api_calls(&self) -> Vec<Call> {
        self.calls().into_iter().filter(|c| c.path != "/token").collect()
    }
    fn body(&self, n: usize) -> Value {
        serde_json::from_str(&self.api_calls()[n].body).unwrap()
    }
}
fn ok(_: &Call) -> (u16, Value) {
    (200, json!({}))
}

struct Key(PathBuf);
impl Key {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("tls-sheets-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("service-account.json");
        std::fs::write(
            &file,
            json!({
                "client_email": "pi@example.iam.gserviceaccount.com",
                "private_key": include_str!("../testdata/throwaway-test-key.pem"),
                "token_uri": "https://oauth2.googleapis.com/token",
            })
            .to_string(),
        )
        .unwrap();
        Self(file)
    }
}
impl Drop for Key {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(self.0.parent().unwrap());
    }
}
const NOW: i64 = 1_790_812_800; // 2026-10-01T00:00:00Z
fn client(google: &FakeGoogle, key: &Key) -> Google {
    Google::local("abc", key.0.clone(), &google.base, || NOW)
}
fn form(body: &str, name: &str) -> String {
    body.split('&')
        .find_map(|p| p.strip_prefix(&format!("{name}=")))
        .unwrap_or_default()
        .replace("%3A", ":")
}

#[test]
fn it_signs_in_as_the_service_account_with_a_jwt_google_can_verify() {
    let google = FakeGoogle::new(|_| (200, json!({"sheets": [{"properties": {"title": "Totals", "sheetId": 1}}]})));
    let key = Key::new();
    let tabs = client(&google, &key).describe().unwrap();
    assert_eq!(tabs.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(), ["Totals"]);

    let calls = google.calls();
    let (token, api) = (&calls[0], &calls[1]);
    assert_eq!(form(&token.body, "grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
    let assertion = form(&token.body, "assertion");
    let parts: Vec<_> = assertion.split('.').collect();
    // Checked the way Google checks it: against the key's public half.
    let pem: String = include_str!("../testdata/throwaway-test-key.pem").lines().filter(|l| !l.starts_with("---")).collect();
    let der = base64::engine::general_purpose::STANDARD.decode(pem).unwrap();
    let pair = ring::signature::RsaKeyPair::from_pkcs8(&der).unwrap();
    let public = ring::signature::UnparsedPublicKey::new(&ring::signature::RSA_PKCS1_2048_8192_SHA256, pair.public().as_ref());
    public
        .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &URL_SAFE_NO_PAD.decode(parts[2]).unwrap())
        .expect("a signature Google can verify");
    let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
    assert_eq!(
        claims,
        json!({
            "iss": "pi@example.iam.gserviceaccount.com",
            "scope": "https://www.googleapis.com/auth/spreadsheets",
            "aud": "https://oauth2.googleapis.com/token",
            "iat": NOW,
            "exp": NOW + 3600,
        })
    );
    assert_eq!(api.authorization, "Bearer token-1");
    assert!(api.path.starts_with("/v4/spreadsheets/abc?fields="), "{}", api.path);
}

#[test]
fn the_access_token_is_reused_until_it_is_about_to_expire() {
    let google = FakeGoogle::new(|_| (200, json!({"sheets": []})));
    let key = Key::new();
    let now = Arc::new(AtomicI64::new(NOW));
    let clock = Arc::clone(&now);
    let mut client = Google::local("abc", key.0.clone(), &google.base, move || clock.load(Ordering::Relaxed));
    let tokens = || google.calls().iter().filter(|c| c.path == "/token").count();
    client.describe().unwrap();
    client.describe().unwrap();
    assert_eq!(tokens(), 1);
    now.fetch_add(3600, Ordering::Relaxed);
    client.describe().unwrap();
    assert_eq!(tokens(), 2);
}

#[test]
fn values_are_written_to_exact_ranges_as_plain_text_rather_than_formulas() {
    let google = FakeGoogle::new(ok);
    let key = Key::new();
    let data = vec![sheets::range(
        "'October 2026'!I2:N2",
        vec![vec![json!(1), json!("2026-10-01"), json!("09:00:00"), json!("=EVIL()"), json!(""), json!("IN")]],
    )];
    client(&google, &key).write(&data, false).unwrap();
    let call = &google.api_calls()[0];
    assert!(call.path.ends_with("/spreadsheets/abc/values:batchUpdate"), "{}", call.path);
    assert_eq!(google.body(0), json!({"valueInputOption": "RAW", "data": data}));
}

#[test]
fn new_tabs_are_made_big_enough_to_write_a_month_into() {
    let google = FakeGoogle::new(ok);
    let key = Key::new();
    client(&google, &key).add_tabs(&["October 2026".into(), "Totals".into()], 9).unwrap();
    let requests = google.body(0)["requests"].as_array().unwrap().clone();
    let titles: Vec<_> = requests.iter().map(|r| r["addSheet"]["properties"]["title"].as_str().unwrap()).collect();
    assert_eq!(titles, ["October 2026", "Totals"]);
    assert!(requests[0]["addSheet"]["properties"]["gridProperties"]["rowCount"].as_i64().unwrap() >= 10000);
}

#[test]
fn tabs_are_described_by_sheet_id_with_their_filter_views() {
    let google = FakeGoogle::new(|_| {
        (200, json!({"sheets": [
            {"properties": {"sheetId": 7, "title": "Totals"}, "filterViews": [{"title": "Search"}]},
            {"properties": {"sheetId": 8, "title": "Notes"}},
        ]}))
    });
    let key = Key::new();
    let tabs = client(&google, &key).describe().unwrap();
    let seen: Vec<_> = tabs.iter().map(|t| (t.title.as_str(), t.id, t.views.clone())).collect();
    assert_eq!(seen, [("Totals", 7, vec!["Search".to_string()]), ("Notes", 8, vec![])]);
}

/// The filter views a tab lacks are added by sheet id, sorted without moving cells.
#[test]
fn filter_views_are_added_by_sheet_id_sorted_without_touching_the_cells() {
    let totals = Tab { title: "Totals".into(), id: 7, columns: 9, views: vec!["Search".into()] };
    let requests = sheet_layout::dress(&totals);
    assert_eq!(requests[0]["updateSheetProperties"]["properties"]["gridProperties"]["frozenRowCount"], 3);
    let most = requests.iter().find(|r| r["addFilterView"]["filter"]["title"] == "Most hours").unwrap();
    assert_eq!(
        most["addFilterView"]["filter"],
        json!({
            "title": "Most hours",
            "range": {"sheetId": 7, "startRowIndex": 2, "startColumnIndex": 0, "endColumnIndex": 7},
            "sortSpecs": [{"dimensionIndex": 2, "sortOrder": "DESCENDING"}],
        })
    );
    assert!(!requests.iter().any(|r| r["addFilterView"]["filter"]["title"] == "Search"), "only the ones it lacks");
}

#[test]
fn how_a_tab_looks_is_sent_as_merges_cell_formats_and_sizes() {
    let kind = |r: &Value| r.as_object().unwrap().keys().next().unwrap().clone();
    let search = sheet_layout::style(&Tab { title: "Search".into(), id: 7, columns: 24, views: vec![] });
    let kinds: Vec<_> = search.iter().map(kind).collect();
    // Frozen rows, then merges, cell formats and sizes, in that order.
    let first = |k: &str| kinds.iter().position(|x| x == k).unwrap();
    assert!(first("updateSheetProperties") < first("mergeCells"));
    assert!(first("mergeCells") < first("repeatCell"));
    assert!(first("repeatCell") < first("updateDimensionProperties"));
    let merge = search.iter().find_map(|r| r.get("mergeCells")).unwrap();
    assert_eq!(merge["range"]["sheetId"], 7);
    // Only what a format names is touched; the rest of the cell is left as it is.
    for r in search.iter().filter_map(|r| r.get("repeatCell")) {
        let fields = r["fields"].as_str().unwrap();
        assert!(fields.starts_with("userEnteredFormat(") && fields.len() > "userEnteredFormat()".len(), "{fields}");
        assert_eq!(r["range"]["sheetId"], 7);
    }
    let sizes: Vec<_> = search.iter().filter_map(|r| r.get("updateDimensionProperties")).map(|r| r["range"]["dimension"].as_str().unwrap()).collect();
    assert!(sizes.contains(&"COLUMNS") && sizes.contains(&"ROWS"));

    // Each tab styled as the web styles it (web/lib/style.js): frozen rows,
    // merges, cell formats, widths, heights.
    for (title, web) in [
        ("Totals", (0, 0, 3, 0, 0)),
        ("October 2026", (0, 0, 2, 0, 0)),
        ("October 2026 Logs", (0, 0, 2, 0, 0)),
        ("Staffers", (1, 0, 2, 0, 0)),
        ("Search", (1, 1, 8, 7, 1)),
    ] {
        let requests = sheet_layout::style(&Tab { title: title.into(), id: 1, columns: 24, views: vec![] });
        let count = |k: &str| requests.iter().filter(|r| r.get(k).is_some()).count();
        let dims = |d: &str| requests.iter().filter_map(|r| r.get("updateDimensionProperties")).filter(|r| r["range"]["dimension"] == d).count();
        let native = (count("updateSheetProperties"), count("mergeCells"), count("repeatCell"), dims("COLUMNS"), dims("ROWS"));
        assert_eq!(native, web, "{title}");
    }
}

/// Column fitting, column deletion and the rest go out as given.
#[test]
fn batch_requests_are_sent_as_given() {
    let google = FakeGoogle::new(ok);
    let key = Key::new();
    let requests = vec![
        json!({"autoResizeDimensions": {"dimensions": {"sheetId": 7, "dimension": "COLUMNS"}}}),
        json!({"deleteDimension": {"range": {"sheetId": 8, "dimension": "COLUMNS", "startIndex": 5, "endIndex": 7}}}),
    ];
    client(&google, &key).batch(requests.clone()).unwrap();
    assert!(google.api_calls()[0].path.ends_with("/spreadsheets/abc:batchUpdate"));
    assert_eq!(google.body(0), json!({"requests": requests}));
    // Nothing to send, nothing sent.
    client(&google, &key).batch(vec![]).unwrap();
    assert_eq!(google.api_calls().len(), 1);
}

#[test]
fn formulas_are_sent_to_be_worked_out_unlike_everything_else() {
    let google = FakeGoogle::new(ok);
    let key = Key::new();
    client(&google, &key).write(&[Range { range: "'Search'!A5:A5".into(), values: vec![vec![json!("=1+1")]] }], true).unwrap();
    assert_eq!(google.body(0)["valueInputOption"], "USER_ENTERED");
}

#[test]
fn no_network_is_reported_as_offline() {
    // A port nothing listens on.
    let base = {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}", l.local_addr().unwrap())
    };
    let key = Key::new();
    let err = Google::local("abc", key.0.clone(), &base, || NOW).describe().unwrap_err();
    assert!(err.offline, "{}", err.message);
    assert!(err.message.contains("Could not reach Google"), "{}", err.message);
}

#[test]
fn a_refusal_from_google_is_not_offline_and_carries_googles_reason() {
    let google = FakeGoogle::new(|_| (403, json!({"error": {"message": "The caller does not have permission"}})));
    let key = Key::new();
    let err = client(&google, &key).describe().unwrap_err();
    assert!(!err.offline);
    assert!(err.message.contains("403") && err.message.contains("does not have permission"), "{}", err.message);
}

#[test]
fn a_missing_key_file_is_a_sync_failure_with_a_clear_message_not_a_crash() {
    let google = FakeGoogle::new(ok);
    let missing = std::env::temp_dir().join(format!("nope-{}.json", uuid::Uuid::new_v4()));
    let err = Google::local("abc", missing, &google.base, || NOW).describe().unwrap_err();
    assert!(!err.offline);
    assert!(err.message.contains("service-account key"), "{}", err.message);
    assert!(google.calls().is_empty());
}

#[test]
fn the_spreadsheet_setting_may_be_the_id_or_the_whole_address() {
    assert_eq!(spreadsheet_id_from("1AbC_d-9"), "1AbC_d-9");
    assert_eq!(spreadsheet_id_from("https://docs.google.com/spreadsheets/d/1AbC_d-9/edit?gid=0#gid=0"), "1AbC_d-9");
    assert_eq!(spreadsheet_id_from(""), "");
}
