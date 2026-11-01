FROM ubuntu:22.04

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       ca-certificates git curl vim net-tools iproute2 htop wget build-essential \
       python3 telnet iputils-ping \
    && rm -rf /var/lib/apt/lists/*
