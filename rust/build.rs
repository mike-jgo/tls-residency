fn main() {
    slint_build::compile_with_config(
        "ui/station.slint",
        slint_build::CompilerConfiguration::new()
            .with_style("fluent".into())
            .with_debug_info(std::env::var("PROFILE").as_deref() == Ok("debug")),
    )
    .expect("ui/station.slint should compile");
}
