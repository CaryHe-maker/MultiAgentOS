FROM python:3.12-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git procps > /dev/null && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN git init -q -b main . && git config --global user.email agent@example.com && git config --global user.name agent && git config --global --add safe.directory /app && git commit -q --allow-empty -m "start"
