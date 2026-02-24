#!/usr/bin/env python3
import argparse
import csv
import datetime as dt
import json
import math
import re
import subprocess
import sys
import tempfile
import unicodedata
import zipfile
from collections import Counter, defaultdict
from pathlib import Path
from statistics import median
import xml.etree.ElementTree as ET

CITY_CODE = "KZN292"
EXPECTED_WARD_COUNT = 30
MIN_EXPECTED_DATE = "2014-01-01"
DATASET_VERSION = "kzn292-v1.0.0"
DATA_SIZE_GUARD_BYTES = 10 * 1024 * 1024
VIIRS_INDEX_BASE_MONTH = "2014-01-01"
SMOD_BASE_EPOCH = "2020"
SMOD_TARGET_EPOCH = "2030"
DENSITY_GAP_NEAR_PARITY_RATIO = 0.02

SMOD_URBAN_CODES = ("21", "22", "23", "30")
SMOD_ALL_CODES = ("10", "11", "12", "13", "21", "22", "23", "30")
DEGURBA_L1_LABEL_BY_CODE = {
    1: "Cities (Urban Centre)",
    2: "Towns and Suburbs",
    3: "Rural Areas",
}

BANDS = ("Low", "Medium", "High")

GHSL_CLUSTER_DISPLAY_MAP = {
    "Declining": "Slowing",
}

GHSL_CLUSTER_DISPLAY_DEFINITIONS = {
    "Slowing": "Lower relative growth momentum in this cluster model; not automatic population decline.",
}

STRESS_COMPONENT_WEIGHTS = {
    "ghsl_service_pressure_2030": 0.45,
    "ghsl_pop_density_2030": 0.20,
    "ghsl_pop_change_2020_2030": 0.20,
    "ghsl_pressure_change": 0.15,
}

MOMENTUM_COMPONENT_WEIGHTS = {
    "viirs_cagr_mean": 0.40,
    "viirs_yoy_mean": 0.20,
    "viirs_trend_slope": 0.20,
    "viirs_proxy_momentum_component": 0.20,
}

CONSTRAINT_COMPONENT_WEIGHTS = {
    "lc_urban_pct": 0.35,
    "protected_area_pct": 0.25,
    "lc_mining_pct": 0.20,
    "non_urban_econ_flag": 0.20,
}

PRIORITY_WEIGHTS = {
    "stress_component": 0.55,
    "inverse_momentum_component": 0.25,
    "constraint_component": 0.20,
}

GHSL_DASH_KPI_MAP = {
    "Population E2020": "ghsl_population_e2020",
    "Built Per Capita": "ghsl_built_per_capita",
    "Pop CAGR 20yr": "ghsl_pop_cagr_20yr_pct",
    "Built CAGR 20yr": "ghsl_built_cagr_20yr_pct",
}

VIIRS_DASH_KPI_MAP = {
    "Total Wards": "viirs_total_wards",
    "Latest Avg Radiance": "viirs_latest_avg_radiance",
    "Mean CAGR": "viirs_mean_cagr_pct",
    "Sum CAGR": "viirs_sum_cagr_pct",
    "Total Light Output": "viirs_total_light_output",
    "YoY Change": "viirs_yoy_change_pct",
}

LANDCOVER_DASH_KPI_MAP = {
    "Area": "landcover_area_km2",
    "Agriculture": "landcover_agriculture_pct",
    "Irrigation": "landcover_irrigation_pct",
    "NDVI": "landcover_ndvi_mean",
    "Protected Area %": "landcover_protected_area_pct",
}

NS_MAIN = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
NS_REL = {"r": "http://schemas.openxmlformats.org/package/2006/relationships"}


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def dump_json(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=True)


def now_iso_utc() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def normalize_ward_id(value) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if text.endswith(".0"):
        text = text[:-2]
    return text


def normalize_label(value: str) -> str:
    text = str(value or "").strip().lower()
    return re.sub(r"\s+", " ", text)


def normalize_key(value: str) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    ascii_text = text.encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "_", ascii_text.lower()).strip("_")


def normalize_ward_label(value: str) -> str:
    text = str(value or "").strip().upper()
    text = text.replace(" ", "")
    return text


def canonical_city_display_name(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    text = re.sub(r"(?i)\bmetropolitan municipality\b", "", text)
    text = re.sub(r"(?i)\blocal municipality\b", "", text)
    text = re.sub(r"(?i)\bdistrict municipality\b", "", text)
    text = re.sub(r"(?i)\bmunicipality\b", "", text)
    text = re.sub(r"(?i)^city of\s+", "", text)
    text = re.sub(r"\s+", " ", text).strip(" ,")
    return text


def parse_float(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if text == "":
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_int(value):
    num = parse_float(value)
    if num is None:
        return None
    return int(num)


def parse_kpi_numeric(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)

    text = str(value).strip()
    if text == "":
        return None

    cleaned = text.replace(",", "").replace(" ", "")
    cleaned = cleaned.replace("km2", "").replace("km²", "").replace("m²", "")
    if cleaned.startswith("+"):
        cleaned = cleaned[1:]
    if cleaned.endswith("%"):
        cleaned = cleaned[:-1]
    cleaned = re.sub(r"[^0-9eE.+\\-]", "", cleaned)
    try:
        return float(cleaned)
    except ValueError:
        return None


def pct_to_100(value):
    num = parse_float(value)
    if num is None:
        return None
    return num * 100.0


def excel_date_to_date(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        try:
            base = dt.datetime(1899, 12, 30)
            return (base + dt.timedelta(days=float(value))).date()
        except Exception:
            return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return dt.datetime.fromisoformat(text).date()
    except Exception:
        pass
    try:
        return dt.datetime.strptime(text, "%Y-%m-%d").date()
    except Exception:
        return None


def quarter_label_from_date(value):
    if value is None:
        return None
    quarter = (value.month - 1) // 3 + 1
    return f"{value.year}-Q{quarter}"


def parse_quarter_label(value: str):
    m = re.match(r"^(\d{4})-Q([1-4])$", str(value or ""))
    if not m:
        return None
    return int(m.group(1)), int(m.group(2))


def quarter_sort_key(value: str):
    parsed = parse_quarter_label(value)
    if not parsed:
        return (0, 0)
    return parsed


def quarter_distance(start_quarter: str, end_quarter: str):
    start = parse_quarter_label(start_quarter)
    end = parse_quarter_label(end_quarter)
    if not start or not end:
        return None
    return (end[0] - start[0]) * 4 + (end[1] - start[1])


def derive_density_gap_flag(density_2022, density_2030):
    if density_2022 is None or density_2030 is None:
        return "near_parity"
    baseline = max(abs(density_2030), 1.0)
    ratio = abs(density_2022 - density_2030) / baseline
    if ratio <= DENSITY_GAP_NEAR_PARITY_RATIO:
        return "near_parity"
    if density_2022 > density_2030:
        return "observed_above_forecast"
    return "forecast_above_observed"


def classify_smod_transition(
    degurba_2020,
    degurba_2030,
    urban_share_2020,
    urban_share_2030,
    urban_centre_share_2020,
    urban_centre_share_2030,
):
    if degurba_2020 == 3 and degurba_2030 in (2, 1):
        return "Emerging node transition"
    if degurba_2020 == 2 and degurba_2030 == 1:
        return "Town-to-city transition"
    if (
        degurba_2020 == 2
        and degurba_2030 == 2
        and urban_share_2020 is not None
        and urban_share_2030 is not None
        and (urban_share_2030 - urban_share_2020) >= 5.0
    ):
        return "Town intensification"
    if (
        degurba_2020 == 1
        and degurba_2030 == 1
        and urban_centre_share_2020 is not None
        and urban_centre_share_2030 is not None
        and (urban_centre_share_2030 - urban_centre_share_2020) >= 3.0
    ):
        return "Urban core intensification"
    if (degurba_2020 == 1 and degurba_2030 in (2, 3)) or (degurba_2020 == 2 and degurba_2030 == 3):
        return "Decentralisation signal"
    return "Stable settlement form"


def classify_landcover_story_class(ward_props, landcover_info):
    urban = parse_float(ward_props.get("lc_urban_pct"))
    protected = parse_float(ward_props.get("protected_area_pct"))
    mining = parse_float(ward_props.get("lc_mining_pct"))
    agri = parse_float((landcover_info or {}).get("landcover_agriculture_pct"))
    ndvi = parse_float((landcover_info or {}).get("landcover_ndvi_2024_mean"))

    if urban is not None and urban >= 75 and (agri is None or agri < 8) and (mining is None or mining < 4):
        return "Urban Core"
    if mining is not None and mining >= 8:
        return "Extractive Influence"
    if protected is not None and protected >= 25 and (urban is None or urban < 70):
        return "Conservation-led"
    if agri is not None and agri >= 20 and (ndvi is None or ndvi >= 0.35):
        return "Productive Agriculture"
    if urban is not None and urban >= 45:
        return "Mixed Urban"
    return "Peri-urban Transition"


def map_ghsl_cluster_display(raw_cluster):
    text = str(raw_cluster or "").strip()
    if not text:
        return "Unclassified"
    return GHSL_CLUSTER_DISPLAY_MAP.get(text, text)


def clamp_0_100(value: float) -> float:
    return max(0.0, min(100.0, value))


def quantile(values, q):
    if not values:
        return 0.0
    sorted_values = sorted(values)
    if len(sorted_values) == 1:
        return float(sorted_values[0])
    pos = (len(sorted_values) - 1) * q
    base = int(math.floor(pos))
    rest = pos - base
    right = sorted_values[base + 1] if base + 1 < len(sorted_values) else sorted_values[base]
    return float(sorted_values[base] + rest * (right - sorted_values[base]))


def percentile_rank_by_ward(values_by_ward):
    pairs = sorted(values_by_ward.items(), key=lambda item: item[1])
    n = len(pairs)
    if n == 0:
        return {}
    if n == 1:
        return {pairs[0][0]: 50.0}

    ranks = {}
    i = 0
    while i < n:
        j = i + 1
        while j < n and pairs[j][1] == pairs[i][1]:
            j += 1
        avg_pos = (i + j - 1) / 2.0
        rank = (avg_pos / (n - 1)) * 100.0
        for k in range(i, j):
            ranks[pairs[k][0]] = rank
        i = j
    return ranks


def weighted_score(props, percentile_maps, weights):
    total = 0.0
    for field, weight in weights.items():
        total += percentile_maps[field][props["ward_id"]] * weight
    return clamp_0_100(total)


def band_for_value(value, low_cut, high_cut):
    if value <= low_cut:
        return "Low"
    if value <= high_cut:
        return "Medium"
    return "High"


def bivariate_key(stress_band, momentum_band):
    short = {"Low": "L", "Medium": "M", "High": "H"}
    return f"{short[stress_band]}-{short[momentum_band]}"


def select_action_tag(stress_band, momentum_band, constraint_band):
    if stress_band == "High" and momentum_band == "Low" and constraint_band == "High":
        return "Critical service triage"
    if stress_band == "High" and momentum_band == "High" and constraint_band in ("Low", "Medium"):
        return "Accelerate capacity"
    if stress_band == "High" and momentum_band in ("Low", "Medium") and constraint_band == "Low":
        return "Near-term infrastructure investment"
    if stress_band in ("Low", "Medium") and momentum_band == "High":
        return "Growth monitoring"
    return "Targeted ward review"


def extract_kzn292_geojson(gpkg_path: Path, out_geojson: Path):
    cmd = [
        "ogr2ogr",
        "-f",
        "GeoJSON",
        str(out_geojson),
        str(gpkg_path),
        "lc5_ward_indicators",
        "-where",
        "CAT_B = 'KZN292'",
        "-t_srs",
        "EPSG:4326",
    ]
    completed = subprocess.run(cmd, capture_output=True, text=True)
    if completed.returncode != 0:
        sys.stderr.write(completed.stderr)
        raise RuntimeError("ogr2ogr failed while extracting KwaDukuza geometry")


def recompute_protected_area_pct_unioned(landcover_gpkg: Path, protected_areas_gpkg: Path):
    with tempfile.TemporaryDirectory(prefix="eth-protected-") as tmpdir:
        work_gpkg = Path(tmpdir) / "protected_unioned.gpkg"
        out_csv = Path(tmpdir) / "protected_pct_unioned.csv"

        cmd_wards = [
            "ogr2ogr",
            "-f",
            "GPKG",
            str(work_gpkg),
            str(landcover_gpkg),
            "lc5_ward_indicators",
            "-where",
            "CAT_B = 'KZN292'",
            "-nln",
            "kzn292_wards",
            "-t_srs",
            "EPSG:4326",
        ]
        completed = subprocess.run(cmd_wards, capture_output=True, text=True)
        if completed.returncode != 0:
            sys.stderr.write(completed.stderr)
            raise RuntimeError("ogr2ogr failed while preparing KwaDukuza wards for protected-area recompute")

        cmd_protected = [
            "ogr2ogr",
            "-f",
            "GPKG",
            "-append",
            str(work_gpkg),
            str(protected_areas_gpkg),
            "protected_areas",
            "-nln",
            "protected_areas",
            "-t_srs",
            "EPSG:4326",
        ]
        completed = subprocess.run(cmd_protected, capture_output=True, text=True)
        if completed.returncode != 0:
            sys.stderr.write(completed.stderr)
            raise RuntimeError("ogr2ogr failed while loading protected polygons for recompute")

        sql = (
            "SELECT "
            "w.WardID AS ward_id, "
            "ROUND(COALESCE((ST_Area(ST_Union(ST_Intersection(w.geom,p.geom)))/NULLIF(ST_Area(w.geom),0))*100.0,0),6) "
            "AS protected_area_pct_exact "
            "FROM kzn292_wards w "
            "LEFT JOIN protected_areas p ON ST_Intersects(w.geom, p.geom) "
            "GROUP BY w.WardID "
            "ORDER BY w.WardID"
        )
        cmd_sql = [
            "ogr2ogr",
            "-f",
            "CSV",
            str(out_csv),
            str(work_gpkg),
            "-dialect",
            "SQLITE",
            "-sql",
            sql,
        ]
        completed = subprocess.run(cmd_sql, capture_output=True, text=True)
        if completed.returncode != 0:
            sys.stderr.write(completed.stderr)
            raise RuntimeError("ogr2ogr SQL failed while recomputing protected-area coverage")

        by_ward = {}
        with out_csv.open("r", encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                ward_id = normalize_ward_id(row.get("ward_id"))
                value = parse_float(row.get("protected_area_pct_exact"))
                if not ward_id or value is None:
                    continue
                by_ward[ward_id] = value
        return by_ward


def check_gate(checks, failures, name: str, passed: bool, detail: str):
    checks.append({"name": name, "passed": passed, "detail": detail, "severity": "critical"})
    if not passed:
        failures.append(name)


def source_file_info(source_key: str, path: Path):
    stat = path.stat()
    return {
        "source_key": source_key,
        "file_name": path.name,
        "size_bytes": stat.st_size,
        "modified_at": dt.datetime.fromtimestamp(stat.st_mtime, dt.timezone.utc).isoformat(),
    }


def compute_data_size(files):
    total = 0
    for file_path in files:
        if file_path.exists():
            total += file_path.stat().st_size
    return total


def col_label_to_index(col: str) -> int:
    value = 0
    for ch in col:
        if "A" <= ch <= "Z":
            value = value * 26 + (ord(ch) - ord("A") + 1)
    return value


def cell_ref_to_col(cell_ref: str) -> int:
    label = ""
    for ch in cell_ref:
        if ch.isalpha():
            label += ch
        else:
            break
    return col_label_to_index(label)


def cell_ref_to_row(cell_ref: str) -> int:
    digits = ""
    for ch in cell_ref:
        if ch.isdigit():
            digits += ch
    return int(digits) if digits else 0


def parse_shared_strings(zf: zipfile.ZipFile):
    try:
        root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    except KeyError:
        return []

    out = []
    for si in root.findall("m:si", NS_MAIN):
        t = si.find("m:t", NS_MAIN)
        if t is not None and t.text is not None:
            out.append(t.text)
            continue

        parts = []
        for run in si.findall("m:r", NS_MAIN):
            text_node = run.find("m:t", NS_MAIN)
            if text_node is not None and text_node.text is not None:
                parts.append(text_node.text)
        out.append("".join(parts))
    return out


class XlsxWorkbook:
    def __init__(self, path: Path):
        self.path = path
        self._zip = zipfile.ZipFile(path)
        self._shared = parse_shared_strings(self._zip)
        workbook = ET.fromstring(self._zip.read("xl/workbook.xml"))
        rels = ET.fromstring(self._zip.read("xl/_rels/workbook.xml.rels"))

        rel_map = {}
        for rel in rels.findall("r:Relationship", NS_REL):
            rel_map[rel.attrib.get("Id")] = rel.attrib.get("Target")

        self.sheet_targets = {}
        sheets = workbook.find("m:sheets", NS_MAIN)
        if sheets is not None:
            for sheet in sheets.findall("m:sheet", NS_MAIN):
                name = sheet.attrib.get("name")
                rel_id = sheet.attrib.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
                target = rel_map.get(rel_id)
                if name and target:
                    self.sheet_targets[name] = target

    def close(self):
        self._zip.close()

    def get_sheet_matrix(self, sheet_name: str):
        target = self.sheet_targets.get(sheet_name)
        if not target:
            return {}

        xml_root = ET.fromstring(self._zip.read(f"xl/{target}"))
        sheet_data = xml_root.find("m:sheetData", NS_MAIN)
        if sheet_data is None:
            return {}

        matrix = defaultdict(dict)
        for row in sheet_data.findall("m:row", NS_MAIN):
            for cell in row.findall("m:c", NS_MAIN):
                ref = cell.attrib.get("r", "")
                if not ref:
                    continue

                col = cell_ref_to_col(ref)
                row_num = cell_ref_to_row(ref)

                value_node = cell.find("m:v", NS_MAIN)
                if value_node is None or value_node.text is None:
                    continue

                raw = value_node.text
                cell_type = cell.attrib.get("t", "")
                if cell_type == "s":
                    try:
                        value = self._shared[int(raw)]
                    except (ValueError, IndexError):
                        value = raw
                elif cell_type == "b":
                    value = raw == "1"
                else:
                    try:
                        value = float(raw)
                        if value.is_integer():
                            value = int(value)
                    except ValueError:
                        value = raw

                matrix[row_num][col] = value
        return matrix


def extract_table_rows(matrix, header_row, start_row):
    header_cells = matrix.get(header_row, {})
    if not header_cells:
        return []

    headers = {}
    for col, raw in header_cells.items():
        key = normalize_key(raw)
        if key:
            headers[col] = key

    rows = []
    for row_num in sorted(matrix.keys()):
        if row_num < start_row:
            continue
        row_cells = matrix[row_num]
        if not row_cells:
            continue

        row_obj = {}
        for col, key in headers.items():
            row_obj[key] = row_cells.get(col)

        if all(value in (None, "") for value in row_obj.values()):
            continue
        rows.append(row_obj)
    return rows


def pick_nearby_value(matrix, row_num, col_num, expected_label_set):
    candidates = [
        (row_num - 1, col_num),
        (row_num + 1, col_num),
        (row_num - 2, col_num),
        (row_num + 2, col_num),
        (row_num, col_num - 1),
        (row_num, col_num + 1),
    ]

    for r, c in candidates:
        value = matrix.get(r, {}).get(c)
        if value is None:
            continue
        if isinstance(value, str) and value.strip() == "":
            continue
        if normalize_label(value) in expected_label_set:
            continue
        return value
    return None


def extract_dashboard_kpis(workbook: XlsxWorkbook, sheet_name: str, kpi_map, source_name: str):
    matrix = workbook.get_sheet_matrix(sheet_name)
    expected_label_norm = {normalize_label(label): label for label in kpi_map}

    found = {}
    for row_num, row_cells in matrix.items():
        for col_num, value in row_cells.items():
            label_norm = normalize_label(value)
            if label_norm not in expected_label_norm:
                continue
            canonical = expected_label_norm[label_norm]
            if canonical in found:
                continue
            found[canonical] = pick_nearby_value(matrix, row_num, col_num, set(expected_label_norm.keys()))

    kpis = {}
    missing_labels = []
    empty_values = []

    for label, key in kpi_map.items():
        raw_value = found.get(label)
        display = None if raw_value is None else str(raw_value)
        numeric = parse_kpi_numeric(raw_value)

        if display is None or display.strip() == "":
            missing_labels.append(label)
            empty_values.append(label)

        kpis[key] = {
            "key": key,
            "label": label,
            "source": source_name,
            "display": display,
            "value": numeric,
        }

    return {
        "kpis": kpis,
        "found_labels": sorted(found.keys()),
        "missing_labels": missing_labels,
        "empty_values": empty_values,
    }


def extract_viirs_insights(workbook: XlsxWorkbook):
    ward_analysis_rows = extract_table_rows(workbook.get_sheet_matrix("Ward Analysis"), header_row=1, start_row=2)

    ward_by_id = {}
    ward_label_to_id = {}
    for row in ward_analysis_rows:
        ward_id = normalize_ward_id(row.get("ward_id") or row.get("wardid"))
        if not ward_id:
            continue

        ward_label = row.get("ward_label")
        ward_by_id[ward_id] = {
            "ward_id": ward_id,
            "ward_label": str(ward_label) if ward_label is not None else f"{CITY_CODE}_{ward_id}",
            "viirs_cagr_pct": pct_to_100(row.get("cagr")),
            "viirs_trend_slope": parse_float(row.get("trend_slope")),
            "viirs_cluster": str(row.get("cluster") or "").strip() or None,
            "viirs_z_score": parse_float(row.get("z_score")),
            "viirs_quintile": str(row.get("quintile") or "").strip() or None,
            "viirs_avg_latest": parse_float(row.get("avg_latest")),
        }
        ward_label_to_id[normalize_ward_label(ward_by_id[ward_id]["ward_label"])] = ward_id

    growth_rows = extract_table_rows(workbook.get_sheet_matrix("Growth Rankings"), header_row=3, start_row=4)
    growth_candidates = []
    decline_candidates = []
    for row in growth_rows:
        ward_label = str(row.get("ward_label") or "").strip()
        if not ward_label:
            continue

        ward_id = ward_label_to_id.get(normalize_ward_label(ward_label))
        cagr = pct_to_100(row.get("mean_cagr"))

        if not ward_id or cagr is None:
            continue

        entry = {
            "ward_id": ward_id,
            "ward_label": ward_label,
            "value": cagr,
            "cluster": str(row.get("cluster") or "").strip() or None,
        }

        if cagr > 0:
            growth_candidates.append(entry)
        elif cagr < 0:
            decline_candidates.append(entry)

    growth_candidates.sort(key=lambda item: item["value"], reverse=True)
    decline_candidates.sort(key=lambda item: item["value"])

    growth_rank = []
    for idx, row in enumerate(growth_candidates, start=1):
        growth_rank.append({**row, "rank": idx})

    decline_rank = []
    for idx, row in enumerate(decline_candidates, start=1):
        decline_rank.append({**row, "rank": idx})

    return {
        "ward_by_id": ward_by_id,
        "growth_rank": growth_rank,
        "decline_rank": decline_rank,
    }


def extract_ghsl_insights(workbook: XlsxWorkbook):
    ward_detail_rows = extract_table_rows(workbook.get_sheet_matrix("Ward Detail"), header_row=3, start_row=4)

    ward_by_id = {}
    for row in ward_detail_rows:
        ward_id = normalize_ward_id(row.get("wardid") or row.get("ward_id"))
        if not ward_id:
            continue
        ward_by_id[ward_id] = {
            "ward_id": ward_id,
            "ghsl_pop": parse_float(row.get("pop")),
            "ghsl_pop_density": parse_float(row.get("pop_km2")),
            "ghsl_built_per_cap": parse_float(row.get("built_cap")),
            "ghsl_cluster": str(row.get("cluster") or "").strip() or None,
        }

    ranking_rows = extract_table_rows(workbook.get_sheet_matrix("Ward Rankings"), header_row=3, start_row=4)
    pop_density_rank = []
    for row in ranking_rows:
        ward_id = normalize_ward_id(row.get("wardid") or row.get("ward_id"))
        if not ward_id:
            continue
        pop_density = parse_float(row.get("pop_km2"))
        if pop_density is None:
            continue
        pop_density_rank.append(
            {
                "ward_id": ward_id,
                "value": pop_density,
            }
        )

    pop_density_rank.sort(key=lambda item: item["value"], reverse=True)
    for idx, row in enumerate(pop_density_rank, start=1):
        row["rank"] = idx

    return {
        "ward_by_id": ward_by_id,
        "pop_density_rank": pop_density_rank,
    }


def extract_landcover_insights(workbook: XlsxWorkbook):
    ward_detail_rows = extract_table_rows(workbook.get_sheet_matrix("WardDetail"), header_row=3, start_row=4)

    ward_by_id = {}
    for row in ward_detail_rows:
        ward_id = normalize_ward_id(row.get("wardid") or row.get("ward_id"))
        if not ward_id:
            continue

        ward_by_id[ward_id] = {
            "ward_id": ward_id,
            "landcover_agriculture_pct": pct_to_100(row.get("sanlc_agriculture_pct")),
            "landcover_mining_pct": pct_to_100(row.get("sanlc_mining_pct")),
            "landcover_irrigation_ratio": parse_float(row.get("irrigation_ratio")),
            "landcover_ndvi_2024_mean": parse_float(row.get("ndvi_2024_mean")),
            "landcover_agriculture_profile": str(row.get("agricultural_profile") or "").strip() or None,
            "landcover_tourism_class": str(row.get("enhanced_tourism_class") or "").strip() or None,
        }

    agri_rank = []
    for ward_id, row in ward_by_id.items():
        value = row.get("landcover_agriculture_pct")
        if value is None:
            continue
        agri_rank.append({"ward_id": ward_id, "value": value})

    agri_rank.sort(key=lambda item: item["value"], reverse=True)
    for idx, row in enumerate(agri_rank, start=1):
        row["rank"] = idx

    return {
        "ward_by_id": ward_by_id,
        "agriculture_rank": agri_rank,
    }


def extract_smod_transitions(smod_zonal_csv: Path, join_ids):
    join_set = set(join_ids)
    by_ward_epoch = defaultdict(dict)
    city_counts = defaultdict(lambda: {"urban": 0.0, "total": 0.0, "urban_centre": 0.0})

    with smod_zonal_csv.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            ward_id = normalize_ward_id(row.get("WardID"))
            epoch = str(row.get("epoch", "")).strip()
            if ward_id not in join_set or epoch not in (SMOD_BASE_EPOCH, SMOD_TARGET_EPOCH):
                continue

            degurba_code = parse_int(row.get("degurba_l1"))
            degurba_label = str(row.get("degurba_l1_label") or "").strip() or DEGURBA_L1_LABEL_BY_CODE.get(
                degurba_code, "Unknown"
            )
            urban_share = 0.0
            urban_centre_share = parse_float(row.get("smod_frac_30"))
            total_count = 0.0
            urban_count = 0.0
            urban_centre_count = parse_float(row.get("smod_count_30")) or 0.0
            for code in SMOD_URBAN_CODES:
                urban_share += parse_float(row.get(f"smod_frac_{code}")) or 0.0
                urban_count += parse_float(row.get(f"smod_count_{code}")) or 0.0
            for code in SMOD_ALL_CODES:
                total_count += parse_float(row.get(f"smod_count_{code}")) or 0.0

            by_ward_epoch[ward_id][epoch] = {
                "degurba_l1": degurba_code,
                "degurba_l1_label": degurba_label,
                "urban_share_pct": urban_share * 100.0,
                "urban_centre_share_pct": (urban_centre_share or 0.0) * 100.0,
            }

            city_counts[epoch]["urban"] += urban_count
            city_counts[epoch]["total"] += total_count
            city_counts[epoch]["urban_centre"] += urban_centre_count

    missing_wards = []
    out_by_ward = {}
    transition_counts = Counter()

    for ward_id in join_ids:
        base = by_ward_epoch.get(ward_id, {}).get(SMOD_BASE_EPOCH)
        target = by_ward_epoch.get(ward_id, {}).get(SMOD_TARGET_EPOCH)
        if not base or not target:
            missing_wards.append(ward_id)

        degurba_2020 = (base or {}).get("degurba_l1")
        degurba_2030 = (target or {}).get("degurba_l1")
        degurba_label_2020 = (base or {}).get("degurba_l1_label") or DEGURBA_L1_LABEL_BY_CODE.get(
            degurba_2020, "Unknown"
        )
        degurba_label_2030 = (target or {}).get("degurba_l1_label") or DEGURBA_L1_LABEL_BY_CODE.get(
            degurba_2030, "Unknown"
        )
        urban_share_2020 = (base or {}).get("urban_share_pct")
        urban_share_2030 = (target or {}).get("urban_share_pct")
        urban_centre_share_2020 = (base or {}).get("urban_centre_share_pct")
        urban_centre_share_2030 = (target or {}).get("urban_centre_share_pct")

        transition_class = classify_smod_transition(
            degurba_2020,
            degurba_2030,
            urban_share_2020,
            urban_share_2030,
            urban_centre_share_2020,
            urban_centre_share_2030,
        )
        transition_counts[transition_class] += 1

        out_by_ward[ward_id] = {
            "smod_degurba_l1_2020": degurba_2020,
            "smod_degurba_l1_2030": degurba_2030,
            "smod_degurba_label_2020": degurba_label_2020,
            "smod_degurba_label_2030": degurba_label_2030,
            "smod_urban_share_2020": urban_share_2020,
            "smod_urban_share_2030": urban_share_2030,
            "smod_urban_share_change_pp": (
                (urban_share_2030 - urban_share_2020)
                if urban_share_2020 is not None and urban_share_2030 is not None
                else None
            ),
            "smod_transition_class": transition_class,
        }

    city_2020 = city_counts.get(SMOD_BASE_EPOCH, {})
    city_2030 = city_counts.get(SMOD_TARGET_EPOCH, {})
    city_urban_share_2020 = None
    city_urban_share_2030 = None
    if city_2020.get("total"):
        city_urban_share_2020 = (city_2020.get("urban", 0.0) / city_2020["total"]) * 100.0
    if city_2030.get("total"):
        city_urban_share_2030 = (city_2030.get("urban", 0.0) / city_2030["total"]) * 100.0

    return {
        "by_ward": out_by_ward,
        "missing_wards": missing_wards,
        "transition_counts": dict(transition_counts),
        "city_urban_share_2020": city_urban_share_2020,
        "city_urban_share_2030": city_urban_share_2030,
        "city_urban_share_change_pp": (
            (city_urban_share_2030 - city_urban_share_2020)
            if city_urban_share_2020 is not None and city_urban_share_2030 is not None
            else None
        ),
    }


def build_ward_reasons(
    ward_id, ward_props, viirs_info, ghsl_info, landcover_info, landcover_story_class=None
):
    reasons = []

    if viirs_info and viirs_info.get("viirs_cluster"):
        cagr = viirs_info.get("viirs_cagr_pct")
        if cagr is not None:
            reasons.append(f"VIIRS cluster: {viirs_info['viirs_cluster']} with CAGR {cagr:.1f}%")
        else:
            reasons.append(f"VIIRS cluster: {viirs_info['viirs_cluster']}")

    if ghsl_info and (ghsl_info.get("ghsl_cluster_display") or ghsl_info.get("ghsl_cluster")):
        ghsl_cluster_display = ghsl_info.get("ghsl_cluster_display") or map_ghsl_cluster_display(
            ghsl_info.get("ghsl_cluster")
        )
        density = ghsl_info.get("ghsl_pop_density")
        if density is not None:
            reasons.append(f"Settlement cluster: {ghsl_cluster_display} and density {density:.0f} per km2")
        else:
            reasons.append(f"Settlement cluster: {ghsl_cluster_display}")

    if ward_props and ward_props.get("smod_transition_class"):
        reasons.append(f"Settlement transition: {ward_props['smod_transition_class']} (2020 to 2030)")

    if landcover_story_class:
        reasons.append(f"Landcover story: {landcover_story_class}")
    elif landcover_info and landcover_info.get("landcover_agriculture_profile"):
        reasons.append(f"Landcover profile: {landcover_info['landcover_agriculture_profile']}")

    if landcover_info and landcover_info.get("landcover_tourism_class"):
        reasons.append(f"Tourism class: {landcover_info['landcover_tourism_class']}")

    viirs_cagr = parse_float(ward_props.get("viirs_cagr_mean"))
    if viirs_cagr is not None:
        reasons.append(f"VIIRS CAGR: {viirs_cagr:.2f}%")

    if not reasons:
        reasons.append(f"Ward {ward_id} requires targeted review based on combined signals")

    return reasons[:4]


def build_content_insights(
    join_ids,
    ward_props_by_id,
    ghsl_dashboard_xlsx: Path,
    landcover_dashboard_xlsx: Path,
    viirs_dashboard_xlsx: Path,
):
    ghsl_workbook = XlsxWorkbook(ghsl_dashboard_xlsx)
    landcover_workbook = XlsxWorkbook(landcover_dashboard_xlsx)
    viirs_workbook = XlsxWorkbook(viirs_dashboard_xlsx)

    try:
        ghsl_kpis = extract_dashboard_kpis(ghsl_workbook, "Dashboard", GHSL_DASH_KPI_MAP, "ghsl_dashboard")
        landcover_kpis = extract_dashboard_kpis(
            landcover_workbook, "Dashboard", LANDCOVER_DASH_KPI_MAP, "landcover_dashboard"
        )
        viirs_kpis = extract_dashboard_kpis(viirs_workbook, "Dashboard", VIIRS_DASH_KPI_MAP, "viirs_dashboard")

        viirs_insights = extract_viirs_insights(viirs_workbook)
        ghsl_insights = extract_ghsl_insights(ghsl_workbook)
        landcover_insights = extract_landcover_insights(landcover_workbook)
    finally:
        ghsl_workbook.close()
        landcover_workbook.close()
        viirs_workbook.close()

    ward_insights = []
    missing_content_ids = []

    viirs_growth_rank_map = {row["ward_id"]: row for row in viirs_insights["growth_rank"]}
    ghsl_density_rank_map = {row["ward_id"]: row for row in ghsl_insights["pop_density_rank"]}
    landcover_agri_rank_map = {row["ward_id"]: row for row in landcover_insights["agriculture_rank"]}

    for ward_id in join_ids:
        ward_props = ward_props_by_id.get(ward_id, {})
        viirs_info = viirs_insights["ward_by_id"].get(ward_id)
        ghsl_info = ghsl_insights["ward_by_id"].get(ward_id)
        landcover_info = landcover_insights["ward_by_id"].get(ward_id)
        landcover_story_class = classify_landcover_story_class(ward_props, landcover_info)

        if not (viirs_info and ghsl_info and landcover_info):
            missing_content_ids.append(ward_id)

        ghsl_payload = dict(ghsl_info or {})
        ghsl_payload["ghsl_cluster_raw"] = ghsl_payload.get("ghsl_cluster")
        ghsl_payload["ghsl_cluster_display"] = map_ghsl_cluster_display(ghsl_payload.get("ghsl_cluster"))
        ghsl_payload["smod_transition_class"] = ward_props.get("smod_transition_class")

        landcover_payload = dict(landcover_info or {})
        landcover_payload["landcover_story_class"] = landcover_story_class

        ward_insights.append(
            {
                "ward_id": ward_id,
                "ward_label": ward_props.get("ward_label") or (viirs_info or {}).get("ward_label") or f"{CITY_CODE}_{ward_id}",
                "viirs": viirs_info or {},
                "ghsl": ghsl_payload,
                "landcover": landcover_payload,
                "ranks": {
                    "viirs_growth_rank": (viirs_growth_rank_map.get(ward_id) or {}).get("rank"),
                    "ghsl_pop_density_rank": (ghsl_density_rank_map.get(ward_id) or {}).get("rank"),
                    "landcover_agriculture_rank": (landcover_agri_rank_map.get(ward_id) or {}).get("rank"),
                },
                "why_this_ward": build_ward_reasons(
                    ward_id,
                    ward_props,
                    viirs_info,
                    ghsl_payload,
                    landcover_payload,
                    landcover_story_class=landcover_story_class,
                ),
            }
        )

    city_headline_kpis = {}
    for source in [ghsl_kpis, viirs_kpis, landcover_kpis]:
        city_headline_kpis.update(source["kpis"])

    census_values = []
    for ward_id in join_ids:
        census_value = parse_float((ward_props_by_id.get(ward_id) or {}).get("census_pop_2022"))
        if census_value is not None:
            census_values.append(census_value)

    census_total = sum(census_values) if len(census_values) == len(join_ids) else None
    city_headline_kpis["ghsl_census_2022"] = {
        "key": "ghsl_census_2022",
        "label": "Census 2022",
        "source": "ghsl_ward_outlook_csv",
        "display": f"{census_total:,.0f}" if census_total is not None else None,
        "value": census_total,
    }
    city_headline_kpis["viirs_momentum_note"] = {
        "key": "viirs_momentum_note",
        "label": "Economic Proxy Method",
        "source": "viirs_ward_summary_csv",
        "display": "VIIRS nighttime lights (non-metro, no S&P quarterly GDP)",
        "value": None,
    }

    required_labels_resolved = {
        "ghsl": len(ghsl_kpis["missing_labels"]) == 0,
        "viirs": len(viirs_kpis["missing_labels"]) == 0,
        "landcover": len(landcover_kpis["missing_labels"]) == 0,
    }

    empty_kpi_values = [
        *[f"ghsl:{label}" for label in ghsl_kpis["empty_values"]],
        *[f"viirs:{label}" for label in viirs_kpis["empty_values"]],
        *[f"landcover:{label}" for label in landcover_kpis["empty_values"]],
    ]

    content_insights = {
        "dataset_version": DATASET_VERSION,
        "generated_at": now_iso_utc(),
        "ward_count": len(ward_insights),
        "city_headline_kpis": city_headline_kpis,
        "required_labels_resolved": required_labels_resolved,
        "top_lists": {
            "viirs_growth_rank": viirs_insights["growth_rank"][:20],
            "viirs_decline_rank": viirs_insights["decline_rank"][:20],
            "ghsl_pop_density": ghsl_insights["pop_density_rank"][:20],
            "landcover_agriculture": landcover_insights["agriculture_rank"][:20],
        },
        "ward_insights": ward_insights,
    }

    qa_meta = {
        "missing_content_ids": missing_content_ids,
        "required_labels_resolved": required_labels_resolved,
        "empty_kpi_values": empty_kpi_values,
    }

    return content_insights, qa_meta


def build_cluster_interpretation_audit(output_features, ward_insights):
    cluster_by_ward = {}
    for row in ward_insights:
        ward_id = row.get("ward_id")
        ghsl = row.get("ghsl") or {}
        raw_cluster = str(ghsl.get("ghsl_cluster_raw") or ghsl.get("ghsl_cluster") or "").strip() or "Unclassified"
        cluster_by_ward[ward_id] = raw_cluster

    grouped = defaultdict(
        lambda: {
            "ward_count": 0,
            "negative_census_to_2030_count": 0,
            "negative_modeled_2020_to_2030_count": 0,
        }
    )

    for feature in output_features:
        props = feature["properties"]
        ward_id = props.get("ward_id")
        raw_cluster = cluster_by_ward.get(ward_id, "Unclassified")
        bucket = grouped[raw_cluster]
        bucket["ward_count"] += 1

        census_change = parse_float(props.get("ghsl_pop_change_2022_2030"))
        modeled_change = parse_float(props.get("ghsl_pop_change_2020_2030"))
        if census_change is not None and census_change < 0:
            bucket["negative_census_to_2030_count"] += 1
        if modeled_change is not None and modeled_change < 0:
            bucket["negative_modeled_2020_to_2030_count"] += 1

    cluster_items = sorted(grouped.items(), key=lambda item: (-item[1]["ward_count"], item[0]))
    counts_by_raw_cluster = {}
    for raw_cluster, stats in cluster_items:
        ward_count = stats["ward_count"]
        census_neg = stats["negative_census_to_2030_count"]
        modeled_neg = stats["negative_modeled_2020_to_2030_count"]
        counts_by_raw_cluster[raw_cluster] = {
            "display_label": map_ghsl_cluster_display(raw_cluster),
            "ward_count": ward_count,
            "negative_census_to_2030_count": census_neg,
            "negative_census_to_2030_share_pct": round((census_neg / ward_count) * 100.0, 2) if ward_count else 0.0,
            "negative_modeled_2020_to_2030_count": modeled_neg,
            "negative_modeled_2020_to_2030_share_pct": round((modeled_neg / ward_count) * 100.0, 2)
            if ward_count
            else 0.0,
        }

    return {
        "method_note": (
            "Raw GHSL workbook cluster labels are preserved; display labels are mapped for interpretation clarity "
            "(Declining -> Slowing)."
        ),
        "counts_by_raw_cluster": counts_by_raw_cluster,
        "total_wards": sum(entry["ward_count"] for entry in counts_by_raw_cluster.values()),
    }


def main():
    parser = argparse.ArgumentParser(description="Build KwaDukuza dashboard static data outputs")
    parser.add_argument("--sources", default="config/sources.json")
    parser.add_argument(
        "--allow-prebuilt",
        action="store_true",
        help="If source files are unavailable, allow using already-committed public/data files.",
    )
    args = parser.parse_args()

    project_root = Path(__file__).resolve().parents[1]
    public_data_dir = project_root / "public" / "data"
    public_data_dir.mkdir(parents=True, exist_ok=True)

    sources_path = (project_root / args.sources).resolve()
    sources = load_json(sources_path)

    ghsl_csv = Path(sources["ghsl_ward_outlook_csv"])
    landcover_gpkg = Path(sources["landcover_ward_gpkg"])
    viirs_summary_csv = Path(sources["viirs_ward_summary_csv"])
    viirs_monthly_csv = Path(sources["viirs_ward_monthly_csv"])
    ghsl_dashboard_xlsx = Path(sources["ghsl_dashboard_xlsx"])
    landcover_dashboard_xlsx = Path(sources["landcover_dashboard_xlsx"])
    viirs_dashboard_xlsx = Path(sources["viirs_dashboard_xlsx"])
    smod_zonal_csv = Path(sources["smod_zonal_csv"])
    protected_areas_gpkg = Path(sources["protected_areas_gpkg"])

    source_files = [
        ghsl_csv,
        landcover_gpkg,
        viirs_summary_csv,
        viirs_monthly_csv,
        ghsl_dashboard_xlsx,
        landcover_dashboard_xlsx,
        viirs_dashboard_xlsx,
        smod_zonal_csv,
        protected_areas_gpkg,
    ]
    missing_sources = [src for src in source_files if not src.exists()]
    if missing_sources:
        if args.allow_prebuilt:
            required_outputs = [
                public_data_dir / "kzn292_wards.geojson",
                public_data_dir / "kzn292_viirs_timeseries.json",
                public_data_dir / "kzn292_summary.json",
                public_data_dir / "manifest.json",
                public_data_dir / "qa_report.json",
                public_data_dir / "kzn292_content_insights.json",
                public_data_dir / "kzn292_ghsl_anomaly_audit.json",
            ]
            missing_outputs = [path for path in required_outputs if not path.exists()]
            if missing_outputs:
                raise FileNotFoundError(
                    "Missing sources and missing prebuilt outputs: "
                    f"sources={[str(p) for p in missing_sources]}, outputs={[str(p) for p in missing_outputs]}"
                )

            print("Source files unavailable; using committed prebuilt public/data outputs.")
            for src in missing_sources:
                print(f"  - missing source: {src}")
            return

        raise FileNotFoundError(f"Missing source file(s): {[str(p) for p in missing_sources]}")

    checks = []
    failures = []

    with tempfile.TemporaryDirectory(prefix="eth-geo-") as tmpdir:
        temp_geojson = Path(tmpdir) / "kzn292_wards_raw.geojson"
        extract_kzn292_geojson(landcover_gpkg, temp_geojson)
        raw_geo = load_json(temp_geojson)

    raw_features = raw_geo.get("features", [])
    landcover_by_id = {}
    for feature in raw_features:
        props = feature.get("properties", {})
        ward_id = normalize_ward_id(props.get("WardID"))
        if ward_id:
            landcover_by_id[ward_id] = feature

    check_gate(
        checks,
        failures,
        "landcover_ward_count_28",
        len(landcover_by_id) == EXPECTED_WARD_COUNT,
        f"Expected {EXPECTED_WARD_COUNT}, got {len(landcover_by_id)}",
    )

    ghsl_by_id = {}
    with ghsl_csv.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row.get("CAT_B") != CITY_CODE:
                continue
            ward_id = normalize_ward_id(row.get("WardID"))
            if ward_id:
                ghsl_by_id[ward_id] = row

    viirs_summary_by_id = {}
    with viirs_summary_csv.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row.get("municipality_code") != CITY_CODE:
                continue
            ward_id = normalize_ward_id(row.get("ward_id"))
            if ward_id:
                viirs_summary_by_id[ward_id] = row

    viirs_timeseries = []
    viirs_dates = set()
    viirs_date_counts = defaultdict(int)
    city_month_acc = defaultdict(lambda: {"sum": 0.0, "count": 0})

    with viirs_monthly_csv.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row.get("municipality_code") != CITY_CODE:
                continue

            ward_id = normalize_ward_id(row.get("ward_id"))
            date = str(row.get("date", "")).strip()
            viirs_mean = parse_float(row.get("viirs_mean"))
            viirs_sum = parse_float(row.get("viirs_sum"))
            is_imputed = str(row.get("viirs_count_inferred_flag", "")).strip().lower() == "true"

            if not ward_id or not date:
                continue

            viirs_timeseries.append(
                {
                    "ward_id": ward_id,
                    "date": date,
                    "viirs_mean": viirs_mean,
                    "viirs_sum": viirs_sum,
                    "is_imputed": is_imputed,
                }
            )
            viirs_dates.add(date)
            viirs_date_counts[date] += 1

            if viirs_mean is not None:
                city_month_acc[date]["sum"] += viirs_mean
                city_month_acc[date]["count"] += 1

    viirs_timeseries.sort(key=lambda r: (r["date"], r["ward_id"]))
    sorted_dates = sorted(viirs_dates)
    earliest_date = sorted_dates[0] if sorted_dates else None
    latest_date = sorted_dates[-1] if sorted_dates else None

    check_gate(
        checks,
        failures,
        "viirs_month_coverage_start",
        earliest_date == MIN_EXPECTED_DATE,
        f"Expected earliest date {MIN_EXPECTED_DATE}, got {earliest_date}",
    )
    check_gate(
        checks,
        failures,
        "viirs_month_latest_present",
        latest_date is not None,
        f"Latest date detected: {latest_date}",
    )
    if latest_date is not None:
        check_gate(
            checks,
            failures,
            "viirs_rows_per_latest_month_111",
            viirs_date_counts[latest_date] == EXPECTED_WARD_COUNT,
            f"Expected {EXPECTED_WARD_COUNT}, got {viirs_date_counts[latest_date]} for {latest_date}",
        )

    join_ids = sorted(landcover_by_id.keys())
    ghsl_missing = sorted(set(join_ids) - set(ghsl_by_id.keys()))
    viirs_missing = sorted(set(join_ids) - set(viirs_summary_by_id.keys()))
    protected_pct_exact_by_id = recompute_protected_area_pct_unioned(landcover_gpkg, protected_areas_gpkg)
    protected_missing_recompute = sorted(set(join_ids) - set(protected_pct_exact_by_id.keys()))

    check_gate(
        checks,
        failures,
        "unmatched_ghsl_ids_zero",
        len(ghsl_missing) == 0,
        f"Missing GHSL IDs: {ghsl_missing[:5]} (total={len(ghsl_missing)})",
    )
    check_gate(
        checks,
        failures,
        "unmatched_viirs_summary_ids_zero",
        len(viirs_missing) == 0,
        f"Missing VIIRS IDs: {viirs_missing[:5]} (total={len(viirs_missing)})",
    )
    check_gate(
        checks,
        failures,
        "protected_area_recompute_coverage_111",
        len(protected_missing_recompute) == 0 and len(protected_pct_exact_by_id) == EXPECTED_WARD_COUNT,
        (
            f"missing_recomputed={protected_missing_recompute[:5]} (total={len(protected_missing_recompute)}), "
            f"recomputed_count={len(protected_pct_exact_by_id)}"
        ),
    )

    smod_data = extract_smod_transitions(smod_zonal_csv, join_ids)
    check_gate(
        checks,
        failures,
        "smod_transition_coverage_111",
        len(smod_data["missing_wards"]) == 0,
        f"Missing S-Mod 2020/2030 wards: {smod_data['missing_wards'][:5]} (total={len(smod_data['missing_wards'])})",
    )

    required_raw_fields = [
        "ghsl_pop_change_2020_2030",
        "ghsl_service_pressure_2030",
        "ghsl_pop_density_2030",
        "ghsl_pop_2030",
        "ghsl_pressure_change",
        "lc_urban_pct",
        "lc_mining_pct",
        "protected_area_pct",
        "non_urban_econ_flag",
        "viirs_cagr_mean",
        "viirs_yoy_mean",
        "viirs_trend_slope",
        "viirs_proxy_momentum_component",
    ]

    output_features = []
    missing_raw_rows = []
    missing_census_rows = []
    ghsl_anomalies = []
    missing_recomputed_protected_rows = []
    protected_delta_rows = []
    tourism_active_ward_count = 0

    for ward_id in join_ids:
        lc_feature = landcover_by_id[ward_id]
        lc_props = lc_feature.get("properties", {})
        ghsl_row = ghsl_by_id.get(ward_id, {})
        viirs_row = viirs_summary_by_id.get(ward_id, {})
        legacy_protected_pct = pct_to_100(lc_props.get("protected_area_pct"))
        recomputed_protected_pct = protected_pct_exact_by_id.get(ward_id)
        if recomputed_protected_pct is None:
            missing_recomputed_protected_rows.append(ward_id)
        if legacy_protected_pct is not None and recomputed_protected_pct is not None:
            protected_delta_rows.append(
                {
                    "ward_id": ward_id,
                    "legacy_pct": legacy_protected_pct,
                    "recomputed_pct": recomputed_protected_pct,
                    "delta_pct_points": recomputed_protected_pct - legacy_protected_pct,
                }
            )

        viirs_conf_flag = (viirs_row.get("confidence_flag") or "").strip() or "Medium"
        ghsl_conf_flag = (ghsl_row.get("forecast_confidence") or "").strip() or "Medium"
        smod_stats = smod_data["by_ward"].get(ward_id, {})

        props = {
            "ward_id": ward_id,
            "ward_label": viirs_row.get("ward_label") or f"{CITY_CODE}_{lc_props.get('WardNo', '')}",
            "municipality_code": CITY_CODE,
            "municipality_name": viirs_row.get("municipality_name") or lc_props.get("Municipali"),
            "district_name": viirs_row.get("district_name") or lc_props.get("District"),
            "province_name": viirs_row.get("province_name") or lc_props.get("Province"),
            "ghsl_pop_change_2020_2030": parse_float(ghsl_row.get("pop_change_2020_2030")),
            "ghsl_pop_pct_change_2020_2030": pct_to_100(ghsl_row.get("pop_pct_change_2020_2030")),
            "ghsl_built_change_2020_2030": parse_float(ghsl_row.get("built_change_2020_2030")),
            "ghsl_service_pressure_2030": parse_float(ghsl_row.get("service_pressure_E2030")),
            "ghsl_pop_density_2030": parse_float(ghsl_row.get("pop_density_E2030")),
            "ghsl_pop_2030": parse_float(ghsl_row.get("population_E2030")),
            "census_pop_2022": parse_float(ghsl_row.get("census_pop")),
            "ghsl_pressure_change": pct_to_100(ghsl_row.get("pp_change")),
            "ghsl_forecast_confidence": ghsl_conf_flag,
            "lc_urban_pct": pct_to_100(lc_props.get("sanlc_urban_pct")),
            "lc_mining_pct": pct_to_100(lc_props.get("mining_area_pct")),
            "protected_area_pct": recomputed_protected_pct,
            "viirs_cagr_mean": pct_to_100(viirs_row.get("cagr_mean")),
            "viirs_latest_mean": parse_float(viirs_row.get("latest_mean")),
            "viirs_growth_cluster": viirs_row.get("growth_cluster"),
            "viirs_yoy_mean": parse_float(viirs_row.get("yoy_mean")),
            "viirs_trend_slope": parse_float(viirs_row.get("trend_slope")),
            "viirs_proxy_momentum_component": parse_float(viirs_row.get("proxy_momentum_component")),
            "viirs_completeness_ratio": parse_float(viirs_row.get("completeness_ratio")),
            "viirs_confidence_flag": viirs_conf_flag,
            "ward_area_km2": parse_float(lc_props.get("area_km2")),
            "non_urban_econ_flag": parse_float(lc_props.get("non_urban_econ_flag")),
            "smod_degurba_l1_2020": smod_stats.get("smod_degurba_l1_2020"),
            "smod_degurba_l1_2030": smod_stats.get("smod_degurba_l1_2030"),
            "smod_degurba_label_2020": smod_stats.get("smod_degurba_label_2020"),
            "smod_degurba_label_2030": smod_stats.get("smod_degurba_label_2030"),
            "smod_urban_share_2020": smod_stats.get("smod_urban_share_2020"),
            "smod_urban_share_2030": smod_stats.get("smod_urban_share_2030"),
            "smod_urban_share_change_pp": smod_stats.get("smod_urban_share_change_pp"),
            "smod_transition_class": smod_stats.get("smod_transition_class"),
        }

        if props["ghsl_pop_2030"] is not None and props["census_pop_2022"] not in (None, 0):
            pop_change_2022_2030 = props["ghsl_pop_2030"] - props["census_pop_2022"]
            pop_pct_change_2022_2030 = (props["ghsl_pop_2030"] / props["census_pop_2022"] - 1.0) * 100.0
        else:
            pop_change_2022_2030 = None
            pop_pct_change_2022_2030 = None

        props["ghsl_pop_change_2022_2030"] = pop_change_2022_2030
        props["ghsl_pop_pct_change_2022_2030"] = pop_pct_change_2022_2030
        props["ghsl_negative_growth_flag"] = bool(pop_change_2022_2030 is not None and pop_change_2022_2030 < 0)
        if props["census_pop_2022"] is not None and props["ward_area_km2"] not in (None, 0):
            density_2022 = props["census_pop_2022"] / props["ward_area_km2"]
        else:
            density_2022 = None
        density_2030 = props.get("ghsl_pop_density_2030")
        props["ghsl_pop_density_2022"] = density_2022
        props["ghsl_density_gap_2022_vs_2030"] = (
            (density_2022 - density_2030) if density_2022 is not None and density_2030 is not None else None
        )
        props["ghsl_density_gap_flag"] = derive_density_gap_flag(density_2022, density_2030)

        tourism_poi_count = parse_float(lc_props.get("tourism_poi_count")) or 0.0
        tourism_accommodation_count = (
            (parse_float(lc_props.get("poi_hotel_count")) or 0.0)
            + (parse_float(lc_props.get("poi_guest_house_count")) or 0.0)
            + (parse_float(lc_props.get("poi_camp_site_count")) or 0.0)
        )
        tourism_attraction_count = parse_float(lc_props.get("poi_attraction_count")) or 0.0
        tourism_signal_non_airbnb = (
            tourism_poi_count > 0.0 or tourism_accommodation_count > 0.0 or tourism_attraction_count > 0.0
        )
        if tourism_signal_non_airbnb:
            tourism_active_ward_count += 1

        if props["ghsl_negative_growth_flag"]:
            ghsl_anomalies.append(
                {
                    "ward_id": ward_id,
                    "ward_label": props["ward_label"],
                    "census_pop_2022": props["census_pop_2022"],
                    "ghsl_pop_2030": props["ghsl_pop_2030"],
                    "ghsl_pop_change_2022_2030": pop_change_2022_2030,
                    "ghsl_pop_pct_change_2022_2030": pop_pct_change_2022_2030,
                    "forecast_confidence": ghsl_row.get("forecast_confidence"),
                    "reliability_tier": ghsl_row.get("reliability_tier"),
                    "anchor_ratio_final": parse_float(ghsl_row.get("anchor_ratio_final")),
                    "anchor_fallback_level": ghsl_row.get("anchor_fallback_level"),
                    "momentum_label": ghsl_row.get("momentum_label"),
                    "momentum_signal": ghsl_row.get("momentum_signal"),
                    "pp_change": pct_to_100(ghsl_row.get("pp_change")),
                    "service_pressure_E2030": parse_float(ghsl_row.get("service_pressure_E2030")),
                }
            )

        if any(props.get(field) in (None, "") for field in required_raw_fields):
            missing_raw_rows.append(ward_id)
        if props.get("census_pop_2022") in (None, ""):
            missing_census_rows.append(ward_id)

        output_features.append(
            {
                "type": "Feature",
                "geometry": lc_feature.get("geometry"),
                "properties": props,
            }
        )

    check_gate(
        checks,
        failures,
        "required_component_fields_non_null",
        len(missing_raw_rows) == 0,
        f"Rows with null component fields: {missing_raw_rows[:5]} (total={len(missing_raw_rows)})",
    )
    check_gate(
        checks,
        failures,
        "census_pop_2022_non_null_111",
        len(missing_census_rows) == 0,
        f"Rows with missing census_pop_2022: {missing_census_rows[:5]} (total={len(missing_census_rows)})",
    )
    check_gate(
        checks,
        failures,
        "protected_area_recomputed_non_null_111",
        len(missing_recomputed_protected_rows) == 0,
        (
            f"Rows with missing recomputed protected_area_pct: {missing_recomputed_protected_rows[:5]} "
            f"(total={len(missing_recomputed_protected_rows)})"
        ),
    )

    protected_out_of_range_rows = []
    for feature in output_features:
        ward_id = feature["properties"]["ward_id"]
        protected_pct = feature["properties"].get("protected_area_pct")
        if not isinstance(protected_pct, (int, float)) or not math.isfinite(protected_pct):
            protected_out_of_range_rows.append((ward_id, protected_pct))
            continue
        if protected_pct < 0 or protected_pct > 100:
            protected_out_of_range_rows.append((ward_id, protected_pct))
    check_gate(
        checks,
        failures,
        "protected_area_recomputed_range_0_100",
        len(protected_out_of_range_rows) == 0,
        (
            f"Rows outside 0..100 protected_area_pct: {protected_out_of_range_rows[:5]} "
            f"(total={len(protected_out_of_range_rows)})"
        ),
    )

    tourism_active_ward_share_pct = (tourism_active_ward_count / EXPECTED_WARD_COUNT) * 100.0
    check_gate(
        checks,
        failures,
        "tourism_active_ward_count_range_0_28",
        0 <= tourism_active_ward_count <= EXPECTED_WARD_COUNT,
        f"tourism_active_ward_count={tourism_active_ward_count}",
    )
    check_gate(
        checks,
        failures,
        "tourism_active_ward_share_range_0_100",
        0.0 <= tourism_active_ward_share_pct <= 100.0,
        f"tourism_active_ward_share_pct={tourism_active_ward_share_pct}",
    )

    protected_max_delta = None
    protected_max_delta_ward = None
    protected_changed_count = 0
    for row in protected_delta_rows:
        delta_abs = abs(row["delta_pct_points"])
        if protected_max_delta is None or delta_abs > protected_max_delta:
            protected_max_delta = delta_abs
            protected_max_delta_ward = row["ward_id"]
        if delta_abs > 0.01:
            protected_changed_count += 1

    protected_sanity = {}
    preferred_sanity_ids = ("19100115", "19100062")
    protected_by_ward = {row["ward_id"]: row for row in protected_delta_rows}
    sanity_ids = [ward_id for ward_id in preferred_sanity_ids if ward_id in protected_by_ward]
    if len(sanity_ids) < 2:
        for row in sorted(protected_delta_rows, key=lambda item: item["ward_id"]):
            ward_id = row["ward_id"]
            if ward_id in sanity_ids:
                continue
            sanity_ids.append(ward_id)
            if len(sanity_ids) == 2:
                break

    for sanity_ward_id in sanity_ids:
        row = protected_by_ward.get(sanity_ward_id)
        if row is None:
            continue
        protected_sanity[sanity_ward_id] = {
            "legacy_pct": round(row["legacy_pct"], 4),
            "recomputed_pct": round(row["recomputed_pct"], 4),
            "delta_pct_points": round(row["delta_pct_points"], 4),
        }

    missing_density_2022_rows = []
    missing_smod_rows = []
    for feature in output_features:
        p = feature["properties"]
        ward_id = p["ward_id"]
        if p.get("ghsl_pop_density_2022") is None or p.get("ghsl_density_gap_2022_vs_2030") is None:
            missing_density_2022_rows.append(ward_id)
        for field in [
            "smod_degurba_l1_2020",
            "smod_degurba_l1_2030",
            "smod_degurba_label_2020",
            "smod_degurba_label_2030",
            "smod_urban_share_2020",
            "smod_urban_share_2030",
            "smod_urban_share_change_pp",
            "smod_transition_class",
        ]:
            if p.get(field) in (None, ""):
                missing_smod_rows.append((ward_id, field))

    check_gate(
        checks,
        failures,
        "ghsl_density_2022_fields_non_null_111",
        len(missing_density_2022_rows) == 0,
        (
            f"Rows with missing density_2022/gap: {missing_density_2022_rows[:5]} "
            f"(total={len(missing_density_2022_rows)})"
        ),
    )
    check_gate(
        checks,
        failures,
        "smod_fields_non_null_111",
        len(missing_smod_rows) == 0,
        f"Missing S-Mod fields: {missing_smod_rows[:5]} (total={len(missing_smod_rows)})",
    )

    density_diff_rows = []
    max_density_diff = -1.0
    max_density_diff_ward = None
    for feature in output_features:
        p = feature["properties"]
        density = p.get("ghsl_pop_density_2030")
        pop_2030 = p.get("ghsl_pop_2030")
        area = p.get("ward_area_km2")
        ward_id = p.get("ward_id")
        if density is None or pop_2030 is None or area in (None, 0):
            density_diff_rows.append((ward_id, None))
            continue
        implied_density = pop_2030 / area
        diff = abs(density - implied_density)
        if diff > max_density_diff:
            max_density_diff = diff
            max_density_diff_ward = ward_id
        if diff > 0.1:
            density_diff_rows.append((ward_id, diff))

    check_gate(
        checks,
        failures,
        "ghsl_density_consistency_tolerance",
        len(density_diff_rows) == 0,
        (
            "Density mismatches (>0.1 persons/km2): "
            f"{density_diff_rows[:5]} (total={len(density_diff_rows)}), "
            f"max_diff={max_density_diff if max_density_diff >= 0 else None}, "
            f"worst_ward={max_density_diff_ward}"
        ),
    )

    props_by_id = {f["properties"]["ward_id"]: f["properties"] for f in output_features}
    percentile_maps = {}
    for field in set(STRESS_COMPONENT_WEIGHTS) | set(MOMENTUM_COMPONENT_WEIGHTS) | set(CONSTRAINT_COMPONENT_WEIGHTS):
        values_by_ward = {ward_id: props[field] for ward_id, props in props_by_id.items()}
        percentile_maps[field] = percentile_rank_by_ward(values_by_ward)

    stress_scores = []
    momentum_scores = []
    constraint_scores = []
    priority_scores = []

    class_count_matrix = {stress: {momentum: 0 for momentum in BANDS} for stress in BANDS}
    action_counter = Counter()

    viirs_conf_map = {"High": 100.0, "Medium": 70.0, "Low": 40.0}
    ghsl_conf_map = {"High": 100.0, "Medium": 70.0, "Low": 40.0}

    for feature in output_features:
        props = feature["properties"]

        stress_score = weighted_score(props, percentile_maps, STRESS_COMPONENT_WEIGHTS)
        momentum_score = weighted_score(props, percentile_maps, MOMENTUM_COMPONENT_WEIGHTS)
        constraint_score = weighted_score(props, percentile_maps, CONSTRAINT_COMPONENT_WEIGHTS)
        priority_risk_score = clamp_0_100(
            PRIORITY_WEIGHTS["stress_component"] * stress_score
            + PRIORITY_WEIGHTS["inverse_momentum_component"] * (100.0 - momentum_score)
            + PRIORITY_WEIGHTS["constraint_component"] * constraint_score
        )

        viirs_completeness = props.get("viirs_completeness_ratio") or 0.0
        viirs_conf = viirs_conf_map.get(props.get("viirs_confidence_flag"), 60.0)
        ghsl_conf = ghsl_conf_map.get(props.get("ghsl_forecast_confidence"), 60.0)
        score_confidence = clamp_0_100((viirs_completeness * 100.0 * 0.5) + (viirs_conf * 0.3) + (ghsl_conf * 0.2))

        props["stress_score"] = round(stress_score, 2)
        props["momentum_score"] = round(momentum_score, 2)
        props["constraint_score"] = round(constraint_score, 2)
        props["priority_risk_score"] = round(priority_risk_score, 2)
        props["score_confidence"] = round(score_confidence, 2)

        stress_scores.append(props["stress_score"])
        momentum_scores.append(props["momentum_score"])
        constraint_scores.append(props["constraint_score"])
        priority_scores.append(props["priority_risk_score"])

    stress_low, stress_high = quantile(stress_scores, 1 / 3), quantile(stress_scores, 2 / 3)
    momentum_low, momentum_high = quantile(momentum_scores, 1 / 3), quantile(momentum_scores, 2 / 3)
    constraint_low, constraint_high = quantile(constraint_scores, 1 / 3), quantile(constraint_scores, 2 / 3)
    priority_low, priority_high = quantile(priority_scores, 1 / 3), quantile(priority_scores, 2 / 3)

    for feature in output_features:
        props = feature["properties"]
        stress_band = band_for_value(props["stress_score"], stress_low, stress_high)
        momentum_band = band_for_value(props["momentum_score"], momentum_low, momentum_high)
        constraint_band = band_for_value(props["constraint_score"], constraint_low, constraint_high)
        priority_band = band_for_value(props["priority_risk_score"], priority_low, priority_high)
        biv_key = bivariate_key(stress_band, momentum_band)
        action_tag = select_action_tag(stress_band, momentum_band, constraint_band)

        props["stress_band"] = stress_band
        props["momentum_band"] = momentum_band
        props["constraint_band"] = constraint_band
        props["priority_band"] = priority_band
        props["bivariate_key"] = biv_key
        props["bivariate_class"] = f"{stress_band} stress x {momentum_band} momentum"
        props["action_tag"] = action_tag

        class_count_matrix[stress_band][momentum_band] += 1
        action_counter[action_tag] += 1

    priority_sorted = sorted(
        output_features, key=lambda f: f["properties"]["priority_risk_score"], reverse=True
    )
    for rank, feature in enumerate(priority_sorted, start=1):
        feature["properties"]["priority_rank"] = rank

    score_fields = ["stress_score", "momentum_score", "constraint_score", "priority_risk_score", "score_confidence"]
    invalid_score_wards = []
    out_of_range_wards = []
    missing_bivariate = []
    missing_action = []

    for feature in output_features:
        props = feature["properties"]
        ward_id = props["ward_id"]
        for field in score_fields:
            value = props.get(field)
            if not isinstance(value, (int, float)) or not math.isfinite(value):
                invalid_score_wards.append((ward_id, field, value))
            elif field != "score_confidence" and (value < 0 or value > 100):
                out_of_range_wards.append((ward_id, field, value))

        if not props.get("bivariate_class"):
            missing_bivariate.append(ward_id)
        if not props.get("action_tag"):
            missing_action.append(ward_id)

    check_gate(
        checks,
        failures,
        "score_fields_numeric",
        len(invalid_score_wards) == 0,
        f"Invalid score fields: {invalid_score_wards[:5]} (total={len(invalid_score_wards)})",
    )
    check_gate(
        checks,
        failures,
        "score_fields_range_0_100",
        len(out_of_range_wards) == 0,
        f"Out-of-range score fields: {out_of_range_wards[:5]} (total={len(out_of_range_wards)})",
    )
    check_gate(
        checks,
        failures,
        "bivariate_class_non_null",
        len(missing_bivariate) == 0,
        f"Missing bivariate class: {missing_bivariate[:5]} (total={len(missing_bivariate)})",
    )
    check_gate(
        checks,
        failures,
        "action_tag_non_null",
        len(missing_action) == 0,
        f"Missing action tag: {missing_action[:5]} (total={len(missing_action)})",
    )

    class_total = sum(class_count_matrix[stress][momentum] for stress in BANDS for momentum in BANDS)
    check_gate(
        checks,
        failures,
        "class_count_total_111",
        class_total == EXPECTED_WARD_COUNT,
        f"Expected {EXPECTED_WARD_COUNT}, got {class_total}",
    )

    anomaly_ids_from_props = sorted(
        [f["properties"]["ward_id"] for f in output_features if f["properties"].get("ghsl_negative_growth_flag")]
    )
    anomaly_ids_from_audit = sorted([row["ward_id"] for row in ghsl_anomalies])
    check_gate(
        checks,
        failures,
        "ghsl_anomaly_ids_match_flags",
        anomaly_ids_from_props == anomaly_ids_from_audit,
        f"props={anomaly_ids_from_props}, audit={anomaly_ids_from_audit}",
    )
    anomaly_all_negative = all((row.get("ghsl_pop_change_2022_2030") or 0) < 0 for row in ghsl_anomalies)
    check_gate(
        checks,
        failures,
        "ghsl_negative_growth_unclamped",
        anomaly_all_negative,
        f"anomaly_rows={ghsl_anomalies}",
    )

    city_viirs_timeseries = []
    for date in sorted(city_month_acc.keys()):
        entry = city_month_acc[date]
        avg = entry["sum"] / entry["count"] if entry["count"] else None
        city_viirs_timeseries.append({"date": date, "city_viirs_mean": avg})

    def top_rows(metric_key, top_n):
        rows = []
        for feature in output_features:
            value = feature["properties"].get(metric_key)
            if value is None:
                continue
            rows.append(
                {
                    "ward_id": feature["properties"]["ward_id"],
                    "ward_label": feature["properties"]["ward_label"],
                    "value": round(value, 2),
                }
            )
        rows.sort(key=lambda x: x["value"], reverse=True)
        return rows[:top_n]

    top_priority_wards = []
    for feature in priority_sorted[:15]:
        p = feature["properties"]
        top_priority_wards.append(
            {
                "ward_id": p["ward_id"],
                "ward_label": p["ward_label"],
                "priority_rank": p["priority_rank"],
                "priority_risk_score": p["priority_risk_score"],
                "stress_score": p["stress_score"],
                "momentum_score": p["momentum_score"],
                "constraint_score": p["constraint_score"],
                "action_tag": p["action_tag"],
            }
        )

    city_name_candidates = [
        canonical_city_display_name(feature["properties"].get("municipality_name"))
        for feature in output_features
        if feature["properties"].get("municipality_name")
    ]
    city_name_candidates = [name for name in city_name_candidates if name]
    city_display_name = Counter(city_name_candidates).most_common(1)[0][0] if city_name_candidates else CITY_CODE

    summary = {
        "dataset_version": DATASET_VERSION,
        "generated_at": now_iso_utc(),
        "ward_count": len(output_features),
        "city_display_name": city_display_name,
        "latest_viirs_month": latest_date,
        "viirs_growth_window_start": MIN_EXPECTED_DATE,
        "viirs_growth_window_end": latest_date,
        "viirs_index_base_month": VIIRS_INDEX_BASE_MONTH,
        "viirs_momentum_note": "Non-metro municipality: VIIRS momentum used as economic proxy (no S&P quarterly GDP available)",
        "tourism_active_ward_count": tourism_active_ward_count,
        "tourism_active_ward_share_pct": round(tourism_active_ward_share_pct, 2),
        "tourism_city_card_definition": (
            "Active ward = POI>0 OR accommodation>0 OR attraction>0 "
            "(Airbnb excluded for cross-metro comparability)"
        ),
        "comparability": {
            "normalization_scope": "kzn292_percentile",
            "cross_metro_comparable": False,
            "metro_comparison_note": (
                "Scores are percentile-normalized within KwaDukuza. "
                "Use for within-municipality prioritization; for cross-municipality comparison use pooled/common normalization."
            ),
        },
        "ghsl_cluster_semantics": {
            "display_mapping": GHSL_CLUSTER_DISPLAY_MAP,
            "display_definitions": GHSL_CLUSTER_DISPLAY_DEFINITIONS,
            "note": "Display labels are interpretation-safe aliases; raw workbook labels are preserved in content insights.",
        },
        "smod_transition_counts": smod_data["transition_counts"],
        "smod_city_urban_share_2020": smod_data["city_urban_share_2020"],
        "smod_city_urban_share_2030": smod_data["city_urban_share_2030"],
        "smod_city_urban_share_change_pp": smod_data["city_urban_share_change_pp"],
        "kpis": {
            "high_risk_wards": sum(1 for f in output_features if f["properties"]["priority_band"] == "High"),
            "critical_triage_wards": action_counter.get("Critical service triage", 0),
            "median_stress_score": round(median(stress_scores), 2),
            "median_momentum_score": round(median(momentum_scores), 2),
            "median_constraint_score": round(median(constraint_scores), 2),
            "city_viirs_latest_mean": city_viirs_timeseries[-1]["city_viirs_mean"] if city_viirs_timeseries else None,
        },
        "score_formula": {
            "normalization": "kzn292_percentile_0_100",
            "stress_score_weights": STRESS_COMPONENT_WEIGHTS,
            "momentum_score_weights": MOMENTUM_COMPONENT_WEIGHTS,
            "constraint_score_weights": CONSTRAINT_COMPONENT_WEIGHTS,
            "priority_risk_weights": PRIORITY_WEIGHTS,
        },
        "class_counts": class_count_matrix,
        "actions_summary": [{"action_tag": tag, "count": count} for tag, count in action_counter.most_common()],
        "metric_options": [
            {"id": "priority_risk_score", "label": "Priority Risk Score"},
            {"id": "stress_score", "label": "Stress Score"},
            {"id": "momentum_score", "label": "Momentum Score"},
            {"id": "constraint_score", "label": "Constraint Score"},
            {"id": "ghsl_service_pressure_2030", "label": "Service Pressure (2030)"},
            {"id": "viirs_cagr_mean", "label": "VIIRS Growth CAGR (%)"},
            {"id": "lc_urban_pct", "label": "Land Cover Urban Share (%)"},
        ],
        "top10_by_metric": {
            "priority_risk_score": top_rows("priority_risk_score", 10),
            "stress_score": top_rows("stress_score", 10),
            "momentum_score": top_rows("momentum_score", 10),
            "constraint_score": top_rows("constraint_score", 10),
            "ghsl_service_pressure_2030": top_rows("ghsl_service_pressure_2030", 10),
            "viirs_cagr_mean": top_rows("viirs_cagr_mean", 10),
            "lc_urban_pct": top_rows("lc_urban_pct", 10),
        },
        "top_priority_wards": top_priority_wards,
        "city_viirs_timeseries": city_viirs_timeseries,
    }

    content_insights, content_qa = build_content_insights(
        join_ids,
        props_by_id,
        ghsl_dashboard_xlsx=ghsl_dashboard_xlsx,
        landcover_dashboard_xlsx=landcover_dashboard_xlsx,
        viirs_dashboard_xlsx=viirs_dashboard_xlsx,
    )
    cluster_interpretation_audit = build_cluster_interpretation_audit(
        output_features, content_insights["ward_insights"]
    )

    landcover_story_by_ward = {}
    for ward in content_insights["ward_insights"]:
        landcover_story = ((ward.get("landcover") or {}).get("landcover_story_class")) or None
        if landcover_story:
            landcover_story_by_ward[ward["ward_id"]] = landcover_story

    missing_landcover_story_rows = []
    for feature in output_features:
        ward_id = feature["properties"]["ward_id"]
        feature["properties"]["landcover_story_class"] = landcover_story_by_ward.get(ward_id)
        if feature["properties"]["landcover_story_class"] in (None, ""):
            missing_landcover_story_rows.append(ward_id)

    check_gate(
        checks,
        failures,
        "landcover_story_class_non_null_111",
        len(missing_landcover_story_rows) == 0,
        (
            f"Rows with missing landcover_story_class: {missing_landcover_story_rows[:5]} "
            f"(total={len(missing_landcover_story_rows)})"
        ),
    )

    check_gate(
        checks,
        failures,
        "content_ward_coverage_111",
        len(content_qa["missing_content_ids"]) == 0 and len(content_insights["ward_insights"]) == EXPECTED_WARD_COUNT,
        (
            f"Missing content IDs: {content_qa['missing_content_ids'][:5]} "
            f"(total={len(content_qa['missing_content_ids'])}), ward insights={len(content_insights['ward_insights'])}"
        ),
    )

    required_labels_ok = all(content_qa["required_labels_resolved"].values())
    check_gate(
        checks,
        failures,
        "content_required_kpi_labels_resolved",
        required_labels_ok,
        f"Resolved labels flags: {content_qa['required_labels_resolved']}",
    )

    check_gate(
        checks,
        failures,
        "content_kpi_values_non_null",
        len(content_qa["empty_kpi_values"]) == 0,
        f"Empty KPI values: {content_qa['empty_kpi_values']}",
    )

    missing_ghsl_cluster_raw = []
    missing_ghsl_cluster_display = []
    for ward in content_insights["ward_insights"]:
        ghsl = ward.get("ghsl") or {}
        if not str(ghsl.get("ghsl_cluster_raw") or "").strip():
            missing_ghsl_cluster_raw.append(ward["ward_id"])
        if not str(ghsl.get("ghsl_cluster_display") or "").strip():
            missing_ghsl_cluster_display.append(ward["ward_id"])

    check_gate(
        checks,
        failures,
        "ghsl_cluster_raw_non_null_111",
        len(missing_ghsl_cluster_raw) == 0,
        (
            f"Rows with missing ghsl_cluster_raw: {missing_ghsl_cluster_raw[:5]} "
            f"(total={len(missing_ghsl_cluster_raw)})"
        ),
    )
    check_gate(
        checks,
        failures,
        "ghsl_cluster_display_non_null_111",
        len(missing_ghsl_cluster_display) == 0,
        (
            f"Rows with missing ghsl_cluster_display: {missing_ghsl_cluster_display[:5]} "
            f"(total={len(missing_ghsl_cluster_display)})"
        ),
    )

    cluster_audit_counts = cluster_interpretation_audit["counts_by_raw_cluster"]
    cluster_audit_total = sum(row["ward_count"] for row in cluster_audit_counts.values())
    cluster_audit_share_range_ok = all(
        0.0 <= row["negative_census_to_2030_share_pct"] <= 100.0
        and 0.0 <= row["negative_modeled_2020_to_2030_share_pct"] <= 100.0
        for row in cluster_audit_counts.values()
    )
    check_gate(
        checks,
        failures,
        "cluster_interpretation_audit_total_111",
        cluster_audit_total == EXPECTED_WARD_COUNT,
        f"Expected {EXPECTED_WARD_COUNT}, got {cluster_audit_total}",
    )
    check_gate(
        checks,
        failures,
        "cluster_interpretation_audit_share_range",
        cluster_audit_share_range_ok,
        f"Counts by raw cluster: {cluster_audit_counts}",
    )

    viirs_growth_top10 = content_insights["top_lists"]["viirs_growth_rank"][:10]
    viirs_growth_non_negative = all((row.get("value") is not None) and (row["value"] >= 0) for row in viirs_growth_top10)
    viirs_growth_descending = all(
        viirs_growth_top10[i]["value"] >= viirs_growth_top10[i + 1]["value"]
        for i in range(max(0, len(viirs_growth_top10) - 1))
    )
    check_gate(
        checks,
        failures,
        "viirs_growth_rank_top10_non_negative_descending",
        len(viirs_growth_top10) == 10 and viirs_growth_non_negative and viirs_growth_descending,
        (
            f"top10_len={len(viirs_growth_top10)}, non_negative={viirs_growth_non_negative}, "
            f"descending={viirs_growth_descending}"
        ),
    )

    wards_geojson = {"type": "FeatureCollection", "name": "kzn292_wards", "features": output_features}

    out_wards = public_data_dir / "kzn292_wards.geojson"
    out_series = public_data_dir / "kzn292_viirs_timeseries.json"
    out_summary = public_data_dir / "kzn292_summary.json"
    out_manifest = public_data_dir / "manifest.json"
    out_qa = public_data_dir / "qa_report.json"
    out_content = public_data_dir / "kzn292_content_insights.json"
    out_ghsl_audit = public_data_dir / "kzn292_ghsl_anomaly_audit.json"

    dump_json(out_wards, wards_geojson)
    dump_json(out_series, viirs_timeseries)
    dump_json(out_summary, summary)
    dump_json(out_content, content_insights)
    dump_json(
        out_ghsl_audit,
        {
            "dataset_version": DATASET_VERSION,
            "generated_at": now_iso_utc(),
            "negative_growth_ward_count": len(ghsl_anomalies),
            "base_definition": "ghsl_pop_2030 < census_pop_2022",
            "wards": ghsl_anomalies,
        },
    )

    manifest = {
        "dataset_version": DATASET_VERSION,
        "generated_at": now_iso_utc(),
        "latest_viirs_month": latest_date,
        "ward_count": len(output_features),
        "source_files": [
            source_file_info("ghsl_ward_outlook_csv", ghsl_csv),
            source_file_info("landcover_ward_gpkg", landcover_gpkg),
            source_file_info("viirs_ward_summary_csv", viirs_summary_csv),
            source_file_info("viirs_ward_monthly_csv", viirs_monthly_csv),
            source_file_info("ghsl_dashboard_xlsx", ghsl_dashboard_xlsx),
            source_file_info("landcover_dashboard_xlsx", landcover_dashboard_xlsx),
            source_file_info("viirs_dashboard_xlsx", viirs_dashboard_xlsx),
            source_file_info("smod_zonal_csv", smod_zonal_csv),
            source_file_info("protected_areas_gpkg", protected_areas_gpkg),
        ],
    }
    dump_json(out_manifest, manifest)

    data_size = compute_data_size(
        [
            out_wards,
            out_series,
            out_summary,
            out_manifest,
            out_content,
            out_ghsl_audit,
        ]
    )
    budget_guard_pass = data_size <= DATA_SIZE_GUARD_BYTES

    qa_report = {
        "status": "pass" if not failures else "fail",
        "generated_at": now_iso_utc(),
        "checks": checks,
        "failed_checks": failures,
        "density_consistency": {
            "tolerance_persons_per_km2": 0.1,
            "max_abs_diff_persons_per_km2": max_density_diff if max_density_diff >= 0 else None,
            "worst_ward_id": max_density_diff_ward,
        },
        "ghsl_negative_growth_audit": {
            "ward_count": len(ghsl_anomalies),
            "ward_ids": [row["ward_id"] for row in ghsl_anomalies],
        },
        "cluster_interpretation_audit": cluster_interpretation_audit,
        "protected_area_recompute": {
            "method": "unioned_intersection",
            "max_delta_vs_legacy_pct_points": protected_max_delta,
            "max_delta_ward_id": protected_max_delta_ward,
            "wards_changed_count": protected_changed_count,
            "sanity_wards": protected_sanity,
        },
        "budget_guard": {
            "data_size_bytes": data_size,
            "limit_bytes": DATA_SIZE_GUARD_BYTES,
            "pass": budget_guard_pass,
            "note": (
                "Data bundle exceeds 10MB; plan Blob + CDN in v2 if traffic grows"
                if not budget_guard_pass
                else "Data bundle within near-zero-cost guardrail"
            ),
        },
    }
    dump_json(out_qa, qa_report)

    if failures:
        raise RuntimeError(f"Critical QA gate failure(s): {', '.join(failures)}")

    print(f"Built data successfully in {public_data_dir}")
    print(f"Ward count: {len(output_features)} | Latest VIIRS month: {latest_date}")
    print(f"Data size: {data_size} bytes")


if __name__ == "__main__":
    main()
