use crate::{
    dates,
    model::{valid_card, Tap},
    store::Store,
    Result,
};
use std::{collections::HashMap, time::Instant};

#[derive(Default)]
pub struct Scanner {
    repeats: HashMap<String, u64>,
    check_ins: HashMap<i64, (i64, u64)>,
    pub unknown: Vec<(String, String)>,
}
impl Scanner {
    pub fn forget_unknown(&mut self, card: &str) {
        self.unknown.retain(|(c, _)| c != card);
    }
    pub fn tap(
        &mut self,
        store: &Store,
        card: &str,
        boot: &str,
        clock_ready: bool,
        max_ms: i64,
        now: &str,
        mono: u64,
    ) -> Result<Tap> {
        if !valid_card(card) {
            return Err(
                "Tap the card reader, or enter a card number containing 1 to 64 digits.".into(),
            );
        }
        let mut next_check_in = None;
        let tap = store.transaction(|s| {
            let receipt = s.pending_receipt(card)?;
            let base = |status: &str| Tap {
                status: status.into(),
                rfid: card.into(),
                request_id: receipt.clone(),
                ..Tap::default()
            };
            if let Some(saved) = s.receipt(&receipt)? {
                let person = s
                    .user(saved.user_id)?
                    .ok_or("The saved tap has no person.")?;
                if person.rfid != card {
                    return Err("The tap receipt belongs to another card.".into());
                }
                return Ok(Tap {
                    status: "ok".into(),
                    direction: saved.kind,
                    name: person.person.name,
                    time: saved.ts,
                    replayed: true,
                    ..base("ok")
                });
            }
            if !clock_ready {
                return Ok(base("clock"));
            }
            if self
                .repeats
                .get(card)
                .is_some_and(|last| mono.saturating_sub(*last) < 5000)
            {
                return Ok(base("ignored"));
            }
            let Some(person) = s.by_card(card)? else {
                return Ok(base("unknown"));
            };
            if !person.active {
                return Ok(Tap {
                    name: person.person.name,
                    ..base("inactive")
                });
            }
            let last = s.last_event(person.id)?;
            let stale = last.as_ref().is_some_and(|e| {
                e.kind == "in"
                    && (e.boot_id.as_deref() != Some(boot) || {
                        let age = self
                            .check_ins
                            .get(&person.id)
                            .filter(|(event_id, _)| *event_id == e.id)
                            .map(|(_, since)| mono.saturating_sub(*since) as i64)
                            .unwrap_or_else(|| {
                                dates::millis(now).unwrap_or(0) - dates::millis(&e.ts).unwrap_or(0)
                            });
                        age > max_ms
                    })
            });
            let direction = if stale || last.as_ref().is_none_or(|e| e.kind == "out") {
                "in"
            } else {
                "out"
            };
            let event_id = s.add_event(person.id, direction, now, Some(boot), Some(&receipt))?;
            next_check_in = Some((person.id, event_id, direction == "in"));
            Ok(Tap {
                status: "ok".into(),
                direction: direction.into(),
                name: person.person.name,
                time: now.into(),
                stale,
                ..base("ok")
            })
        })?;
        // Suppression follows a successful commit; a failed write must be retryable.
        if !tap.replayed && ["ok", "unknown", "inactive"].contains(&tap.status.as_str()) {
            self.repeats.insert(card.into(), mono);
        }
        if tap.status == "unknown" {
            self.forget_unknown(card);
            self.unknown.insert(0, (card.into(), now.into()));
            self.unknown.truncate(20);
        }
        if let Some((id, event_id, is_in)) = next_check_in {
            if is_in {
                self.check_ins.insert(id, (event_id, mono));
            } else {
                self.check_ins.remove(&id);
            }
        }
        Ok(tap)
    }
}

pub struct Reader {
    digits: String,
    last: Option<Instant>,
    started: bool,
    overflow: bool,
    pub reader_only: bool,
}
impl Reader {
    pub fn new(reader_only: bool) -> Self {
        Self {
            digits: String::new(),
            last: None,
            started: false,
            overflow: false,
            reader_only,
        }
    }
    pub fn reset(&mut self) {
        self.digits.clear();
        self.started = false;
        self.overflow = false;
    }
    // Some(card) completes a scan; used distinguishes a scanner Enter from a button Enter.
    pub fn key(&mut self, text: &str, modifier: bool, now: Instant) -> (bool, Option<String>) {
        if modifier {
            return (false, None);
        }
        let gap = self.last.map_or(std::time::Duration::MAX, |old| {
            now.saturating_duration_since(old)
        });
        self.last = Some(now);
        let mut chars = text.chars();
        let one = match (chars.next(), chars.next()) {
            (Some(c), None) => Some(c),
            _ => None,
        };
        if one.is_some_and(|c| c.is_ascii_digit()) {
            if self.reader_only && gap > std::time::Duration::from_millis(100) {
                self.digits.clear();
                self.overflow = false;
            }
            self.started = true;
            if !self.overflow {
                self.digits.push(one.unwrap());
                if self.digits.len() > 64 {
                    self.digits.clear();
                    self.overflow = true;
                }
            }
            (true, None)
        } else if matches!(one, Some('\r' | '\n')) {
            if !self.started {
                return (false, None);
            }
            let card = std::mem::take(&mut self.digits);
            self.started = false;
            self.overflow = false;
            (
                true,
                (!card.is_empty()
                    && (!self.reader_only || gap <= std::time::Duration::from_millis(100)))
                .then_some(card),
            )
        } else {
            self.reset();
            (false, None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Person;
    fn setup() -> (Store, Scanner) {
        let s = Store::memory().unwrap();
        s.create(
            &Person {
                name: "Ana".into(),
                student_id: "1".into(),
                section: "Web".into(),
                status: "Regular".into(),
                telegram: String::new(),
            },
            "001",
            true,
        )
        .unwrap();
        (s, Scanner::default())
    }
    #[test]
    fn uncertain_tap_replays_after_a_scanner_restart_without_toggling() {
        let (s, mut scanner) = setup();
        let first = scanner
            .tap(
                &s,
                "001",
                "boot",
                true,
                36_000_000,
                "2026-01-05T01:00:00.000Z",
                0,
            )
            .unwrap();
        let mut restarted = Scanner::default();
        let replay = restarted
            .tap(
                &s,
                "001",
                "boot",
                true,
                36_000_000,
                "2026-01-05T02:00:00.000Z",
                0,
            )
            .unwrap();
        assert!(replay.replayed);
        assert_eq!(replay.request_id, first.request_id);
        assert_eq!(s.events().unwrap().len(), 1);
        s.acknowledge("001", &replay.request_id).unwrap();
        let out = restarted
            .tap(
                &s,
                "001",
                "boot",
                true,
                36_000_000,
                "2026-01-05T02:00:00.000Z",
                6000,
            )
            .unwrap();
        assert_eq!(out.direction, "out");
    }
    #[test]
    fn repeats_use_monotonic_time_and_clock_refusals_do_not_suppress_retry() {
        let (s, mut scanner) = setup();
        let clock = scanner
            .tap(
                &s,
                "001",
                "boot",
                false,
                36_000_000,
                "2026-01-05T01:00:00.000Z",
                0,
            )
            .unwrap();
        assert_eq!(clock.status, "clock");
        s.acknowledge("001", &clock.request_id).unwrap();
        let first = scanner
            .tap(
                &s,
                "001",
                "boot",
                true,
                36_000_000,
                "2026-01-05T01:00:00.000Z",
                1,
            )
            .unwrap();
        s.acknowledge("001", &first.request_id).unwrap();
        let repeat = scanner
            .tap(
                &s,
                "001",
                "boot",
                true,
                36_000_000,
                "2026-01-06T01:00:00.000Z",
                1000,
            )
            .unwrap();
        assert_eq!(repeat.status, "ignored");
    }
    #[test]
    fn previous_boot_check_in_is_a_fresh_arrival() {
        let (s, mut scanner) = setup();
        s.add_event(1, "in", "2026-01-05T01:00:00.000Z", Some("old"), None)
            .unwrap();
        let tap = scanner
            .tap(
                &s,
                "001",
                "new",
                true,
                36_000_000,
                "2026-01-05T02:00:00.000Z",
                0,
            )
            .unwrap();
        assert_eq!(tap.direction, "in");
        assert!(tap.stale);
    }
    #[test]
    fn linux_reader_rejects_slow_typing_and_consumes_overflow_enter() {
        let mut r = Reader::new(true);
        let start = Instant::now();
        r.key("1", false, start);
        r.key("2", false, start + std::time::Duration::from_millis(200));
        assert_eq!(
            r.key("\n", false, start + std::time::Duration::from_millis(400)),
            (true, None)
        );
        for n in 0..65 {
            r.key(
                "1",
                false,
                start + std::time::Duration::from_secs(1) + std::time::Duration::from_millis(n),
            );
        }
        assert_eq!(
            r.key("\n", false, start + std::time::Duration::from_millis(1066)),
            (true, None)
        );
        assert_eq!(
            r.key("\n", false, start + std::time::Duration::from_millis(1067)),
            (false, None)
        );
    }
}
