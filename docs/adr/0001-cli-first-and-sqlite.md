# ADR 0001: Start with a CLI and SQLite

## Status

Accepted for the MVP.

## Context

The project needs to validate the orchestration loop before adding web deployment, multiple services, or distributed infrastructure. The first user is a developer running the system locally.

## Decision

Use a Typer CLI as the first interface and SQLite in WAL mode as the durable local state store. Keep the state store behind a small module boundary so a later Postgres implementation can replace it.

## Consequences

- The MVP is easy for three students to run, debug, test, and demo locally.
- Restart recovery can be tested without operating Redis, Postgres, Docker, or a web service.
- It is not a multi-user or distributed production architecture. Those requirements belong to a later phase after the task protocol and workflow are proven.
