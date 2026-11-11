use chrono::{
    DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Utc,
};
use chrono_tz::Tz;

pub fn iso(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Millis, true)
}
pub fn now() -> String {
    iso(Utc::now())
}
pub fn millis(time: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(time)
        .ok()
        .map(|t| t.timestamp_millis())
}

#[derive(Debug, Clone, Copy)]
pub struct Dates(pub Tz);
impl Dates {
    pub fn new(zone: &str) -> crate::Result<Self> {
        Ok(Self(zone.parse::<Tz>()?))
    }
    pub fn stamp(self, time: &str) -> crate::Result<String> {
        Ok(DateTime::parse_from_rfc3339(time)?
            .with_timezone(&self.0)
            .format("%Y-%m-%d %H:%M:%S")
            .to_string())
    }
    pub fn time(self, time: &str) -> String {
        DateTime::parse_from_rfc3339(time)
            .map(|t| t.with_timezone(&self.0).format("%I:%M %p").to_string())
            .unwrap_or_default()
    }
    pub fn full(self, time: &str) -> String {
        DateTime::parse_from_rfc3339(time)
            .map(|t| {
                t.with_timezone(&self.0)
                    .format("%m/%d/%Y, %I:%M:%S %p")
                    .to_string()
            })
            .unwrap_or_default()
    }
    pub fn clock(self) -> String {
        Utc::now()
            .with_timezone(&self.0)
            .format("%a, %b %-d, %I:%M %p")
            .to_string()
    }
    fn midnight(self, day: NaiveDate) -> crate::Result<String> {
        self.0
            .from_local_datetime(&day.and_hms_opt(0, 0, 0).unwrap())
            .earliest()
            .map(|t| iso(t.with_timezone(&Utc)))
            .ok_or_else(|| "That day has no midnight in the configured timezone.".into())
    }
    pub fn day(text: &str) -> crate::Result<NaiveDate> {
        let day = NaiveDate::parse_from_str(text, "%Y-%m-%d")
            .map_err(|_| "Use a valid date in YYYY-MM-DD format.")?;
        if day.format("%Y-%m-%d").to_string() != text {
            return Err("Use dates in YYYY-MM-DD format.".into());
        }
        Ok(day)
    }
    pub fn bounds(self, start: &str, end: &str) -> crate::Result<(Option<String>, Option<String>)> {
        let from = if start.is_empty() {
            None
        } else {
            Some(Self::day(start)?)
        };
        let to = if end.is_empty() {
            None
        } else {
            Some(Self::day(end)?)
        };
        if matches!((from,to), (Some(a),Some(b)) if a > b) {
            return Err("The From date is after the To date.".into());
        }
        Ok((
            from.map(|d| self.midnight(d)).transpose()?,
            to.map(|d| self.midnight(d + Duration::days(1)))
                .transpose()?,
        ))
    }
    pub fn instant(self, date: &str, time: &str) -> crate::Result<String> {
        let day = Self::day(date)?;
        let time = chrono::NaiveTime::parse_from_str(
            time,
            if time.matches(':').count() == 1 {
                "%H:%M"
            } else {
                "%H:%M:%S"
            },
        )?;
        self.0
            .from_local_datetime(&NaiveDateTime::new(day, time))
            .earliest()
            .map(|d| iso(d.with_timezone(&Utc)))
            .ok_or_else(|| "That local date and time do not exist.".into())
    }
    pub fn month(self, time: &str) -> crate::Result<(i32, u32)> {
        let date = DateTime::parse_from_rfc3339(time)?.with_timezone(&self.0);
        Ok((date.year(), date.month()))
    }
    pub fn title(y: i32, m: u32) -> String {
        NaiveDate::from_ymd_opt(y, m, 1)
            .map(|d| d.format("%B %Y").to_string())
            .unwrap_or_default()
    }
    pub fn month_of_title(title: &str) -> Option<(i32, u32)> {
        let title = title.strip_suffix(" Logs").unwrap_or(title);
        let date = NaiveDate::parse_from_str(&format!("1 {title}"), "%d %B %Y").ok()?;
        if Self::title(date.year(), date.month()) != title {
            return None;
        }
        Some((date.year(), date.month()))
    }
    pub fn month_bounds(self, y: i32, m: u32) -> crate::Result<(String, String)> {
        let next = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
        Ok((
            self.midnight(NaiveDate::from_ymd_opt(y, m, 1).ok_or("Invalid month.")?)?,
            self.midnight(NaiveDate::from_ymd_opt(next.0, next.1, 1).ok_or("Invalid month.")?)?,
        ))
    }
    pub fn months(self, a: &str, b: &str) -> crate::Result<Vec<(i32, u32)>> {
        let (mut start, mut end) = (self.month(a)?, self.month(b)?);
        if start > end {
            std::mem::swap(&mut start, &mut end);
        }
        let mut out = vec![];
        while start <= end {
            out.push(start);
            start = if start.1 == 12 {
                (start.0 + 1, 1)
            } else {
                (start.0, start.1 + 1)
            };
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manila_ranges_are_inclusive_and_independent_of_host_zone() {
        let dates = Dates::new("Asia/Manila").unwrap();
        assert_eq!(
            dates.bounds("2026-01-05", "2026-01-05").unwrap(),
            (
                Some("2026-01-04T16:00:00.000Z".into()),
                Some("2026-01-05T16:00:00.000Z".into())
            )
        );
        assert!(dates.bounds("2026-02-30", "").is_err());
        assert!(dates.bounds("2026-01-06", "2026-01-05").is_err());
        assert_eq!(
            dates.instant("2026-01-05", "9:30").unwrap(),
            "2026-01-05T01:30:00.000Z"
        );
    }
    #[test]
    fn month_titles_and_year_boundaries_match_the_sheet() {
        let dates = Dates::new("Asia/Manila").unwrap();
        assert_eq!(
            Dates::month_of_title("November 2026 Logs"),
            Some((2026, 11))
        );
        assert_eq!(
            dates.month_bounds(2026, 12).unwrap().1,
            "2026-12-31T16:00:00.000Z"
        );
    }
}
