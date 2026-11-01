# The saves server, for Cloud Run (built from cloud/: `gcloud run deploy --source .`).
# Built on the same Debian as the runtime image below (its C library must be as old or older).
FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release --locked -p opensmith-cloud-server

# A C runtime and CA certificates, nothing else; runs as a non-root user.
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /src/target/release/opensmith-cloud-server /server
ENV PORT=8080
ENTRYPOINT ["/server"]
