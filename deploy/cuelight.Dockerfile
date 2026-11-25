FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://github.com/selfdrivingjazz/cuelight/releases/download/v0.2.10/cuelight-control_0.2.10_linux_amd64.tar.gz -o /tmp/cuelight.tar.gz \
 && echo 'da7a7c626530ce5e066e19ecbe86d6093adf5d3ca9557df05d3e81bbad0f9e6b  /tmp/cuelight.tar.gz' | sha256sum -c - \
 && tar -xzf /tmp/cuelight.tar.gz -C /usr/local/bin cuelight-control && rm /tmp/cuelight.tar.gz
COPY --chmod=755 init-cuelight run-cuelight /usr/local/bin/
ENTRYPOINT ["/usr/local/bin/run-cuelight"]
CMD ["serve"]
