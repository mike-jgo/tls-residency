pub mod config;
pub mod core;
pub mod dates;
pub mod machine;
pub mod model;
pub mod roster;
pub mod scan;
pub mod sheet_layout;
pub mod sheets;
pub mod store;
pub mod sync;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[cfg(test)]
pub(crate) mod test_support;
#[cfg(test)]
mod scan_parity;
#[cfg(test)]
mod sync_parity;
#[cfg(test)]
mod roster_parity;
#[cfg(test)]
mod hours_parity;
#[cfg(test)]
mod dates_parity;
#[cfg(test)]
mod sheets_parity;
