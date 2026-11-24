FROM rust:1-alpine AS builder
RUN apk add --no-cache musl-dev pkgconfig
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY migrations ./migrations
COPY src ./src
RUN cargo build --release --bin workshop-backend

FROM alpine:3.21
RUN apk add --no-cache ca-certificates libgcc
WORKDIR /app
COPY --from=builder /app/target/release/workshop-backend /app/workshop-backend
ENV BIND_ADDR=0.0.0.0:3001
EXPOSE 3001
CMD ["/app/workshop-backend"]
