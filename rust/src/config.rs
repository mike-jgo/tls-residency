use crate::{dates::Dates, Result};
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    pub db_path: PathBuf,
    pub backup_dir: PathBuf,
    pub backup_keep: usize,
    pub key_file: PathBuf,
    pub spreadsheet_id: String,
    pub admin_user: String,
    pub admin_password: String,
    pub dates: Dates,
    pub max_session_ms: i64,
}
impl Config {
    pub fn from_env() -> Result<Self> {
        let _ = dotenvy::dotenv();
        let get = |key: &str, default: &str| std::env::var(key).unwrap_or_else(|_| default.into());
        let data = PathBuf::from(get("DATA_DIR", "data"));
        let hours: f64 = get("MAX_SESSION_HOURS", "12").parse()?;
        if !hours.is_finite() || hours <= 0.0 || hours > 8760.0 {
            return Err("MAX_SESSION_HOURS must be a positive number no greater than 8760.".into());
        }
        let spreadsheet_id = spreadsheet_id_from(&get("SHEETS_SPREADSHEET_ID", ""));
        if !spreadsheet_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err("The spreadsheet ID is not valid.".into());
        }
        let db_path = std::env::var_os("DB_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| data.join("residency.db"));
        let backup_dir = std::env::var_os("BACKUP_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| data.join("backups"));
        let backup_keep: usize = get("BACKUP_KEEP", "60").parse()?;
        if backup_keep == 0 {
            return Err("BACKUP_KEEP must be at least 1.".into());
        }
        Ok(Self {
            db_path,
            backup_dir,
            backup_keep,
            key_file: std::env::var_os("GOOGLE_SERVICE_ACCOUNT_KEY")
                .map(PathBuf::from)
                .unwrap_or_else(|| data.join("service-account.json")),
            spreadsheet_id,
            admin_user: get("ADMIN_USER", "admin"),
            admin_password: get("ADMIN_PASSWORD", "changeme"),
            dates: Dates::new(&get("TZ", "Asia/Manila"))?,
            max_session_ms: (hours * 3_600_000.0).round() as i64,
        })
    }
}

/// The spreadsheet setting may be the ID or the sheet's whole address.
pub fn spreadsheet_id_from(setting: &str) -> String {
    let sheet = setting.trim();
    sheet
        .split("/spreadsheets/d/")
        .nth(1)
        .map(|s| s.split('/').next().unwrap_or_default())
        .unwrap_or(sheet)
        .to_string()
}
