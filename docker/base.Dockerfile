FROM ubuntu:22.04

ENV LANG=zh_CN.UTF-8 \
    LANGUAGE=zh_CN:zh \
    TZ=Asia/Shanghai

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       ca-certificates git curl vim net-tools iproute2 htop wget build-essential \
       python3 telnet iputils-ping locales tzdata \
    && locale-gen zh_CN.UTF-8 \
    && ln -snf "/usr/share/zoneinfo/$TZ" /etc/localtime \
    && printf '%s\n' "$TZ" > /etc/timezone \
    && rm -rf /var/lib/apt/lists/*
