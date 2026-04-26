#!/usr/bin/env python3
"""Repack the plugin tar.gz with executable bits on linux/darwin server binaries."""
import os
import sys
import tarfile

PLUGIN_NAME = "boards"
DIST_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist")
SRC_ROOT = os.path.join(DIST_DIR, PLUGIN_NAME)

# Files that must have +x in the final archive.
EXEC_SUFFIXES = (
    "plugin-linux-amd64",
    "plugin-linux-arm64",
    "plugin-darwin-amd64",
    "plugin-darwin-arm64",
    "plugin-windows-amd64.exe",
)


def filter_member(tarinfo: tarfile.TarInfo) -> tarfile.TarInfo:
    name = os.path.basename(tarinfo.name)
    if tarinfo.isfile() and name in EXEC_SUFFIXES:
        tarinfo.mode = 0o755
    elif tarinfo.isdir():
        tarinfo.mode = 0o755
    elif tarinfo.isfile():
        tarinfo.mode = 0o644
    tarinfo.uid = 0
    tarinfo.gid = 0
    tarinfo.uname = ""
    tarinfo.gname = ""
    return tarinfo


def main():
    if not os.path.isdir(SRC_ROOT):
        print(f"ERROR: {SRC_ROOT} does not exist; run the bundle step first", file=sys.stderr)
        sys.exit(1)

    out = sys.argv[1] if len(sys.argv) > 1 else "boards-repacked.tar.gz"
    with tarfile.open(out, "w:gz") as tf:
        tf.add(SRC_ROOT, arcname=PLUGIN_NAME, filter=filter_member)
    print(f"Wrote {out} ({os.path.getsize(out) / (1024 * 1024):.1f} MiB)")


if __name__ == "__main__":
    main()
