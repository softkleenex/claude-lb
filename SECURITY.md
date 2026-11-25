# Security policy

claude-lb holds upstream API credentials and can spend money with them, so security reports
are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository.

Include:
- the version (`claude-lb --version`) and how it is deployed (local, Docker, behind a proxy)
- the steps to reproduce, and what an attacker gains

You will get an acknowledgement within a few days. A fix ships in a patch release, and the
changelog credits the reporter unless they ask not to be named.

## Supported versions

Only the latest minor release gets security fixes.

## What is in scope

- Reading or using stored upstream credentials without operator access
- Bypassing dashboard auth, the bootstrap window, or the cross-site write guard
- Using one `clb_` key to exceed its budget or act as another key
- Making claude-lb send a client's or operator's secret upstream, or to a third party

## Deployment notes

- Keep the default `CLAUDE_LB_HOST=127.0.0.1` unless you put claude-lb behind TLS.
- Set a dashboard password before exposing the port. Until one exists, the management plane is
  reachable only from loopback, or with the one-time bootstrap token printed at startup.
- Back up `secret.key` together with the database, and keep it as private as the credentials
  it protects.
