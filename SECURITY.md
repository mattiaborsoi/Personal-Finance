# Security

Settl handles bank statements, so security reports are welcome and taken
seriously.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Use GitHub's
private reporting instead: on the repository page, **Security → Report a
vulnerability**. Include what you found, how to reproduce it and what an
attacker could do with it. You will get an acknowledgement, and a fix or a
mitigation as soon as one is ready; credit is given in the release notes if
you want it.

## Scope and model

Settl is designed to run on a machine on your own network, behind two shared
passwords, and is not meant to be exposed to the internet. Reports about the
following are especially useful:

* anything that lets a request bypass the primary / secondary role split;
* anything that leaks statement contents, uploaded files, provider keys or the
  proxy key to the browser, to logs or to a third party;
* prompt-injection paths from statement text into the model calls;
* the updater sidecar (it holds the Docker socket): any way to reach its
  `/update` endpoint without the `X-Updater-Token` the backend derives from
  `SECRET_KEY` (docs/TECHNICAL.md, "Updating"), or to reach it from outside the
  Compose network.

Findings that assume the host itself is compromised, or that require the
attacker to already hold the primary password, are out of scope.
