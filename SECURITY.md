# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/INDIETRACK-TEAM-Prometheus/project-prometheus/security/advisories/new), not in a
public issue. Include the steps to reproduce and the affected files. You should get a reply within a few days.

## Scope and design

- The server listens on `127.0.0.1` only (HTTP, or HTTPS when a local certificate is configured). It is not meant to
  be exposed to a network.
- The Meta Model API key is read from the server's environment and never sent to the browser.
- API routes accept only same-origin loopback requests and validate every request body before calling a provider.
- Local model workers run as child processes and receive only validated JSON requests.

## Keys and data

Never paste API keys, tokens or dataset files into issues, pull requests or logs. If a key is exposed, revoke it in
the Meta developer console right away.
