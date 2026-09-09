#!/usr/bin/env python3
"""Install the pinned official release; never rewrite the manifest or acquisition proof.

Maintainer use only: python3 scripts/vendor-rclone.py [--archive-dir /path/to/cache]
The cache is optional. Every cached or downloaded archive must match the upstream
SHA256SUMS pin before extraction; every executable must match manifest.json.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import urllib.request
import zipfile


VERSION = "v1.75.0"
BASE_URL = f"https://downloads.rclone.org/{VERSION}"
# Pinned from https://downloads.rclone.org/v1.75.0/SHA256SUMS.
ARCHIVES = {
    "darwin-arm64": (
        "osx-arm64",
        "35e8f2a666ce789b29111db0dd843ddabc0d59c6b609d07bcaae5d1a07cba6f8",
    ),
    "darwin-x64": (
        "osx-amd64",
        "19edbb8e5e73096eb66e92a42abbc5c34bfa8981ea3986a53872c7eef85a22f4",
    ),
    "linux-arm64": (
        "linux-arm64",
        "d0ad88ba4c8e285b7c9efa591e0ab643280a91741e13c27f3a9c0957ccfa5203",
    ),
    "linux-x64": (
        "linux-amd64",
        "aa2804e08f48250e71009c727124b6341cd0288465804a9a09d14663cabafbaa",
    ),
    "win32-arm64": (
        "windows-arm64",
        "bcf628fa6bb3b6ae9fdf105d04acafb40ec77841f686dc6dd7d126dde04c5f6a",
    ),
    "win32-x64": (
        "windows-amd64",
        "203581f0a7baeae873f2347483a798c79e2eaf5c384a4e9d866aa374f1c89ac0",
    ),
}
# These release ZIPs have no standalone license. Preserve the official COPYING
# from the same release tag, byte-for-byte, under the package's LICENSE name.
LICENSE_URL = "https://raw.githubusercontent.com/rclone/rclone/v1.75.0/COPYING"
LICENSE_SHA256 = "8cd2e9e750b90a04b7d82dbbca3930c696ae0309d7c10464f90a44f45754cd04"
CHUNK_SIZE = 1024 * 1024


def digest_stream(source, destination=None):
    digest = hashlib.sha256()
    size = 0
    for chunk in iter(lambda: source.read(CHUNK_SIZE), b""):
        digest.update(chunk)
        size += len(chunk)
        if destination is not None:
            destination.write(chunk)
    return digest.hexdigest(), size


def package_path(root, relative):
    parts = relative.split("/")
    if any(part in ("", ".", "..") or "\\" in part or ":" in part for part in parts):
        raise ValueError(f"Unsafe package-relative path: {relative}")
    target = root
    for part in parts:
        target = target / part
        if target.is_symlink():
            raise ValueError(f"Symlinks are not allowed in vendor paths: {target}")
    target.resolve().relative_to(root)
    return target


def download(url, target):
    with urllib.request.urlopen(url, timeout=120) as response, target.open("xb") as output:
        return digest_stream(response, output)


def load_manifest(root):
    manifest_path = package_path(root, "vendor/rclone/manifest.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (
        not isinstance(manifest, dict)
        or set(manifest) != {"schemaVersion", "version", "binaries"}
        or type(manifest["schemaVersion"]) is not int
        or manifest["schemaVersion"] != 1
        or manifest["version"] != VERSION
        or not isinstance(manifest["binaries"], dict)
        or set(manifest["binaries"]) != set(ARCHIVES)
    ):
        raise ValueError("Manifest must pin exactly the six supported v1.75.0 cells")
    for cell, (release, _) in ARCHIVES.items():
        executable = "rclone.exe" if cell.startswith("win32-") else "rclone"
        entry = manifest["binaries"][cell]
        if (
            not isinstance(entry, dict)
            or set(entry) != {"path", "sha256", "provenance"}
            or entry["path"] != f"vendor/rclone/{release}/{executable}"
            or entry["provenance"] != f"{BASE_URL}/rclone-{VERSION}-{release}.zip"
            or not isinstance(entry["sha256"], str)
            or re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]) is None
        ):
            raise ValueError(f"Invalid immutable manifest entry: {cell}")
    return manifest


def stage_executable(archive_path, member, destination, expected_sha256):
    with zipfile.ZipFile(archive_path) as archive:
        matches = [entry for entry in archive.infolist() if entry.filename == member]
        if len(matches) != 1:
            raise ValueError(f"Expected exactly one executable member: {member}")
        entry = matches[0]
        if entry.is_dir() or stat.S_ISLNK(entry.external_attr >> 16):
            raise ValueError(f"Executable archive member is not a regular file: {member}")
        with archive.open(entry) as source, destination.open("xb") as output:
            actual_sha256, size = digest_stream(source, output)
    if actual_sha256 != expected_sha256:
        raise ValueError(f"Executable checksum differs from immutable manifest: {member}")
    return actual_sha256, size


def install_file(source, destination, mode):
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as output:
            temporary = Path(output.name)
            with source.open("rb") as input_file:
                for chunk in iter(lambda: input_file.read(CHUNK_SIZE), b""):
                    output.write(chunk)
        temporary.chmod(mode)
        os.replace(temporary, destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--archive-dir",
        type=Path,
        help="Reuse checksum-verified release ZIPs here; download missing ZIPs privately",
    )
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    manifest = load_manifest(root)
    proof_path = package_path(root, "vendor/rclone/acquisition.json")
    expected_proof = json.loads(proof_path.read_text(encoding="utf-8"))
    proof = {
        "schemaVersion": 1,
        "version": VERSION,
        "archiveChecksumsUrl": f"{BASE_URL}/SHA256SUMS",
        "binaries": {},
    }
    installs = []
    with tempfile.TemporaryDirectory(prefix="migmate-rclone-") as temporary:
        staging = Path(temporary)
        for cell, (release, archive_sha256) in ARCHIVES.items():
            entry = manifest["binaries"][cell]
            archive_name = f"rclone-{VERSION}-{release}.zip"
            cached = args.archive_dir / archive_name if args.archive_dir is not None else None
            if cached is not None and cached.is_file():
                archive_path = cached
                with archive_path.open("rb") as source:
                    actual_archive_sha256, archive_size = digest_stream(source)
            else:
                archive_path = staging / archive_name
                actual_archive_sha256, archive_size = download(entry["provenance"], archive_path)
            if actual_archive_sha256 != archive_sha256:
                raise ValueError(f"Archive checksum differs from pinned SHA256SUMS: {archive_name}")
            executable = "rclone.exe" if cell.startswith("win32-") else "rclone"
            member = f"rclone-{VERSION}-{release}/{executable}"
            staged_executable = staging / f"{cell}-{executable}"
            executable_sha256, executable_size = stage_executable(
                archive_path, member, staged_executable, entry["sha256"]
            )
            proof["binaries"][cell] = {
                "sourceUrl": entry["provenance"],
                "archiveSha256": actual_archive_sha256,
                "archiveSize": archive_size,
                "executablePath": entry["path"],
                "executableMember": member,
                "executableSha256": executable_sha256,
                "executableSize": executable_size,
            }
            installs.append((staged_executable, entry["path"], 0o755))
        staged_license = staging / "LICENSE"
        license_sha256, license_size = download(LICENSE_URL, staged_license)
        if license_sha256 != LICENSE_SHA256:
            raise ValueError("Official release COPYING checksum differs from the license pin")
        proof["license"] = {
            "sourceUrl": LICENSE_URL,
            "path": "vendor/rclone/LICENSE",
            "sha256": license_sha256,
            "size": license_size,
        }
        if proof != expected_proof:
            raise ValueError("Acquisition differs from the committed immutable acquisition proof")
        installs.append((staged_license, proof["license"]["path"], 0o644))
        # All six binaries and the license are authenticated before any installation.
        for source, relative, mode in installs:
            install_file(source, package_path(root, relative), mode)
    print(json.dumps(proof, indent=2))


if __name__ == "__main__":
    main()
