# Static musl binary on an empty base image: ~2 MB image, no shell, no libc.
FROM rust:1.93-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src src
COPY assets assets
RUN cargo build --release --locked

FROM scratch
COPY --from=build /src/target/release/autter-runtime-dashboard /autter-runtime-dashboard
USER 65534:65534
ENV DASHBOARD_ADDR=0.0.0.0:4319
EXPOSE 4319
ENTRYPOINT ["/autter-runtime-dashboard"]
