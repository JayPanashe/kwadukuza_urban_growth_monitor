#!/usr/bin/env bash
set -euo pipefail

HOST="127.0.0.1"
PORT="4173"
BASE_URL="http://${HOST}:${PORT}"

npm run offline:validate >/tmp/ugm_offline_validate.log 2>&1

npm run preview -- --host "${HOST}" --port "${PORT}" >/tmp/ugm_preview.log 2>&1 &
PREVIEW_PID=$!

cleanup() {
  if kill -0 "$PREVIEW_PID" >/dev/null 2>&1; then
    kill "$PREVIEW_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

sleep 2

index_status=$(curl -s -o /tmp/ugm_index.html -w "%{http_code}" "${BASE_URL}/")
manifest_status=$(curl -s -o /tmp/ugm_manifest.json -w "%{http_code}" "${BASE_URL}/data/manifest.json")
qa_status=$(curl -s -o /tmp/ugm_qa.json -w "%{http_code}" "${BASE_URL}/data/qa_report.json")
wards_status=$(curl -s -o /tmp/ugm_wards.geojson -w "%{http_code}" "${BASE_URL}/data/kzn292_wards.geojson")
summary_status=$(curl -s -o /tmp/ugm_summary.json -w "%{http_code}" "${BASE_URL}/data/kzn292_summary.json")
series_status=$(curl -s -o /tmp/ugm_series.json -w "%{http_code}" "${BASE_URL}/data/kzn292_viirs_timeseries.json")
content_status=$(curl -s -o /tmp/ugm_content.json -w "%{http_code}" "${BASE_URL}/data/kzn292_content_insights.json")
anomaly_status=$(curl -s -o /tmp/ugm_anomaly.json -w "%{http_code}" "${BASE_URL}/data/kzn292_ghsl_anomaly_audit.json")
svg_status=$(curl -s -o /tmp/ugm_svg_mode.html -w "%{http_code}" "${BASE_URL}/?renderer=svg")
webgl_status=$(curl -s -o /tmp/ugm_webgl_mode.html -w "%{http_code}" "${BASE_URL}/?renderer=webgl")

if [[ "$index_status" != "200" || "$manifest_status" != "200" || "$qa_status" != "200" || "$wards_status" != "200" || "$summary_status" != "200" || "$series_status" != "200" || "$content_status" != "200" || "$anomaly_status" != "200" || "$svg_status" != "200" || "$webgl_status" != "200" ]]; then
  echo "Offline smoke failed: index=${index_status}, manifest=${manifest_status}, qa=${qa_status}, wards=${wards_status}, summary=${summary_status}, series=${series_status}, content=${content_status}, anomaly=${anomaly_status}, svg=${svg_status}, webgl=${webgl_status}" >&2
  exit 1
fi

echo "Offline smoke passed"
echo "index=${index_status}, manifest=${manifest_status}, qa=${qa_status}, wards=${wards_status}, summary=${summary_status}, series=${series_status}, content=${content_status}, anomaly=${anomaly_status}, svg=${svg_status}, webgl=${webgl_status}"

echo "manifest snippet:"
head -n 6 /tmp/ugm_manifest.json

echo "qa snippet:"
head -n 10 /tmp/ugm_qa.json

echo "content snippet:"
head -n 8 /tmp/ugm_content.json
