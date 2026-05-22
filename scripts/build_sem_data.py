#!/usr/bin/env python3
"""Build the KwaDukuza UGM static data contract from the SEM DuckDB.

This is intentionally a build-time bridge. Azure Static Web Apps still serves
static files from public/data and never opens DuckDB at runtime.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path


DEFAULT_SEM_REPO = Path("/Users/shumba/Documents/EThekwini Spatial Economic Model")
DEFAULT_SEM_DB = Path(
    "/Volumes/SpatialProj/EThekwini Spatial Economic Model/data/ethekwini.duckdb"
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        default="public/data",
        help="Static data directory to write. Defaults to public/data.",
    )
    parser.add_argument(
        "--sem-repo",
        default=os.environ.get("SEM_REPO_PATH", str(DEFAULT_SEM_REPO)),
        help="Path to the Spatial Economic Model repository.",
    )
    parser.add_argument(
        "--db-path",
        default=os.environ.get("SEM_DUCKDB_PATH", str(DEFAULT_SEM_DB)),
        help="Path to the canonical SEM DuckDB.",
    )
    parser.add_argument(
        "--refresh-sanlc-2022",
        action="store_true",
        default=os.environ.get("SEM_REFRESH_SANLC_2022", "").lower()
        in {"1", "true", "yes", "on"},
        help=(
            "Refresh the SEM SANLC 2022 ward table before export. Normal static "
            "builds leave this off and consume the existing SEM table read-only."
        ),
    )
    args = parser.parse_args()

    sem_repo = Path(args.sem_repo).expanduser().resolve()
    db_path = Path(args.db_path).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser()
    if not output_dir.is_absolute():
        output_dir = (Path.cwd() / output_dir).resolve()

    if not sem_repo.exists():
        raise SystemExit(f"SEM repo not found: {sem_repo}")
    if not db_path.exists():
        raise SystemExit(f"SEM DuckDB not found: {db_path}")

    sem_python_env = os.environ.get("SEM_PYTHON")
    if sem_python_env:
        sem_python = Path(sem_python_env)
    else:
        candidate = sem_repo / ".venv" / "bin" / "python"
        sem_python = candidate if candidate.exists() else Path(sys.executable)

    cmd = [
        str(sem_python),
        "-m",
        "spatialeconmodel",
        "ugm-export",
        "--geo-code",
        "KZN292",
        "--city-name",
        "KwaDukuza",
        "--momentum-profile",
        "viirs",
        "--expected-ward-count",
        "30",
        "--file-prefix",
        "kzn292",
        "--db-path",
        str(db_path),
        "--output-dir",
        str(output_dir),
    ]
    if args.refresh_sanlc_2022:
        cmd.append("--refresh-sanlc-2022")
    env = os.environ.copy()
    src_path = sem_repo / "src"
    env["PYTHONPATH"] = (
        str(src_path)
        if not env.get("PYTHONPATH")
        else f"{src_path}{os.pathsep}{env['PYTHONPATH']}"
    )
    subprocess.run(cmd, cwd=sem_repo, env=env, check=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
