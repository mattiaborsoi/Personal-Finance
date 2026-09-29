"""Settl maintenance: a one-shot clean-up run by the ``maintenance`` Compose service.

Removes dangling images labelled ``com.settl.project=settl`` (the previous builds of
Settl's own images, left untagged when an update rebuilds them) and exits. It never
prunes unlabelled images, images of other projects, tagged or in-use images or the
build cache, and it always exits 0 so a failed clean-up never gets in the way of an
update.
"""

from __future__ import annotations

import subprocess

LABEL = "com.settl.project=settl"
COMMAND = ["docker", "image", "prune", "--force", "--filter", f"label={LABEL}"]


def main() -> int:
    print(f"$ {' '.join(COMMAND)}", flush=True)
    try:
        result = subprocess.run(COMMAND, capture_output=True, text=True, timeout=600, check=False)
    except Exception as exc:  # noqa: BLE001 - never fail the update over a clean-up
        print(f"image clean-up skipped: {exc}", flush=True)
        return 0
    output = (result.stdout or "").strip() or "nothing to remove"
    print(output, flush=True)
    if result.returncode != 0:
        print(f"image clean-up failed (status {result.returncode}): {(result.stderr or '').strip()}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
