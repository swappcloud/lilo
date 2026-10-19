use super::{App, Failure};
pub(super) fn discover() -> Result<Vec<App>, Failure> {
    Err(Failure::unavailable())
}
pub(super) fn open(_: &App) -> Result<(), Failure> {
    Err(Failure::unavailable())
}
pub(super) fn type_text(_: &App, _: &str) -> Result<(), Failure> {
    Err(Failure::unavailable())
}
