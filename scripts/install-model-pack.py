#!/usr/bin/env python
"""Install a model pack (D3).

A pack is a directory with weights, a license and a `pack.json` beside them
(`agents/deckastra_agents/model_packs.py`). Installing one by hand means writing
that manifest correctly, and the failure mode of getting it wrong is a pack the
product silently does not list — so this writes it.

    python scripts/install-model-pack.py \
        --repo Qwen/Qwen3-4B-GGUF --file Qwen3-4B-Q4_K_M.gguf \
        --id qwen3-4b-q4 --root D:/deckastra-models

Three things it does that a `curl` would not:

- **Resumes.** These are gigabytes over a connection that may not last, and
  starting again from zero is how a download gets abandoned.
- **Verifies.** HuggingFace serves the LFS object's sha256 in `X-Linked-Etag`,
  so the bytes can be checked against what the repository says they are rather
  than against their length. A truncated model loads and then produces nonsense,
  which is the worst way to learn a download failed.
- **Writes the manifest last.** The manifest is what makes a directory a pack, so
  writing it only after the weights verify means an interrupted install is
  *visibly* incomplete rather than a pack that fails at load time.

`--from-file` installs weights that arrived some other way — copied from another
machine, or fetched by something with better network luck. It is not only a
convenience: on the machine this was written on, `huggingface.co` resolves and
the CDN host that serves the bytes (`us.aws.cdn.hf.co`) does not, so the
*metadata* is reachable while the file is not. The digest still comes from
HuggingFace and the bytes still get checked against it — which is a better
verification than trusting a file someone copied off a USB stick.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

HF = "https://huggingface.co"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: D102 - urllib's own signature
        return None


def head(url: str) -> dict[str, str]:
    """What the repository says about a file, without going to fetch it.

    Deliberately does *not* follow the redirect. For an LFS object HuggingFace
    answers 302 from `huggingface.co` and puts the real size and digest on that
    response as `X-Linked-Size` and `X-Linked-Etag`; following the redirect asks
    the CDN instead, which is a different host — and on a network where that host
    is blocked, following it loses facts that were already in hand. Losing them
    silently turned the size check into nothing, and a 12-byte file installed as
    a 2.3GB model.
    """
    opener = urllib.request.build_opener(_NoRedirect)
    request = urllib.request.Request(url, method="HEAD")
    try:
        with opener.open(request, timeout=60) as answer:
            headers, status = answer.headers, answer.status
    except urllib.error.HTTPError as redirect:
        if redirect.status not in (301, 302, 303, 307, 308):
            raise
        headers, status = redirect.headers, redirect.status
    found = {key.lower(): value for key, value in headers.items()}
    # `content-length` on a redirect describes the redirect, not the file — 236
    # bytes of "you want it over there". Only `X-Linked-Size` means the object.
    found["_size"] = found.get("x-linked-size") or (
        found.get("content-length") if status == 200 else None
    )
    return found


def download(url: str, target: Path, expected_size: int) -> None:
    """Fetch `url` into `target`, resuming whatever is already there."""
    have = target.stat().st_size if target.exists() else 0
    if have == expected_size:
        print(f"  {target.name}: already complete ({have:,} bytes)")
        return
    if have > expected_size:
        print(f"  {target.name}: larger than expected, starting again")
        target.unlink()
        have = 0

    request = urllib.request.Request(url)
    if have:
        request.add_header("Range", f"bytes={have}-")
        print(f"  {target.name}: resuming at {have:,} of {expected_size:,}")

    with urllib.request.urlopen(request, timeout=120) as answer:
        mode = "ab" if have and answer.status == 206 else "wb"
        if mode == "wb":
            have = 0
        with open(target, mode) as sink:
            last = have
            while chunk := answer.read(1 << 20):
                sink.write(chunk)
                have += len(chunk)
                if have - last > 100 << 20:
                    last = have
                    print(f"  {target.name}: {have:,} / {expected_size:,}", flush=True)

    if target.stat().st_size != expected_size:
        raise SystemExit(
            f"{target.name} is {target.stat().st_size:,} bytes, expected {expected_size:,}."
        )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        while chunk := source.read(1 << 22):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="HuggingFace repository, owner/name")
    parser.add_argument("--file", required=True, help="The .gguf file in that repository")
    parser.add_argument("--id", required=True, help="Pack id, used as the directory name")
    parser.add_argument("--root", required=True, help="Where packs are installed")
    parser.add_argument("--name", default=None, help="Display name")
    parser.add_argument("--context", type=int, default=32_768)
    parser.add_argument("--license", default=None, help="Overrides the repository's declared license")
    parser.add_argument("--min-ram-mb", type=int, default=None)
    parser.add_argument("--license-file", default="LICENSE")
    parser.add_argument(
        "--from-file",
        default=None,
        help="Install weights already on this machine instead of downloading them. "
        "Still verified against the digest the repository publishes.",
    )
    parser.add_argument("--sha256", default=None, help="Expected digest, when the repository cannot be reached")
    arguments = parser.parse_args()

    try:
        with urllib.request.urlopen(f"{HF}/api/models/{arguments.repo}", timeout=60) as answer:
            model = json.load(answer)
    except Exception as error:  # noqa: BLE001
        if not arguments.from_file:
            raise
        # Installing from a local file, with no way to ask about the repository.
        # Everything the manifest needs must then be on the command line.
        print(f"  {arguments.repo} is not reachable ({error}); using what was passed in")
        model = {}
    declared = arguments.license or (model.get("cardData") or {}).get("license")
    if not declared:
        # The manifest requires it, so refusing here is better than writing a
        # pack the product will not list and leaving someone to work out why.
        raise SystemExit(
            f"{arguments.repo} does not declare a license. Pass --license with the terms "
            "the weights are actually under."
        )

    directory = Path(arguments.root) / arguments.id
    directory.mkdir(parents=True, exist_ok=True)
    weights_url = f"{HF}/{arguments.repo}/resolve/main/{arguments.file}"

    size = 0
    expected_digest = arguments.sha256 or ""
    try:
        headers = head(weights_url)
        size = int(headers.get("_size") or 0)
        # The LFS object id, which for an LFS file is the sha256 of the content.
        # A file stored in git rather than LFS reports its *git blob SHA-1* here
        # instead — 40 hex characters, and not a digest of the bytes at all — so
        # comparing it to a sha256 fails every time and for the wrong reason.
        published = (headers.get("x-linked-etag") or "").strip('"').removeprefix("sha256:")
        if len(published) == 64:
            expected_digest = published or expected_digest
    except Exception as error:  # noqa: BLE001
        if not arguments.from_file:
            raise
        print(f"  could not ask {arguments.repo} about {arguments.file} ({error})")

    weights = directory / "model.gguf"

    if arguments.from_file:
        source = Path(arguments.from_file)
        if not source.is_file():
            raise SystemExit(f"{source} is not a file.")
        if size and source.stat().st_size != size:
            raise SystemExit(
                f"{source.name} is {source.stat().st_size:,} bytes and {arguments.repo} "
                f"publishes {size:,}. This is not that file, or it is incomplete."
            )
        print(f"{arguments.id}: installing {source} ({source.stat().st_size:,} bytes)")
        if source.resolve() != weights.resolve():
            import shutil

            shutil.copyfile(source, weights)
    else:
        if not size:
            raise SystemExit(f"{weights_url} did not report a size.")
        print(f"{arguments.id}: {arguments.file} ({size:,} bytes) from {arguments.repo}")
        download(weights_url, weights, size)

    if not expected_digest and not size:
        # Neither check was possible. Said plainly, because "installed" after
        # this line means "copied", and a truncated model loads and then produces
        # nonsense — the worst way to find out.
        print(
            f"  WARNING: {arguments.repo} published neither a size nor a digest for "
            f"{arguments.file}, so these bytes were not checked against anything."
        )

    if expected_digest:
        print("  verifying…", flush=True)
        actual = sha256(weights)
        if actual != expected_digest:
            weights.unlink()
            raise SystemExit(
                f"{arguments.file} does not match the digest {arguments.repo} publishes.\n"
                f"  expected {expected_digest}\n  got      {actual}\n"
                "The partial file has been removed; run this again."
            )
        print(f"  sha256 {actual[:16]}… matches")
    elif size:
        print(f"  no digest published; size matches ({size:,} bytes)")

    license_name = arguments.license_file
    try:
        if arguments.from_file and not size:
            raise RuntimeError("the repository is not reachable")
        license_url = f"{HF}/{arguments.repo}/resolve/main/{license_name}"
        download(license_url, directory / "LICENSE.txt", int(head(license_url)["_size"]))
        license_file = "LICENSE.txt"
    except Exception as error:  # noqa: BLE001 - an absent license file is not fatal
        print(f"  no license file fetched ({error}); the manifest still names the terms")
        license_file = None

    manifest = {
        "id": arguments.id,
        "name": arguments.name or arguments.id,
        "weights": "model.gguf",
        "context_tokens": arguments.context,
        "quantization": arguments.file.split("-")[-1].removesuffix(".gguf"),
        "license": declared,
        "source": f"{arguments.repo}/{arguments.file}",
        "sha256": expected_digest or None,
    }
    if arguments.min_ram_mb:
        manifest["min_ram_mb"] = arguments.min_ram_mb
    if license_file:
        manifest["license_file"] = license_file

    # Last, so an interrupted install leaves a directory that is visibly not a
    # pack rather than a pack that fails when something tries to load it.
    (directory / "pack.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"  installed at {directory}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
