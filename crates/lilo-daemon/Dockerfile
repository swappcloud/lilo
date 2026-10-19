FROM rust:1.90-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libdbus-1-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /source
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY src-tauri/Cargo.toml ./src-tauri/Cargo.toml
COPY src-tauri/src/lib.rs src-tauri/src/main.rs ./src-tauri/src/
RUN cargo build --release --jobs 1 -p lilo-daemon

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libdbus-1-3 libpulse0 mpv unzip libpocketsphinx3 pocketsphinx-en-us pulseaudio-utils && rm -rf /var/lib/apt/lists/*
COPY --from=build /source/target/release/lilo-daemon /usr/local/bin/lilo-daemon
COPY .tmp/daemon-web /opt/lilo/management
COPY examples/plugins /opt/lilo/marketplace
ENV LILO_BUNDLED_MARKETPLACE=/opt/lilo/marketplace
USER 1000:1000
ENTRYPOINT ["lilo-daemon"]
CMD ["--data-dir", "/data", "--manage", "0.0.0.0:8788", "--manage-web", "/opt/lilo/management"]
