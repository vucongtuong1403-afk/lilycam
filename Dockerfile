# LilyCam (Rust) — build đa tầng: biên dịch bằng rust, chạy trên Debian slim
FROM rust:1-bookworm AS build
WORKDIR /src
COPY rust/Cargo.toml rust/Cargo.lock ./
RUN mkdir src && echo 'fn main(){}' > src/main.rs && cargo build --release && rm -rf src
COPY rust/src ./src
RUN touch src/main.rs && cargo build --release

# Runtime Debian trixie: libva 2.22 mới có symbol vaMapBuffer2 mà ffmpeg BtbN
# cần cho VAAPI (bookworm/libva 2.17 thiếu symbol này → không bật được GPU).
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates tzdata libstdc++6 curl \
      libdrm2 libva2 libva-drm2 intel-media-va-driver \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV TZ=Asia/Ho_Chi_Minh PORT=8790
COPY --from=build /src/target/release/lilycam /app/lilycam
COPY public /app/public
COPY bin/ffmpeg /app/bin/ffmpeg
COPY bin/dahua-pb /app/bin/dahua-pb
COPY bin/lark-cli /app/bin/lark-cli
RUN chmod +x /app/bin/lark-cli /app/bin/dahua-pb /app/bin/ffmpeg /app/lilycam
COPY sdk /app/sdk
COPY data.example /app/data.example
RUN mkdir -p /app/data && cp -n /app/data.example/* /app/data/ 2>/dev/null || true
EXPOSE 8790
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS http://127.0.0.1:8790/api/health || exit 1
CMD ["/app/lilycam"]
