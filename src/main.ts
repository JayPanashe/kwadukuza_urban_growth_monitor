import Chart from 'chart.js/auto';
import { geoBounds, geoMercator, geoPath } from 'd3-geo';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';

type ModeId = 'ghsl-service-pressure' | 'landcover-constraints' | 'gdp-momentum';
type Band = 'Low' | 'Medium' | 'High';
type RendererPreference = 'auto' | 'webgl' | 'svg';
type ActiveRenderer = 'webgl' | 'svg';
type RankingDirection = 'top' | 'bottom';
type TransitionFocusClass = string | null;

const ACTION_FILTER_OPTIONS = [
  'All',
  'Critical service triage',
  'Accelerate capacity',
  'Near-term infrastructure investment',
  'Growth monitoring',
  'Targeted ward review',
] as const;
type ActionFilter = (typeof ACTION_FILTER_OPTIONS)[number];

const NON_STABLE_TRANSITION_CLASSES = [
  'Emerging node transition',
  'Town-to-city transition',
  'Urban core intensification',
  'Town intensification',
  'Decentralisation signal',
] as const;

const DEFAULT_GHSL_CLUSTER_DISPLAY_MAP: Record<string, string> = {
  Declining: 'Slowing',
};

type WardProps = {
  ward_id: string;
  ward_label: string;
  municipality_code: string;
  municipality_name: string;
  district_name: string;
  province_name: string;
  ghsl_pop_change_2020_2030: number;
  ghsl_pop_pct_change_2020_2030: number;
  ghsl_pop_change_2022_2030: number;
  ghsl_pop_pct_change_2022_2030: number;
  ghsl_pop_2030: number;
  ghsl_pop_density_2022: number;
  ghsl_density_gap_2022_vs_2030: number;
  ghsl_density_gap_flag: 'observed_above_forecast' | 'forecast_above_observed' | 'near_parity';
  ghsl_negative_growth_flag?: boolean;
  ghsl_built_change_2020_2030: number;
  ghsl_service_pressure_2030: number;
  ghsl_pop_density_2030: number;
  census_pop_2022: number;
  ghsl_pressure_change: number;
  ghsl_forecast_confidence: string;
  lc_urban_pct: number;
  lc_mining_pct: number;
  protected_area_pct: number;
  viirs_cagr_mean: number;
  viirs_latest_mean: number;
  viirs_growth_cluster: string;
  viirs_yoy_mean: number;
  viirs_trend_slope: number;
  viirs_proxy_momentum_component: number;
  viirs_completeness_ratio: number;
  viirs_confidence_flag: string;
  ward_area_km2: number;
  non_urban_econ_flag: number;
  smod_degurba_l1_2020: number;
  smod_degurba_l1_2030: number;
  smod_degurba_label_2020: string;
  smod_degurba_label_2030: string;
  smod_urban_share_2020: number;
  smod_urban_share_2030: number;
  smod_urban_share_change_pp: number;
  smod_transition_class: string;
  landcover_story_class: string;
  stress_score: number;
  momentum_score: number;
  constraint_score: number;
  priority_risk_score: number;
  score_confidence: number;
  stress_band: Band;
  momentum_band: Band;
  constraint_band: Band;
  priority_band: Band;
  bivariate_key: string;
  bivariate_class: string;
  action_tag: string;
  priority_rank: number;
};

type WardFeature = GeoJSON.Feature<GeoJSON.Geometry, WardProps>;

type WardCollection = {
  type: 'FeatureCollection';
  features: WardFeature[];
};

type TopRow = { ward_id: string; ward_label: string; value: number };

type LandcoverConstraintField = 'lc_urban_pct' | 'protected_area_pct' | 'lc_mining_pct' | 'non_urban_econ_flag';

type LandcoverDriverBreakdownRow = {
  field: LandcoverConstraintField;
  label: string;
  rawValue: number;
  rawDisplay: string;
  percentileRank: number;
  weight: number;
  contribution: number;
};

type LandcoverBreakdown = {
  rows: LandcoverDriverBreakdownRow[];
  computedScore: number;
  storedScore: number;
  roundingDelta: number;
};

type Summary = {
  dataset_version: string;
  generated_at: string;
  ward_count: number;
  city_display_name?: string;
  latest_viirs_month: string;
  viirs_growth_window_start?: string;
  viirs_growth_window_end?: string;
  viirs_index_base_month?: string;
  viirs_mean_cagr_pct?: number | null;
  tourism_active_ward_count?: number;
  tourism_active_ward_share_pct?: number;
  tourism_city_card_definition?: string;
  ghsl_cluster_semantics?: {
    display_mapping?: Record<string, string>;
    display_definitions?: Record<string, string>;
    note?: string;
  };
  comparability?: {
    normalization_scope?: string;
    cross_metro_comparable?: boolean;
    metro_comparison_note?: string;
  };
  smod_transition_counts?: Record<string, number>;
  smod_city_urban_share_2020?: number | null;
  smod_city_urban_share_2030?: number | null;
  smod_city_urban_share_change_pp?: number | null;
  kpis: {
    high_risk_wards: number;
    critical_triage_wards: number;
    median_stress_score: number;
    median_momentum_score: number;
    median_constraint_score: number;
    city_viirs_latest_mean: number | null;
  };
  score_formula: {
    normalization: string;
    stress_score_weights: Record<string, number>;
    momentum_score_weights: Record<string, number>;
    constraint_score_weights: Record<string, number>;
    priority_risk_weights: Record<string, number>;
  };
  class_counts: Record<Band, Record<Band, number>>;
  actions_summary: Array<{ action_tag: string; count: number }>;
  metric_options: Array<{ id: string; label: string }>;
  top10_by_metric: Record<string, TopRow[]>;
  top_priority_wards: Array<{
    ward_id: string;
    ward_label: string;
    priority_rank: number;
    priority_risk_score: number;
    stress_score: number;
    momentum_score: number;
    constraint_score: number;
    action_tag: string;
  }>;
  city_viirs_timeseries: { date: string; city_viirs_mean: number }[];
};

type Manifest = {
  dataset_version: string;
  generated_at: string;
  latest_viirs_month: string;
  ward_count: number;
};

type CityInsightKpi = {
  key: string;
  label: string;
  source: string;
  display: string | null;
  value: number | null;
};

type RankEntry = {
  ward_id: string;
  ward_label?: string;
  rank?: number;
  value?: number;
  cluster?: string | null;
};

type WardInsightRow = {
  ward_id: string;
  ward_label: string;
  viirs: {
    ward_id?: string;
    ward_label?: string;
    viirs_cagr_pct?: number;
    viirs_trend_slope?: number;
    viirs_cluster?: string | null;
    viirs_z_score?: number;
    viirs_quintile?: string | null;
    viirs_avg_latest?: number;
  };
  ghsl: {
    ward_id?: string;
    ghsl_pop?: number;
    ghsl_pop_density?: number;
    ghsl_built_per_cap?: number;
    ghsl_cluster?: string | null;
    ghsl_cluster_raw?: string | null;
    ghsl_cluster_display?: string | null;
    smod_transition_class?: string | null;
  };
  landcover: {
    ward_id?: string;
    landcover_agriculture_pct?: number;
    landcover_mining_pct?: number;
    landcover_irrigation_ratio?: number;
    landcover_ndvi_2024_mean?: number;
    landcover_agriculture_profile?: string | null;
    landcover_tourism_class?: string | null;
    landcover_story_class?: string | null;
  };
  ranks: {
    viirs_growth_rank?: number | null;
    ghsl_pop_density_rank?: number | null;
    landcover_agriculture_rank?: number | null;
  };
  why_this_ward: string[];
};

type ContentInsights = {
  dataset_version: string;
  generated_at: string;
  ward_count: number;
  city_headline_kpis: Record<string, CityInsightKpi>;
  required_labels_resolved?: {
    ghsl: boolean;
    viirs: boolean;
    landcover: boolean;
  };
  top_lists: {
    viirs_growth_rank: RankEntry[];
    viirs_decline_rank: RankEntry[];
    ghsl_pop_density: RankEntry[];
    landcover_agriculture: RankEntry[];
  };
  ward_insights: WardInsightRow[];
};

type GhslAnomalyWard = {
  ward_id: string;
  ward_label: string;
  census_pop_2022: number;
  ghsl_pop_2030: number;
  ghsl_pop_change_2022_2030: number;
  ghsl_pop_pct_change_2022_2030: number;
  forecast_confidence?: string;
  reliability_tier?: string;
  anchor_ratio_final?: number;
  anchor_fallback_level?: string;
  momentum_label?: string;
  momentum_signal?: string;
  pp_change?: number;
  service_pressure_E2030?: number;
};

type GhslAnomalyAudit = {
  dataset_version: string;
  generated_at: string;
  base_definition?: string;
  negative_growth_ward_count: number;
  wards: GhslAnomalyWard[];
};

type AppState = {
  wards: WardCollection;
  summary: Summary;
  manifest: Manifest;
  contentInsights: ContentInsights | null;
  wardInsightsById: Record<string, WardInsightRow>;
  ghslAnomalyAudit: GhslAnomalyAudit | null;
  ghslAnomalyByWard: Record<string, GhslAnomalyWard>;
  modeBreaks: Record<ModeId, number[]>;
  selectedWardId: string | null;
  selectedMode: ModeId;
  selectedActionFilter: ActionFilter;
  selectedTransitionClass: TransitionFocusClass;
  rankingDirection: RankingDirection;
  fallbackActive: boolean;
  fallbackReason: string | null;
  requestedRenderer: RendererPreference;
  activeRenderer: ActiveRenderer;
  basemapStatus: 'loading' | 'active' | 'warning' | 'disabled' | 'n/a';
  basemapWarning: string | null;
  mapFeatureCount: number;
};

type ModeConfig = {
  label: string;
  description: string;
  legendDescription?: string;
  mapField: keyof WardProps;
  mapColors: string[];
  rankingMetricLabel: string;
  rankingField: keyof WardProps;
  breakStrategy: 'quantile' | 'fixed';
  fixedBreaks?: number[];
};

const MODE_CONFIG: Record<ModeId, ModeConfig> = {
  'ghsl-service-pressure': {
    label: 'Service Pressure',
    description: 'Ward service pressure from population growth, density load, and built-environment stress indicators.',
    legendDescription: 'Service pressure classes for ward-level population and built-environment load.',
    mapField: 'ghsl_service_pressure_2030',
    mapColors: ['#fff7ec', '#fdd49e', '#fdbb84', '#fc8d59', '#d7301f'],
    rankingMetricLabel: 'Service Pressure Wards',
    rankingField: 'ghsl_pop_density_2030',
    breakStrategy: 'quantile',
  },
  'landcover-constraints': {
    label: 'Landcover Insights',
    description: 'Composite land-use insights from municipal landcover constraint drivers.',
    legendDescription: 'Constraint score classes (0-100) from landcover and economic-context drivers.',
    mapField: 'constraint_score',
    mapColors: ['#ffffcc', '#c7e9b4', '#7fcdbb', '#41b6c4', '#225ea8'],
    rankingMetricLabel: 'Landcover Insight Wards',
    rankingField: 'constraint_score',
    breakStrategy: 'quantile',
  },
  'gdp-momentum': {
    label: 'VIIRS Momentum',
    description: 'VIIRS nighttime light radiance is used as a proxy for economic activity in non-metro municipalities where quarterly economic disaggregation is unavailable. Higher VIIRS CAGR indicates stronger economic momentum.',
    legendDescription: 'VIIRS momentum classes (CAGR %) with zero as the decline/growth cutoff.',
    mapField: 'viirs_cagr_mean',
    mapColors: ['#b2182b', '#ef8a62', '#f7f7f7', '#d9f0d3', '#7fbf7b', '#1b7837'],
    rankingMetricLabel: 'VIIRS Momentum Wards',
    rankingField: 'viirs_cagr_mean',
    breakStrategy: 'fixed',
    fixedBreaks: [-3, -1, 0, 1, 3],
  },
};

const APP_HTML = `
<div class="ugm-app">
  <header class="ugm-hero">
    <img class="ugm-brand-logo" src="/brand/spatial-econ-logo.png" alt="Spatial Econ logo" />
    <div class="ugm-hero-main">
      <p class="ugm-eyebrow">KwaDukuza Pilot</p>
      <h1>Urban Growth Monitor <span class="ugm-version">kzn292-v2.6.9</span></h1>
      <p class="ugm-subtitle">Hyperlocal Intelligence</p>
    </div>
  </header>

  <section class="ugm-selection-bar" id="selectionBar">
    <span id="selectedWardChip" class="ugm-selected-chip">Selected: Citywide view</span>
    <button id="clearSelectionBtn" class="ugm-clear-selection is-hidden" type="button" aria-label="Clear selected ward" disabled>Clear selection</button>
  </section>

  <section class="ugm-tabs" id="modeTabs">
    <button class="ugm-tab is-active" data-mode="ghsl-service-pressure">Service Pressure</button>
    <button class="ugm-tab" data-mode="landcover-constraints">Landcover Insights</button>
    <button class="ugm-tab" data-mode="gdp-momentum">VIIRS Momentum</button>
  </section>

  <section class="ugm-controls">
    <article class="ugm-filter-card">
      <h4>Action Tag Filter</h4>
      <div id="actionFilterBar" class="ugm-action-filter"></div>
      <small id="filterHelp" class="ugm-control-hint">Map dims non-matching wards, rankings use active filter, and ward selections remain explicit.</small>
    </article>
    <article class="ugm-formula" id="formulaCard"></article>
  </section>

  <section class="ugm-kpis" id="kpiGrid"></section>

  <section class="ugm-main-grid">
    <div class="ugm-left-col">
      <div class="ugm-map-wrap" id="mapWrap">
        <div id="mapCanvas"></div>
        <svg id="fallbackMap" aria-label="Fallback ward map"></svg>
        <div id="fallbackBadge" class="ugm-fallback-badge" hidden></div>
        <div id="mapTooltip" class="ugm-map-tooltip" hidden></div>
        <div class="ugm-map-legend" id="legend"></div>
      </div>

      <section class="ugm-chart-panel ugm-trend-panel">
        <h3 id="trendTitle">Mode Context</h3>
        <p id="trendSubtitle" class="ugm-chart-sub">Loading trend context...</p>
        <div id="trendContext" class="ugm-trend-context" hidden></div>
        <div class="ugm-canvas ugm-canvas-lg" id="trendCanvasWrap"><canvas id="trendChart"></canvas></div>
      </section>
    </div>

    <aside class="ugm-side-panel">
      <article class="ugm-panel">
        <h3>Selected Ward Action Card</h3>
        <div id="wardHeadline">Click a ward to inspect risk and intervention priority.</div>
      </article>
      <article class="ugm-panel">
        <h3>Drivers</h3>
        <div id="driverBars">Select a ward to see driver contributions.</div>
      </article>
      <article class="ugm-panel">
        <div class="ugm-ranking-head">
          <h3 id="rankingTitle">Top 10 Service Pressure Wards</h3>
          <div class="ugm-rank-toggle" id="rankToggle">
            <button type="button" class="ugm-rank-btn is-active" data-ranking-direction="top">Top 10</button>
            <button type="button" class="ugm-rank-btn" data-ranking-direction="bottom">Bottom 10</button>
          </div>
        </div>
        <div class="ugm-chart-sub" id="rankingSubtitle"></div>
        <div class="ugm-canvas ugm-canvas-sm"><canvas id="rankingChart"></canvas></div>
      </article>
    </aside>
  </section>

  <footer class="ugm-diagnostics-footer">
    <section class="ugm-status" id="statusBar">
      <span id="manifestBadge">Loading datasets...</span>
      <span id="dataBadge">Preparing ward intelligence...</span>
      <span id="renderBadge">Initializing renderer...</span>
    </section>
    <section class="ugm-runtime" id="runtimeDiag"></section>
  </footer>
</div>
`;

function formatNumber(value: number, fractionDigits = 2): string {
  return new Intl.NumberFormat('en-ZA', {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits,
  }).format(value);
}

function safeRound(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  return formatNumber(value, digits);
}

function safePercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatNumber(value, digits)}%`;
}

function safeSignedNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatNumber(value, digits)}`;
}

function withUnit(value: string, unit: string): string {
  return value === 'n/a' ? value : `${value} ${unit}`;
}

function formatDensity(value: number | null | undefined): string {
  return withUnit(safeRound(value, 0), 'persons/km²');
}

function tourismClassLabel(value: string | null | undefined): string {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.toLowerCase() === 'none') return 'Limited tourism signal';
  return normalized;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return char;
    }
  });
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return `${fallback}: ${error.message.trim()}`;
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return `${fallback}: ${error.trim()}`;
  }
  return fallback;
}

function parseRendererPref(search: string): RendererPreference {
  const value = new URLSearchParams(search).get('renderer');
  if (value === 'svg' || value === 'webgl') return value;
  return 'auto';
}

function getBounds(wards: WardCollection): [[number, number], [number, number]] {
  const bounds = geoBounds(wards as unknown as any);
  return [
    [bounds[0][0], bounds[0][1]],
    [bounds[1][0], bounds[1][1]],
  ];
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status}`);
  }
  return (await response.json()) as T;
}

function getWardFeature(wards: WardCollection, wardId: string | null): WardFeature | undefined {
  if (!wardId) return undefined;
  return wards.features.find((feature) => feature.properties.ward_id === wardId);
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const left = sorted[base] ?? sorted[sorted.length - 1] ?? 0;
  const right = sorted[base + 1] ?? left;
  return left + rest * (right - left);
}

function metricValue(feature: WardFeature, mode: ModeId): number {
  const key = MODE_CONFIG[mode].mapField;
  const value = feature.properties[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function modeValues(wards: WardCollection, mode: ModeId): number[] {
  return wards.features
    .map((feature) => metricValue(feature, mode))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
}

function enforceStrictAscendingBreaks(values: number[]): number[] {
  const out = [...values];
  for (let i = 0; i < out.length; i += 1) {
    if (!Number.isFinite(out[i])) out[i] = i === 0 ? 0 : out[i - 1] + 0.000001;
    if (i > 0 && out[i] <= out[i - 1]) out[i] = out[i - 1] + 0.000001;
  }
  return out;
}

function computeQuantileBreaks(values: number[], classCount: number): number[] {
  if (values.length === 0 || classCount <= 1) return [];
  const rawBreaks: number[] = [];
  for (let i = 1; i < classCount; i += 1) {
    rawBreaks.push(quantile(values, i / classCount));
  }
  return enforceStrictAscendingBreaks(rawBreaks);
}

function computeModeBreaks(wards: WardCollection, mode: ModeId): number[] {
  const cfg = MODE_CONFIG[mode];
  if (cfg.breakStrategy === 'fixed') {
    return [...(cfg.fixedBreaks ?? [])];
  }
  return computeQuantileBreaks(modeValues(wards, mode), cfg.mapColors.length);
}

function colorForValue(mode: ModeId, value: number, breaks: number[]): string {
  const colors = MODE_CONFIG[mode].mapColors;
  if (colors.length === 0) return '#cccccc';
  for (let i = 0; i < breaks.length; i += 1) {
    if (value <= breaks[i]) return colors[Math.min(i, colors.length - 1)];
  }
  return colors[Math.min(breaks.length, colors.length - 1)];
}

function modeColorExpression(mode: ModeId, breaks: number[]): unknown[] {
  const cfg = MODE_CONFIG[mode];
  const field = String(cfg.mapField);
  const expression: unknown[] = [
    'step',
    ['coalesce', ['to-number', ['get', field]], 0],
    cfg.mapColors[0],
  ];
  for (let i = 0; i < breaks.length; i += 1) {
    expression.push(breaks[i], cfg.mapColors[Math.min(i + 1, cfg.mapColors.length - 1)]);
  }
  return expression;
}

function defaultLegendLabels(breaks: number[], classCount: number): string[] {
  if (classCount <= 1) return ['All values'];
  if (breaks.length === 0) return Array.from({ length: classCount }, () => 'n/a');
  const labels: string[] = [];
  for (let i = 0; i < classCount; i += 1) {
    if (i === 0) labels.push(`<= ${formatNumber(breaks[0], 2)}`);
    else if (i === classCount - 1) labels.push(`> ${formatNumber(breaks[breaks.length - 1], 2)}`);
    else labels.push(`${formatNumber(breaks[i - 1], 2)} - ${formatNumber(breaks[i], 2)}`);
  }
  return labels;
}

function renderLegend(mode: ModeId, breaks: number[], wards: WardCollection): string {
  const colors = MODE_CONFIG[mode].mapColors;
  const legendDescription = MODE_CONFIG[mode].legendDescription ?? MODE_CONFIG[mode].description;
  let labels = defaultLegendLabels(breaks, colors.length);
  let legendNote = '';

  if (mode === 'landcover-constraints') {
    const values = modeValues(wards, mode);
    const minValue = values[0] ?? 0;
    const maxValue = values[values.length - 1] ?? 0;
    const percentileBands = ['P0-20', 'P20-40', 'P40-60', 'P60-80', 'P80-100'];
    labels = colors.map((_, idx) => {
      const band = percentileBands[idx] ?? `P${Math.round((idx / colors.length) * 100)}-${Math.round(((idx + 1) / colors.length) * 100)}`;
      const lo = idx === 0 ? minValue : breaks[idx - 1];
      const hi = idx === colors.length - 1 ? maxValue : breaks[idx];
      return `${band} (${formatNumber(lo, 1)} - ${formatNumber(hi, 1)})`;
    });
    legendNote = 'Percentile classes on Constraint Score (0-100).';
  } else if (mode === 'gdp-momentum') {
    labels = ['<= -3%', '-3% to -1%', '-1% to 0%', '0% to 1%', '1% to 3%', '> 3%'];
    legendNote = '0% is the growth/decline cutoff.';
  }

  const items = colors
    .map((color, idx) => `<li><span style="background:${color}"></span><small>${labels[idx] ?? ''}</small></li>`)
    .join('');
  return `
    <h4>${MODE_CONFIG[mode].label}</h4>
    <p>${legendDescription}</p>
    <ul class="ugm-legend-scale">${items}</ul>
    ${legendNote ? `<small class="ugm-legend-note">${legendNote}</small>` : ''}
  `;
}

function percentileRankFromPairs(pairs: Array<{ wardId: string; value: number }>): Map<string, number> {
  const sortedPairs = pairs
    .filter((row) => Number.isFinite(row.value))
    .sort((a, b) => a.value - b.value);
  const ranks = new Map<string, number>();
  const n = sortedPairs.length;
  if (n === 0) return ranks;
  if (n === 1) {
    ranks.set(sortedPairs[0].wardId, 50.0);
    return ranks;
  }

  let i = 0;
  while (i < n) {
    let j = i + 1;
    while (j < n && sortedPairs[j].value === sortedPairs[i].value) {
      j += 1;
    }

    const avgPos = (i + j - 1) / 2.0;
    const rank = (avgPos / (n - 1)) * 100.0;
    for (let k = i; k < j; k += 1) {
      ranks.set(sortedPairs[k].wardId, rank);
    }
    i = j;
  }

  return ranks;
}

function percentileRankByWard(wards: WardCollection, field: LandcoverConstraintField): Map<string, number> {
  return percentileRankFromPairs(
    wards.features.map((feature) => ({
      wardId: feature.properties.ward_id,
      value: Number(feature.properties[field]),
    })),
  );
}

function kpiDisplay(kpi: CityInsightKpi | undefined, fallback: string): string {
  if (!kpi) return fallback;
  if (kpi.display && kpi.display.trim().length > 0) return kpi.display;
  if (kpi.value !== null && Number.isFinite(kpi.value)) return formatNumber(kpi.value, 2);
  return fallback;
}

function wardNumberFromLabel(label: string): string {
  const labelMatch = String(label).match(/(\d{1,3})$/);
  if (labelMatch) return String(Number(labelMatch[1]));
  const anyMatch = String(label).match(/(\d+)/);
  if (anyMatch) return String(Number(anyMatch[1]));
  return label;
}

function wardName(feature: WardFeature): string {
  const number = wardNumberFromLabel(feature.properties.ward_label);
  return `Ward ${number}`;
}

function wardNameWithLabel(feature: WardFeature): string {
  return `${wardName(feature)} (${feature.properties.ward_label})`;
}

function ghslClusterDisplayLabel(summary: Summary, ghsl: WardInsightRow['ghsl'] | undefined): string {
  const explicitDisplay = String(ghsl?.ghsl_cluster_display ?? '').trim();
  if (explicitDisplay.length > 0) return explicitDisplay;

  const rawCluster =
    String(ghsl?.ghsl_cluster_raw ?? '').trim() || String(ghsl?.ghsl_cluster ?? '').trim() || 'Unclassified';
  const mapping = summary.ghsl_cluster_semantics?.display_mapping ?? DEFAULT_GHSL_CLUSTER_DISPLAY_MAP;
  return mapping[rawCluster] ?? rawCluster;
}

function ghslSlowingDefinition(summary: Summary): string {
  const configured = String(summary.ghsl_cluster_semantics?.display_definitions?.Slowing ?? '').trim();
  if (configured.length > 0) return configured;
  return 'Lower relative growth momentum in this cluster model; not automatic population decline.';
}

function actionFilterFromText(value: string): ActionFilter {
  return (ACTION_FILTER_OPTIONS.find((entry) => entry === value) ?? 'All') as ActionFilter;
}

function buildIndexedSeries(
  orderedDates: string[],
  valueByDate: Map<string, number>,
  baseDate: string,
): Array<number | null> {
  const fallbackBase = orderedDates.find((date) => {
    const value = valueByDate.get(date);
    return value !== undefined && value !== null && Number.isFinite(value) && value > 0;
  });
  const effectiveBaseDate = valueByDate.get(baseDate) && (valueByDate.get(baseDate) ?? 0) > 0 ? baseDate : fallbackBase;
  const baseValue = effectiveBaseDate ? valueByDate.get(effectiveBaseDate) ?? null : null;
  if (baseValue === null || !Number.isFinite(baseValue) || baseValue <= 0) {
    return orderedDates.map(() => null);
  }
  return orderedDates.map((date) => {
    const value = valueByDate.get(date);
    if (value === undefined || value === null || !Number.isFinite(value)) return null;
    return (value / baseValue) * 100.0;
  });
}

function actionChipClass(actionTag: string): string {
  return `ugm-action-chip ${`ugm-action-${actionTag.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}`;
}

async function bootstrap(): Promise<void> {
  const app = document.querySelector<HTMLDivElement>('#app');
  if (!app) return;
  if (app.dataset.booted === '1') return;
  app.dataset.booted = '1';
  app.innerHTML = APP_HTML;

  const requestedRenderer = parseRendererPref(window.location.search);

  const manifestBadge = document.querySelector<HTMLSpanElement>('#manifestBadge')!;
  const dataBadge = document.querySelector<HTMLSpanElement>('#dataBadge')!;
  const renderBadge = document.querySelector<HTMLSpanElement>('#renderBadge')!;
  const selectedWardChip = document.querySelector<HTMLSpanElement>('#selectedWardChip')!;
  const clearSelectionBtn = document.querySelector<HTMLButtonElement>('#clearSelectionBtn')!;
  const runtimeDiag = document.querySelector<HTMLDivElement>('#runtimeDiag')!;
  const actionFilterBar = document.querySelector<HTMLDivElement>('#actionFilterBar')!;
  const formulaCard = document.querySelector<HTMLDivElement>('#formulaCard')!;
  const kpiGrid = document.querySelector<HTMLDivElement>('#kpiGrid')!;
  const legend = document.querySelector<HTMLDivElement>('#legend')!;
  const wardHeadline = document.querySelector<HTMLDivElement>('#wardHeadline')!;
  const driverBars = document.querySelector<HTMLDivElement>('#driverBars')!;
  const fallbackBadge = document.querySelector<HTMLDivElement>('#fallbackBadge')!;
  const leftCol = document.querySelector<HTMLDivElement>('.ugm-left-col')!;
  const sidePanel = document.querySelector<HTMLElement>('.ugm-side-panel')!;
  const trendPanel = document.querySelector<HTMLElement>('.ugm-trend-panel')!;
  const mapWrap = document.querySelector<HTMLDivElement>('#mapWrap')!;
  const mapCanvas = document.querySelector<HTMLDivElement>('#mapCanvas')!;
  const fallbackMap = document.querySelector<SVGSVGElement>('#fallbackMap')!;
  const mapTooltip = document.querySelector<HTMLDivElement>('#mapTooltip')!;
  const rankingTitle = document.querySelector<HTMLHeadingElement>('#rankingTitle')!;
  const rankingSubtitle = document.querySelector<HTMLDivElement>('#rankingSubtitle')!;
  const rankingDirectionButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-ranking-direction]'),
  );
  const trendTitle = document.querySelector<HTMLHeadingElement>('#trendTitle')!;
  const trendSubtitle = document.querySelector<HTMLParagraphElement>('#trendSubtitle')!;
  const trendContext = document.querySelector<HTMLDivElement>('#trendContext')!;
  const trendCanvasWrap = document.querySelector<HTMLDivElement>('#trendCanvasWrap')!;

  const [manifest, wards, summary] = await Promise.all([
    fetchJson<Manifest>('/data/manifest.json'),
    fetchJson<WardCollection>('/data/kzn292_wards.geojson'),
    fetchJson<Summary>('/data/kzn292_summary.json'),
  ]);

  let contentInsights: ContentInsights | null = null;
  try {
    contentInsights = await fetchJson<ContentInsights>('/data/kzn292_content_insights.json');
  } catch {
    contentInsights = null;
  }

  let ghslAnomalyAudit: GhslAnomalyAudit | null = null;
  try {
    ghslAnomalyAudit = await fetchJson<GhslAnomalyAudit>('/data/kzn292_ghsl_anomaly_audit.json');
  } catch {
    ghslAnomalyAudit = null;
  }

  const wardInsightsById: Record<string, WardInsightRow> = {};
  for (const wardInsight of contentInsights?.ward_insights ?? []) {
    wardInsightsById[wardInsight.ward_id] = wardInsight;
  }
  const ghslAnomalyByWard: Record<string, GhslAnomalyWard> = {};
  for (const anomalyWard of ghslAnomalyAudit?.wards ?? []) {
    ghslAnomalyByWard[anomalyWard.ward_id] = anomalyWard;
  }
  const wardLabelById = new Map(
    wards.features.map((feature) => [feature.properties.ward_id, wardNameWithLabel(feature)] as const),
  );

  const landcoverDriverLabels: Record<LandcoverConstraintField, string> = {
    lc_urban_pct: 'Urban Share',
    protected_area_pct: 'Protected Area',
    lc_mining_pct: 'Mining Share',
    non_urban_econ_flag: 'Non-Urban Econ Flag',
  };

  const landcoverFallbackWeights: Record<LandcoverConstraintField, number> = {
    lc_urban_pct: 0.35,
    protected_area_pct: 0.25,
    lc_mining_pct: 0.2,
    non_urban_econ_flag: 0.2,
  };

  const landcoverWeights: Record<LandcoverConstraintField, number> = {
    lc_urban_pct: summary.score_formula.constraint_score_weights.lc_urban_pct ?? landcoverFallbackWeights.lc_urban_pct,
    protected_area_pct:
      summary.score_formula.constraint_score_weights.protected_area_pct ?? landcoverFallbackWeights.protected_area_pct,
    lc_mining_pct: summary.score_formula.constraint_score_weights.lc_mining_pct ?? landcoverFallbackWeights.lc_mining_pct,
    non_urban_econ_flag:
      summary.score_formula.constraint_score_weights.non_urban_econ_flag ?? landcoverFallbackWeights.non_urban_econ_flag,
  };

  const landcoverPercentiles: Record<LandcoverConstraintField, Map<string, number>> = {
    lc_urban_pct: percentileRankByWard(wards, 'lc_urban_pct'),
    protected_area_pct: percentileRankByWard(wards, 'protected_area_pct'),
    lc_mining_pct: percentileRankByWard(wards, 'lc_mining_pct'),
    non_urban_econ_flag: percentileRankByWard(wards, 'non_urban_econ_flag'),
  };

  function buildLandcoverBreakdown(feature: WardFeature): LandcoverBreakdown {
    const p = feature.properties;
    const fields: LandcoverConstraintField[] = ['lc_urban_pct', 'protected_area_pct', 'lc_mining_pct', 'non_urban_econ_flag'];
    const rows = fields.map((field) => {
      const rawValue = Number(p[field]);
      const percentileRank = landcoverPercentiles[field].get(p.ward_id) ?? 0;
      const weight = landcoverWeights[field];
      const contribution = percentileRank * weight;

      let rawDisplay = 'n/a';
      if (field === 'non_urban_econ_flag') {
        rawDisplay = safeRound(rawValue, 2);
      } else {
        rawDisplay = safePercent(rawValue, 1);
      }

      return {
        field,
        label: landcoverDriverLabels[field],
        rawValue,
        rawDisplay,
        percentileRank,
        weight,
        contribution,
      };
    });

    const computedScore = rows.reduce((total, row) => total + row.contribution, 0);
    const storedScore = Number(p.constraint_score);
    const roundingDelta = storedScore - computedScore;

    return {
      rows,
      computedScore,
      storedScore,
      roundingDelta,
    };
  }

  const modeBreaks: Record<ModeId, number[]> = {
    'ghsl-service-pressure': computeModeBreaks(wards, 'ghsl-service-pressure'),
    'landcover-constraints': computeModeBreaks(wards, 'landcover-constraints'),
    'gdp-momentum': computeModeBreaks(wards, 'gdp-momentum'),
  };

  const state: AppState = {
    wards,
    summary,
    manifest,
    contentInsights,
    wardInsightsById,
    ghslAnomalyAudit,
    ghslAnomalyByWard,
    modeBreaks,
    selectedWardId: null,
    selectedMode: 'ghsl-service-pressure',
    selectedActionFilter: 'All',
    selectedTransitionClass: null,
    rankingDirection: 'top',
    fallbackActive: false,
    fallbackReason: null,
    requestedRenderer,
    activeRenderer: 'webgl',
    basemapStatus: requestedRenderer === 'svg' ? 'n/a' : 'loading',
    basemapWarning: null,
    mapFeatureCount: 0,
  };

  const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.ugm-tab'));

  const rankingCanvas = document.querySelector<HTMLCanvasElement>('#rankingChart')!;
  const trendCanvas = document.querySelector<HTMLCanvasElement>('#trendChart')!;
  let currentRankingRows: Array<{ ward_id: string; ward_label: string; value: number }> = [];

  const rankingChart = new Chart<'bar', number[], string>(rankingCanvas, {
    type: 'bar',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Top Wards',
          data: [],
          borderRadius: 6,
          backgroundColor: '#e1792d',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      onClick: (_event, elements) => {
        const index = elements[0]?.index;
        if (index === undefined) return;
        const row = currentRankingRows[index];
        if (!row) return;
        applyWardSelection(row.ward_id);
      },
      scales: {
        x: {
          ticks: { color: '#203046', autoSkip: false, maxRotation: 0, minRotation: 0 },
        },
        y: {
          beginAtZero: true,
          ticks: {
            color: '#203046',
            callback: (value) => {
              const n = Number(value);
              if (!Number.isFinite(n)) return String(value);
              if (state.selectedMode === 'gdp-momentum') return `${formatNumber(n, 1)}%`;
              if (state.selectedMode === 'landcover-constraints') return formatNumber(n, 1);
              return formatNumber(n, 0);
            },
          },
        },
      },
    },
  });

  const trendChart = new Chart<'line', (number | null)[], string>(trendCanvas, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Selected ward',
          data: [],
          borderColor: '#2c6db3',
          backgroundColor: 'rgba(44, 109, 179, 0.08)',
          fill: false,
          tension: 0.2,
          pointRadius: 1.8,
        },
        {
          label: 'City reference',
          data: [],
          borderColor: '#9d5f2a',
          borderDash: [5, 4],
          backgroundColor: 'rgba(157, 95, 42, 0.08)',
          fill: false,
          tension: 0.2,
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: true } },
      scales: {
        x: { ticks: { color: '#203046', maxTicksLimit: 8 } },
        y: { ticks: { color: '#203046' } },
      },
    },
  });

  let map: maplibregl.Map | null = null;
  let mapLoaded = false;
  let fallbackPaths: SVGPathElement[] = [];
  let tooltipWardKey = '';
  let tooltipContent = '';

  const actionFilterButtons = new Map<ActionFilter, HTMLButtonElement>();
  const rankingDirectionButtonMap = new Map<RankingDirection, HTMLButtonElement>();
  let heightSyncRaf: number | null = null;
  let resizeDebounceTimer: number | null = null;
  let resizeObserver: ResizeObserver | null = null;

  function clearBottomPanelHeight(): void {
    sidePanel.style.removeProperty('min-height');
    trendPanel.style.removeProperty('height');
    trendPanel.style.removeProperty('min-height');
  }

  function syncBottomPanelHeight(): void {
    if (window.innerWidth <= 1180) {
      clearBottomPanelHeight();
      return;
    }

    const minTrendPanelHeight = 320;
    const mapHeight = mapWrap.getBoundingClientRect().height;
    const leftGap = Number.parseFloat(getComputedStyle(leftCol).rowGap || '0') || 0;
    const minimumSideHeight = Math.round(mapHeight + leftGap + minTrendPanelHeight);
    const sideMinHeight = `${minimumSideHeight}px`;
    if (sidePanel.style.minHeight !== sideMinHeight) {
      sidePanel.style.minHeight = sideMinHeight;
    }

    const measuredSideHeight = sidePanel.getBoundingClientRect().height;
    const effectiveSideHeight = Math.max(measuredSideHeight, minimumSideHeight);
    const targetHeight = effectiveSideHeight - mapHeight - leftGap;
    if (!Number.isFinite(targetHeight) || targetHeight <= 0) {
      clearBottomPanelHeight();
      return;
    }
    const clampedHeight = `${Math.max(minTrendPanelHeight, Math.round(targetHeight))}px`;
    if (trendPanel.style.height !== clampedHeight) {
      trendPanel.style.height = clampedHeight;
    }
    if (trendPanel.style.minHeight !== clampedHeight) {
      trendPanel.style.minHeight = clampedHeight;
    }
  }

  function scheduleBottomPanelSync(): void {
    if (heightSyncRaf !== null) {
      window.cancelAnimationFrame(heightSyncRaf);
    }
    heightSyncRaf = window.requestAnimationFrame(() => {
      heightSyncRaf = null;
      syncBottomPanelHeight();
    });
  }

  function isTransitionFocusActive(): boolean {
    return state.selectedMode === 'ghsl-service-pressure' && Boolean(state.selectedTransitionClass);
  }

  function isWardVisibleByFilter(feature: WardFeature): boolean {
    if (state.selectedActionFilter === 'All') return true;
    return feature.properties.action_tag === state.selectedActionFilter;
  }

  function isWardVisibleByFilterId(wardId: string): boolean {
    const feature = getWardFeature(state.wards, wardId);
    if (!feature) return false;
    return isWardVisibleByFilter(feature);
  }

  function isWardInTransitionFocus(feature: WardFeature): boolean {
    if (!isTransitionFocusActive()) return true;
    return feature.properties.smod_transition_class === state.selectedTransitionClass;
  }

  function isWardVisibleOnMap(feature: WardFeature): boolean {
    return isWardVisibleByFilter(feature) && isWardInTransitionFocus(feature);
  }

  function transitionWardsByClass(): Record<string, WardFeature[]> {
    const grouped: Record<string, WardFeature[]> = {};
    for (const feature of state.wards.features) {
      const transitionClass = feature.properties.smod_transition_class || 'Unknown';
      grouped[transitionClass] = grouped[transitionClass] ?? [];
      grouped[transitionClass].push(feature);
    }
    for (const list of Object.values(grouped)) {
      list.sort((a, b) => {
        const shiftDiff = b.properties.smod_urban_share_change_pp - a.properties.smod_urban_share_change_pp;
        if (Math.abs(shiftDiff) > 1e-12) return shiftDiff;
        return a.properties.ward_label.localeCompare(b.properties.ward_label);
      });
    }
    return grouped;
  }

  function setTransitionFocus(nextClass: string | null): void {
    state.selectedTransitionClass = nextClass;
    updateMapColors();
    updateTrendChart();
    updateRuntimeDiag();
    scheduleBottomPanelSync();
  }

  function showMapTooltip(feature: WardFeature, x: number, y: number): void {
    let metricText = '';
    if (state.selectedMode === 'ghsl-service-pressure') {
      metricText = `Pressure ${safeRound(feature.properties.ghsl_service_pressure_2030, 1)} • 2022 density ${formatDensity(
        feature.properties.ghsl_pop_density_2022,
      )} • 2030 density ${formatDensity(feature.properties.ghsl_pop_density_2030)}`;
    } else if (state.selectedMode === 'landcover-constraints') {
      metricText = `${feature.properties.landcover_story_class} • Constraint ${safeRound(
        feature.properties.constraint_score,
        1,
      )}/100 • Urban ${safePercent(feature.properties.lc_urban_pct, 1)} • Protected ${safePercent(
        feature.properties.protected_area_pct,
        1,
      )} • Mining ${safePercent(feature.properties.lc_mining_pct, 1)}`;
    } else {
      metricText = `VIIRS CAGR ${safePercent(feature.properties.viirs_cagr_mean, 1)}`;
    }
    const content = `${wardNameWithLabel(feature)} • ${metricText} • ${feature.properties.action_tag}`;
    const wardKey = `${state.selectedMode}:${feature.properties.ward_id}`;
    if (wardKey !== tooltipWardKey || content !== tooltipContent) {
      mapTooltip.textContent = content;
      tooltipWardKey = wardKey;
      tooltipContent = content;
    }
    if (mapTooltip.hidden) {
      mapTooltip.hidden = false;
    }
    const clampedX = Math.max(10, Math.min(x + 12, mapWrap.clientWidth - 300));
    const clampedY = Math.max(10, Math.min(y + 12, mapWrap.clientHeight - 40));
    mapTooltip.style.left = `${clampedX}px`;
    mapTooltip.style.top = `${clampedY}px`;
  }

  function hideMapTooltip(): void {
    mapTooltip.hidden = true;
    tooltipWardKey = '';
    tooltipContent = '';
  }

  function updateRuntimeDiag(): void {
    runtimeDiag.innerHTML = `
      <span>Requested renderer: <strong>${state.requestedRenderer}</strong></span>
      <span>Active renderer: <strong>${state.activeRenderer}</strong></span>
      <span>Loaded ward features: <strong>${state.mapFeatureCount}</strong></span>
      <span>Action filter: <strong>${state.selectedActionFilter}</strong></span>
      <span>Transition focus: <strong>${state.selectedTransitionClass ?? 'none'}</strong></span>
      <span>Basemap: <strong>${state.basemapStatus}</strong></span>
      ${state.basemapWarning ? `<span>Basemap detail: <strong>${escapeHtml(state.basemapWarning)}</strong></span>` : ''}
      <span>Fallback reason: <strong>${state.fallbackReason ?? 'none'}</strong></span>
    `;
  }

  function setRenderBadge(): void {
    if (state.fallbackActive) {
      renderBadge.textContent = `Fallback mode active (offline-safe renderer)${
        state.fallbackReason ? ` · ${state.fallbackReason}` : ''
      } · Basemap not shown in SVG fallback`;
      return;
    }
    if (state.basemapStatus === 'warning' || state.basemapStatus === 'disabled') {
      renderBadge.textContent = 'WebGL wards active • Basemap temporarily unavailable';
      return;
    }
    renderBadge.textContent = mapLoaded ? 'WebGL map renderer active' : 'Initializing map renderer...';
  }

  function updateActionFilterButtons(): void {
    for (const [tag, button] of actionFilterButtons.entries()) {
      button.classList.toggle('is-active', tag === state.selectedActionFilter);
    }
  }

  function updateRankingDirectionButtons(): void {
    for (const [direction, button] of rankingDirectionButtonMap.entries()) {
      button.classList.toggle('is-active', direction === state.rankingDirection);
    }
  }

  function updateSelectedWardChip(): void {
    const feature = getWardFeature(state.wards, state.selectedWardId);
    if (!feature) {
      selectedWardChip.classList.remove('is-selected');
      selectedWardChip.textContent = 'Selected: Citywide view';
      clearSelectionBtn.classList.add('is-hidden');
      clearSelectionBtn.disabled = true;
      return;
    }

    const wardText = `Selected: ${wardName(feature)} • ${feature.properties.ward_id}`;
    const actionText = escapeHtml(feature.properties.action_tag);
    const landcoverStoryText =
      state.selectedMode === 'landcover-constraints'
        ? escapeHtml(`Story: ${feature.properties.landcover_story_class || 'Unclassified'}`)
        : '';
    selectedWardChip.classList.add('is-selected');
    selectedWardChip.innerHTML = `
      <span>${escapeHtml(wardText)}</span>
      ${landcoverStoryText ? `<span class="ugm-story-chip">${landcoverStoryText}</span>` : ''}
      <span class="${actionChipClass(feature.properties.action_tag)}">${actionText}</span>
    `;
    clearSelectionBtn.classList.remove('is-hidden');
    clearSelectionBtn.disabled = false;
  }

  function updateFormulaCard(): void {
    const mode = MODE_CONFIG[state.selectedMode];
    if (state.selectedMode === 'ghsl-service-pressure') {
      formulaCard.innerHTML = `
        <h4>${mode.label}</h4>
        <p>${mode.description}</p>
        <p>Read this mode as an insight story: settlement transition, built-form pressure, and Census 2022 versus Forecast 2030 trajectory.</p>
        <p>Use ward action tags to move from diagnosis to practical prioritisation.</p>
        <p>${escapeHtml(
          state.summary.comparability?.metro_comparison_note ??
            'Scores are normalized within KwaDukuza and are intended for within-metro prioritization.',
        )}</p>
      `;
      return;
    }

    if (state.selectedMode === 'gdp-momentum') {
      formulaCard.innerHTML = `
        <h4>${mode.label}</h4>
        <p>${mode.description}</p>
        <p>Interpretation: VIIRS nighttime light radiance is used as an economic activity proxy for non-metro municipalities. Ward-level CAGR is compared across wards.</p>
        <p>Map classes are fixed around 0% CAGR, where zero is the negative/positive growth cutoff.</p>
      `;
      return;
    }

    formulaCard.innerHTML = `
      <h4>${mode.label}</h4>
      <p>${mode.description}</p>
      <p>This mode is profile-led: agriculture character, irrigation context, vegetation condition, tourism class, and land-use pressure.</p>
      <p>Map shading follows the composite constraint signal, while the bottom panel explains the ward story in planning terms.</p>
    `;
  }

  function getModeFallbackCards(): Array<{ label: string; value: string }> {
    if (state.selectedMode === 'ghsl-service-pressure') {
      return [
        { label: 'High-Risk Wards', value: String(state.summary.kpis.high_risk_wards) },
        { label: 'Critical Service Triage', value: String(state.summary.kpis.critical_triage_wards) },
        { label: 'Median Stress Score', value: formatNumber(state.summary.kpis.median_stress_score, 1) },
        { label: 'Median Momentum Score', value: formatNumber(state.summary.kpis.median_momentum_score, 1) },
        { label: 'Ward Coverage', value: String(state.summary.ward_count) },
      ];
    }

    if (state.selectedMode === 'gdp-momentum') {
      return [
        { label: 'City VIIRS CAGR', value: safePercent(state.summary.viirs_mean_cagr_pct, 2) },
        { label: 'City VIIRS Latest', value: safeRound(state.summary.kpis.city_viirs_latest_mean, 2) },
        { label: 'Latest VIIRS Month', value: state.summary.latest_viirs_month ?? 'n/a' },
        { label: 'Ward Coverage', value: String(state.summary.ward_count) },
      ];
    }

    return [
      { label: 'Median Constraint Score', value: formatNumber(state.summary.kpis.median_constraint_score, 1) },
      { label: 'Median Stress Score', value: formatNumber(state.summary.kpis.median_stress_score, 1) },
      { label: 'High-Risk Wards', value: String(state.summary.kpis.high_risk_wards) },
      { label: 'Critical Service Triage', value: String(state.summary.kpis.critical_triage_wards) },
      { label: 'Ward Coverage', value: String(state.summary.ward_count) },
    ];
  }

  function getModeInsightCards(): Array<{ label: string; value: string }> {
    const kpis = state.contentInsights?.city_headline_kpis;
    const selectedWard = getWardFeature(state.wards, state.selectedWardId);

    if (selectedWard) {
      const p = selectedWard.properties;
      const wardInsight = state.wardInsightsById[p.ward_id];
      const popChangeAbs = safeSignedNumber(p.ghsl_pop_change_2022_2030, 0);
      const popChangePct = safePercent(p.ghsl_pop_pct_change_2022_2030, 1);
      const popChangeLabel = popChangeAbs === 'n/a' || popChangePct === 'n/a' ? 'n/a' : `${popChangeAbs} (${popChangePct})`;

      if (state.selectedMode === 'ghsl-service-pressure') {
        const density2022 = formatDensity(p.ghsl_pop_density_2022);
        const density2030 = formatDensity(p.ghsl_pop_density_2030);
        return [
          { label: 'Census 2022', value: safeRound(p.census_pop_2022, 0) },
          { label: 'Forecast Pop 2030', value: safeRound(p.ghsl_pop_2030, 0) },
          { label: 'Pop Change (Census 2022→2030)', value: popChangeLabel },
          { label: 'Density (2022→2030)', value: `${density2022} → ${density2030}` },
          { label: 'Service Pressure 2030', value: safeRound(p.ghsl_service_pressure_2030, 2) },
        ];
      }

      if (state.selectedMode === 'gdp-momentum') {
        return [
          { label: 'VIIRS CAGR', value: safePercent(p.viirs_cagr_mean, 2) },
          { label: 'VIIRS YoY', value: safePercent(p.viirs_yoy_mean, 2) },
          { label: 'VIIRS Trend Slope', value: safeRound(p.viirs_trend_slope, 4) },
          { label: 'VIIRS Latest Radiance', value: safeRound(p.viirs_latest_mean, 2) },
          { label: 'VIIRS Growth Cluster', value: p.viirs_growth_cluster ?? 'n/a' },
        ];
      }

      return [
        { label: 'Constraint Score', value: `${safeRound(p.constraint_score, 1)}/100` },
        { label: 'Urban Share', value: safePercent(p.lc_urban_pct, 1) },
        { label: 'Protected Area', value: safePercent(p.protected_area_pct, 1) },
        { label: 'Agriculture Share', value: safePercent(wardInsight?.landcover.landcover_agriculture_pct, 1) },
        {
          label: 'Tourism Class',
          value: tourismClassLabel(wardInsight?.landcover.landcover_tourism_class),
        },
      ];
    }

    if (!kpis) return getModeFallbackCards();

    if (state.selectedMode === 'ghsl-service-pressure') {
      return [
        { label: 'Census 2022', value: kpiDisplay(kpis.ghsl_census_2022 ?? kpis.ghsl_population_e2020, 'n/a') },
        { label: 'Built Per Capita', value: kpiDisplay(kpis.ghsl_built_per_capita, 'n/a') },
        { label: 'Pop CAGR 20yr', value: kpiDisplay(kpis.ghsl_pop_cagr_20yr_pct, 'n/a') },
        { label: 'Built CAGR 20yr', value: kpiDisplay(kpis.ghsl_built_cagr_20yr_pct, 'n/a') },
        { label: 'Critical Service Triage', value: String(state.summary.kpis.critical_triage_wards) },
      ];
    }

    if (state.selectedMode === 'gdp-momentum') {
      const topViirs = state.contentInsights?.top_lists?.viirs_growth_rank?.[0];
      return [
        { label: 'City VIIRS CAGR', value: safePercent(state.summary.viirs_mean_cagr_pct, 2) },
        { label: 'City VIIRS Latest', value: safeRound(state.summary.kpis.city_viirs_latest_mean, 2) },
        { label: 'Latest VIIRS Month', value: state.summary.latest_viirs_month ?? 'n/a' },
        {
          label: 'Top VIIRS Growth Ward',
          value: topViirs ? `${topViirs.ward_label ?? topViirs.ward_id} (${safePercent(topViirs.value, 2)})` : 'n/a',
        },
        { label: 'Ward Coverage', value: String(state.summary.ward_count) },
      ];
    }

    const tourismActiveCount = Number(state.summary.tourism_active_ward_count);
    const tourismActiveShare = Number(state.summary.tourism_active_ward_share_pct);
    const tourismCountDisplay = Number.isFinite(tourismActiveCount) ? Math.round(tourismActiveCount) : null;
    const tourismShareDisplay = Number.isFinite(tourismActiveShare) ? tourismActiveShare : null;

    return [
      { label: 'Median Constraint Score', value: `${formatNumber(state.summary.kpis.median_constraint_score, 1)}/100` },
      { label: 'Area', value: kpiDisplay(kpis.landcover_area_km2, 'n/a') },
      { label: 'Agriculture', value: kpiDisplay(kpis.landcover_agriculture_pct, 'n/a') },
      { label: 'Protected Area', value: kpiDisplay(kpis.landcover_protected_area_pct, 'n/a') },
      {
        label: 'Tourism-active Wards',
        value:
          tourismCountDisplay !== null && tourismShareDisplay !== null
            ? `${formatNumber(tourismShareDisplay, 1)}% (${tourismCountDisplay}/${state.summary.ward_count} wards)`
            : 'n/a',
      },
    ];
  }

  function updateKpis(): void {
    const cards = getModeInsightCards();
    kpiGrid.innerHTML = cards
      .map((card) => `<article class="ugm-kpi"><span>${card.label}</span><strong>${card.value}</strong></article>`)
      .join('');
  }

  function resolveWardLabel(wardId: string, fallbackLabel?: string): string {
    return wardLabelById.get(wardId) ?? fallbackLabel ?? wardId;
  }

  function renderDepthCards(cards: Array<{ label: string; value: string; hint?: string }>): string {
    return `
      <div class="ugm-depth-grid">
        ${cards
          .map(
            (card) => `
              <article class="ugm-depth-card">
                <span>${escapeHtml(card.label)}</span>
                <strong>${escapeHtml(card.value)}</strong>
                ${card.hint ? `<small>${escapeHtml(card.hint)}</small>` : ''}
              </article>
            `,
          )
          .join('')}
      </div>
    `;
  }

  function renderRankList(items: Array<{ label: string; value: string }>): string {
    if (items.length === 0) {
      return '<p class="ugm-depth-empty">No ranked rows available.</p>';
    }
    return `
      <ol class="ugm-depth-list">
        ${items
          .map(
            (item) => `
              <li>
                <span>${escapeHtml(item.label)}</span>
                <strong>${escapeHtml(item.value)}</strong>
              </li>
            `,
          )
          .join('')}
      </ol>
    `;
  }

  function renderInsightSection(title: string, summary: string, points: string[]): string {
    const pointsHtml =
      points.length > 0
        ? `<ul class="ugm-insight-points">${points.map((point) => `<li>${escapeHtml(point)}</li>`).join('')}</ul>`
        : '';
    return `
      <section class="ugm-insight-section">
        <h4>${escapeHtml(title)}</h4>
        <p>${escapeHtml(summary)}</p>
        ${pointsHtml}
      </section>
    `;
  }

  function growthDirectionText(changePct: number): string {
    if (!Number.isFinite(changePct)) return 'mixed trajectory';
    if (changePct >= 15) return 'rapid growth trajectory';
    if (changePct >= 5) return 'steady growth trajectory';
    if (changePct >= 0) return 'stable-to-growing trajectory';
    return 'consolidation trajectory';
  }

  function densityContextText(value: number): string {
    if (!Number.isFinite(value)) return 'density context unavailable';
    if (value >= 10000) return 'very compact urban form';
    if (value >= 5000) return 'high-density urban form';
    if (value >= 2000) return 'moderate-density urban form';
    return 'lower-density settlement form';
  }

  function irrigationContextText(value: number): string {
    if (!Number.isFinite(value)) return 'irrigation context unavailable';
    if (value >= 0.6) return 'high irrigation dependence';
    if (value >= 0.25) return 'mixed rain-fed and irrigated activity';
    return 'mostly rain-fed or limited irrigation';
  }

  function ndviContextText(value: number): string {
    if (!Number.isFinite(value)) return 'vegetation condition unavailable';
    if (value >= 0.5) return 'strong vegetation condition';
    if (value >= 0.35) return 'moderate vegetation condition';
    return 'lower vegetation condition';
  }

  function densityGapContextText(flag: WardProps['ghsl_density_gap_flag']): string {
    if (flag === 'observed_above_forecast') {
      return 'Observed Census density is already above the 2030 model trajectory.';
    }
    if (flag === 'forecast_above_observed') {
      return 'Forecast density is above current Census density, indicating expected acceleration.';
    }
    return 'Observed and forecast densities are near parity.';
  }

  function smodTransitionContextText(feature: WardFeature): string {
    const p = feature.properties;
    const shareChange = safeSignedNumber(p.smod_urban_share_change_pp, 1);
    return `${p.smod_transition_class}: ${p.smod_degurba_label_2020} (${safePercent(
      p.smod_urban_share_2020,
      1,
    )}) → ${p.smod_degurba_label_2030} (${safePercent(p.smod_urban_share_2030, 1)}), urban-share shift ${shareChange}pp.`;
  }

  function landcoverStorySummary(storyClass: string): string {
    if (storyClass === 'Urban Core') return 'High-intensity built urban fabric with limited agriculture footprint.';
    if (storyClass === 'Mixed Urban') return 'Predominantly urban ward with mixed land-use pressures.';
    if (storyClass === 'Productive Agriculture') return 'Agriculture-linked ward with active production signal.';
    if (storyClass === 'Conservation-led') return 'Protected-area context is a dominant land-use constraint.';
    if (storyClass === 'Extractive Influence') return 'Mining-linked land use materially shapes constraints.';
    return 'Transitional peri-urban land-use context with mixed pressures.';
  }

  function actionTagPlanningNote(actionTag: string): string {
    if (actionTag === 'Critical service triage') {
      return 'Prioritise immediate service stabilisation and short-cycle interventions.';
    }
    if (actionTag === 'Accelerate capacity') {
      return 'Fast-track capacity upgrades to keep pace with observed demand momentum.';
    }
    if (actionTag === 'Near-term infrastructure investment') {
      return 'Prioritise near-term network and facility investments before pressure escalates.';
    }
    if (actionTag === 'Growth monitoring') {
      return 'Maintain active monitoring and staged readiness rather than immediate major expansion.';
    }
    return 'Use targeted ward review to validate local constraints and phase interventions.';
  }

  function updateTrendChart(): void {
    const selectedFeature = getWardFeature(state.wards, state.selectedWardId);

    if (state.selectedMode === 'ghsl-service-pressure') {
      trendTitle.textContent = selectedFeature ? 'Ward Service Pressure Story' : 'Service Pressure Story';
      trendSubtitle.textContent =
        'Insight panel: settlement transition, pressure load, Census-versus-forecast trajectory, and planning implication.';
      trendCanvasWrap.hidden = true;
      trendContext.hidden = false;
      const ghslInsights = state.contentInsights?.ward_insights ?? [];
      const slowingDefinition = ghslSlowingDefinition(state.summary);
      const topServiceRows = (state.summary.top10_by_metric.ghsl_service_pressure_2030 ?? []).slice(0, 5);
      const topServiceList = renderRankList(
        topServiceRows.map((row) => ({
          label: resolveWardLabel(row.ward_id, row.ward_label),
          value: `${safeRound(row.value, 1)} pressure`,
        })),
      );
      const highGrowthRows = [...state.wards.features]
        .sort((a, b) => b.properties.ghsl_pop_pct_change_2022_2030 - a.properties.ghsl_pop_pct_change_2022_2030)
        .slice(0, 5)
        .map((feature) => ({
          label: wardNameWithLabel(feature),
          value: safePercent(feature.properties.ghsl_pop_pct_change_2022_2030, 1),
        }));
      const clusterMixMap = new Map<string, number>();
      for (const insightRow of ghslInsights) {
        const cluster = ghslClusterDisplayLabel(state.summary, insightRow.ghsl);
        clusterMixMap.set(cluster, (clusterMixMap.get(cluster) ?? 0) + 1);
      }
      const clusterMix = [...clusterMixMap.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const dominantCluster = clusterMix[0]?.[0] ?? 'Mixed';
      const watchlistRows = (state.ghslAnomalyAudit?.wards ?? []).slice(0, 5).map((row) => ({
        label: resolveWardLabel(row.ward_id, row.ward_label),
        value: safePercent(row.ghsl_pop_pct_change_2022_2030, 1),
      }));
      const smodTransitionRows = [...state.wards.features]
        .sort((a, b) => b.properties.smod_urban_share_change_pp - a.properties.smod_urban_share_change_pp)
        .slice(0, 5)
        .map((feature) => ({
          label: wardNameWithLabel(feature),
          value: `${safeSignedNumber(feature.properties.smod_urban_share_change_pp, 1)}pp`,
        }));
      const builtPerCapKpi = state.contentInsights?.city_headline_kpis.ghsl_built_per_capita;
      const builtPerCapDisplay = kpiDisplay(builtPerCapKpi, 'n/a');
      const anomalyCount =
        state.ghslAnomalyAudit?.negative_growth_ward_count ?? watchlistRows.length;
      const comparabilityNote =
        state.summary.comparability?.metro_comparison_note ??
        'Scores are normalized within KwaDukuza and are intended for within-metro prioritization.';
      const transitionWardGroups = transitionWardsByClass();
      const stableCount = transitionWardGroups['Stable settlement form']?.length ?? 0;
      const transitionCardsHtml = NON_STABLE_TRANSITION_CLASSES.map((transitionClass) => {
        const wardsForClass = transitionWardGroups[transitionClass] ?? [];
        const count = wardsForClass.length;
        const avgChange =
          count > 0
            ? wardsForClass.reduce((sum, feature) => sum + feature.properties.smod_urban_share_change_pp, 0) / count
            : null;
        const active = state.selectedTransitionClass === transitionClass;
        return `
          <button
            type="button"
            class="ugm-transition-card${active ? ' is-active' : ''}"
            data-transition-class="${escapeHtml(transitionClass)}"
            ${count === 0 ? 'disabled' : ''}
          >
            <span>${escapeHtml(transitionClass)}</span>
            <strong>${count} ward${count === 1 ? '' : 's'}</strong>
            <small>${count > 0 ? `Avg shift ${safeSignedNumber(avgChange, 1)}pp` : 'No wards in current extract'}</small>
          </button>
        `;
      }).join('');
      const transitionFocusedClass = state.selectedTransitionClass;
      const transitionFocusedWards = transitionFocusedClass ? (transitionWardGroups[transitionFocusedClass] ?? []) : [];
      const transitionFocusedWardChips =
        transitionFocusedWards.length > 0
          ? transitionFocusedWards
              .map(
                (feature) => `
                <button
                  type="button"
                  class="ugm-transition-chip${feature.properties.ward_id === state.selectedWardId ? ' is-selected' : ''}"
                  data-transition-ward-id="${escapeHtml(feature.properties.ward_id)}"
                >
                  ${escapeHtml(wardNameWithLabel(feature))} • ${safeSignedNumber(
                    feature.properties.smod_urban_share_change_pp,
                    1,
                  )}pp
                </button>
              `,
              )
              .join('')
          : '';
      const transitionFocusSummary =
        transitionFocusedClass && transitionFocusedWards.length > 0
          ? (() => {
              const avg =
                transitionFocusedWards.reduce((sum, feature) => sum + feature.properties.smod_urban_share_change_pp, 0) /
                transitionFocusedWards.length;
              const topWard = transitionFocusedWards[0];
              return `Count ${transitionFocusedWards.length} • Avg shift ${safeSignedNumber(avg, 1)}pp • Top shift ${wardNameWithLabel(
                topWard,
              )}`;
            })()
          : '';
      const cityUrbanShift = `${safePercent(state.summary.smod_city_urban_share_2020, 1)} → ${safePercent(
        state.summary.smod_city_urban_share_2030,
        1,
      )}`;

      if (!selectedFeature) {
        trendContext.innerHTML = `
          ${renderDepthCards([
            {
              label: 'Dominant Settlement Cluster',
              value: dominantCluster,
              hint: `Across ${state.summary.ward_count} KwaDukuza wards.`,
            },
            {
              label: 'City Urban Share (S-Mod)',
              value: cityUrbanShift,
              hint: `2020 to 2030 shift: ${safeSignedNumber(state.summary.smod_city_urban_share_change_pp, 1)}pp`,
            },
            {
              label: 'Built per Capita (City)',
              value: builtPerCapDisplay,
              hint: 'Service pressure dashboard indicator.',
            },
          ])}
          <div class="ugm-insight-stack">
            ${renderInsightSection(
              'Settlement and Growth Pattern',
              `KwaDukuza wards show a mixed settlement pattern, with ${dominantCluster} currently the most common cluster and a measurable shift in S-Mod urban form.`,
              [
                'Use transition classes to identify where wards are intensifying versus remaining stable.',
                'S-Mod transition is based on ward-level 2020 to 2030 zonal composition.',
                `Interpretation note: ${slowingDefinition}`,
              ],
            )}
            ${renderInsightSection(
              'Built Environment Pressure',
              'Service pressure hotspots combine dense population context with built-form load that can strain municipal services.',
              [
                'Use hotspot wards as first-pass candidates for network capacity checks.',
                'Pair pressure signals with local ward context before investment sequencing.',
              ],
            )}
            ${renderInsightSection(
              'Population Trajectory',
              `Most wards show growth toward 2030, while ${anomalyCount} ward(s) remain on a Census-2022-to-2030 watchlist for potential softening.`,
              [
                'Growth and watchlist signals should be validated with local pipeline and delivery conditions.',
                'Trajectory is used for prioritisation, not as a standalone final decision.',
              ],
            )}
            ${renderInsightSection(
              'Planning Implication',
              'Prioritise service-pressure hotspots first, then sequence medium-pressure growth wards for phased capacity expansion.',
              [
                'Use the selected ward card to move from city-level pattern to ward-level intervention logic.',
                comparabilityNote,
              ],
            )}
          </div>
          ${renderDepthCards([
            {
              label: 'Watchlist Wards',
              value: String(anomalyCount),
              hint: 'Census 2022 to Forecast 2030 softening signal.',
            },
            {
              label: 'Top Pressure Wards',
              value: `${topServiceRows.length}`,
              hint: 'Shown below for quick drill-in.',
            },
          ])}
          <div class="ugm-depth-columns">
            <section class="ugm-depth-block">
              <h4>Top Service-Pressure Wards</h4>
              ${topServiceList}
            </section>
            <section class="ugm-depth-block">
              <h4>Fast-Growth Trajectory Wards</h4>
              ${renderRankList(highGrowthRows)}
            </section>
          </div>
          <div class="ugm-depth-columns">
            <section class="ugm-depth-block">
              <h4>S-Mod Transition Mix (2020→2030)</h4>
              <div class="ugm-transition-cards">${transitionCardsHtml}</div>
              <p class="ugm-transition-stable">Stable settlement form: <strong>${stableCount}</strong> wards.</p>
              ${
                transitionFocusedClass
                  ? `
                    <div class="ugm-transition-focus-head">
                      <strong>Wards in ${escapeHtml(transitionFocusedClass)}</strong>
                      <button type="button" class="ugm-transition-clear-btn" data-clear-transition-focus="1">Clear transition focus</button>
                    </div>
                    <small class="ugm-transition-summary">${escapeHtml(transitionFocusSummary)}</small>
                    <div class="ugm-transition-ward-chips">${transitionFocusedWardChips}</div>
                  `
                  : '<p class="ugm-depth-empty">Select a transition class to see the exact wards and click through to inspect each one.</p>'
              }
            </section>
            <section class="ugm-depth-block">
              <h4>Largest Urban-Share Shifts</h4>
              ${renderRankList(smodTransitionRows)}
            </section>
          </div>
          <div class="ugm-depth-stack ugm-depth-stack-bottom">
            <section class="ugm-depth-block">
              <h4>Watchlist (Census 2022 → 2030)</h4>
              ${watchlistRows.length > 0 ? renderRankList(watchlistRows) : '<p class="ugm-depth-empty">No watchlist wards in current extract.</p>'}
            </section>
            <section class="ugm-depth-block">
              <h4>Settlement Cluster Mix</h4>
              ${renderRankList(
                clusterMix.slice(0, 5).map(([label, count]) => ({
                  label,
                  value: `${count} wards`,
                })),
              )}
            </section>
          </div>
        `;
      } else {
        const p = selectedFeature.properties;
        const wardInsight = state.wardInsightsById[p.ward_id];
        const ghslCluster = ghslClusterDisplayLabel(state.summary, wardInsight?.ghsl);
        const slowingDefinition = ghslSlowingDefinition(state.summary);
        const builtPerCap = wardInsight?.ghsl.ghsl_built_per_cap;
        const popDensity = wardInsight?.ghsl.ghsl_pop_density ?? p.ghsl_pop_density_2030;
        const popTrajectory = growthDirectionText(p.ghsl_pop_pct_change_2022_2030);
        const anomalyRow = state.ghslAnomalyByWard[p.ward_id];
        const reasons = wardInsight?.why_this_ward ?? [];
        const reasonsHtml =
          reasons.length > 0
            ? `<ul class="ugm-insight-points">${reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>`
            : '<p class="ugm-depth-empty">No additional ward notes available for this ward.</p>';

        trendContext.innerHTML = `
          ${
            state.selectedTransitionClass
              ? `
                <section class="ugm-depth-block ugm-transition-focus-inline">
                  <div class="ugm-transition-focus-head">
                    <strong>Transition focus active: ${escapeHtml(state.selectedTransitionClass)}</strong>
                    <button type="button" class="ugm-transition-clear-btn" data-clear-transition-focus="1">Clear transition focus</button>
                  </div>
                </section>
              `
              : ''
          }
          ${renderDepthCards([
            {
              label: 'Selected Ward',
              value: wardNameWithLabel(selectedFeature),
            },
            {
              label: 'Settlement Cluster',
              value: ghslCluster,
              hint: 'From ward dashboard output.',
            },
            {
              label: 'Population Trajectory',
              value: popTrajectory,
              hint: `Census 2022 to 2030: ${safePercent(p.ghsl_pop_pct_change_2022_2030, 1)}`,
            },
            {
              label: 'S-Mod Transition',
              value: p.smod_transition_class,
              hint: `${p.smod_degurba_label_2020} → ${p.smod_degurba_label_2030}`,
            },
          ])}
          <div class="ugm-insight-stack">
            ${renderInsightSection(
              'Settlement and Growth Pattern',
              `${wardName(selectedFeature)} reflects a ${ghslCluster} settlement pattern with ${densityContextText(popDensity)} and a ${p.smod_transition_class.toLowerCase()}.`,
              [
                `Current density context: ${formatDensity(popDensity)}.`,
                `Population trajectory to 2030: ${safeSignedNumber(p.ghsl_pop_change_2022_2030, 0)} people (${safePercent(
                  p.ghsl_pop_pct_change_2022_2030,
                  1,
                )}).`,
                smodTransitionContextText(selectedFeature),
                ...(ghslCluster === 'Slowing' ? [`Interpretation note: ${slowingDefinition}`] : []),
              ],
            )}
            ${renderInsightSection(
              'Built Environment Pressure',
              `Service pressure is ${safeRound(p.ghsl_service_pressure_2030, 1)} with ${safeSignedNumber(
                p.ghsl_pressure_change,
                1,
              )} recent pressure shift.`,
              [
                builtPerCap !== undefined
                  ? `Built space per capita signal: ${safeRound(builtPerCap, 1)} m²/person.`
                  : 'Built per capita detail unavailable in ward extract.',
                'Interpret this with local infrastructure coverage and service backlogs.',
                densityGapContextText(p.ghsl_density_gap_flag),
              ],
            )}
            ${renderInsightSection(
              'Population Trajectory',
              `This ward is on a ${popTrajectory} relative to Census 2022 and 2030 forecast.`,
              [
                anomalyRow
                  ? `Watchlist flag active: ${safePercent(anomalyRow.ghsl_pop_pct_change_2022_2030, 1)} expected change.`
                  : 'No watchlist flag in current census-to-forecast anomaly extract.',
                `Density 2022 vs 2030: ${formatDensity(p.ghsl_pop_density_2022)} → ${formatDensity(
                  p.ghsl_pop_density_2030,
                )}.`,
              ],
            )}
            ${renderInsightSection(
              'Planning Implication',
              actionTagPlanningNote(p.action_tag),
              [
                'Use this ward profile to prioritise where capacity upgrades, stabilisation, or monitoring should happen first.',
              ],
            )}
          </div>
          <section class="ugm-depth-block">
            <h4>Script-Derived Ward Insights</h4>
            ${reasonsHtml}
          </section>
        `;
      }
      return;
    }

    if (state.selectedMode === 'landcover-constraints') {
      trendTitle.textContent = 'Landcover Insight Context';
      trendSubtitle.textContent = 'Insight panel: landcover profile, vegetation condition, irrigation context, and planning implication.';
      trendCanvasWrap.hidden = true;
      trendContext.hidden = false;

      const storyMixMap = new Map<string, number>();
      const profileMixMap = new Map<string, number>();
      const tourismMixMap = new Map<string, number>();
      for (const wardInsight of state.contentInsights?.ward_insights ?? []) {
        const story = wardInsight.landcover.landcover_story_class ?? 'Unclassified';
        storyMixMap.set(story, (storyMixMap.get(story) ?? 0) + 1);
        const profile = wardInsight.landcover.landcover_agriculture_profile ?? 'Unclassified';
        profileMixMap.set(profile, (profileMixMap.get(profile) ?? 0) + 1);
        const tourismClass = wardInsight.landcover.landcover_tourism_class ?? 'Unclassified';
        tourismMixMap.set(tourismClass, (tourismMixMap.get(tourismClass) ?? 0) + 1);
      }
      const storyMix = [...storyMixMap.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const profileMix = [...profileMixMap.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const tourismMix = [...tourismMixMap.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const topStoryClass = storyMix[0]?.[0] ?? 'Mixed Urban';
      const agriTopRows = (state.contentInsights?.top_lists.landcover_agriculture ?? []).slice(0, 5);
      const agriTopList = renderRankList(
        agriTopRows.map((row) => ({
          label: resolveWardLabel(row.ward_id, row.ward_label),
          value: safePercent(row.value, 1),
        })),
      );
      const protectedTop = [...state.wards.features]
        .sort((a, b) => b.properties.protected_area_pct - a.properties.protected_area_pct)
        .slice(0, 5)
        .map((feature) => ({
          label: wardNameWithLabel(feature),
          value: safePercent(feature.properties.protected_area_pct, 1),
        }));
      const miningTop = [...state.wards.features]
        .sort((a, b) => b.properties.lc_mining_pct - a.properties.lc_mining_pct)
        .slice(0, 5)
        .map((feature) => ({
          label: wardNameWithLabel(feature),
          value: safePercent(feature.properties.lc_mining_pct, 1),
        }));

      if (!selectedFeature) {
        trendContext.innerHTML = `
          ${renderDepthCards([
            {
              label: 'Dominant Landcover Story',
              value: topStoryClass,
              hint: 'Most common multi-variable landcover story in current ward extract.',
            },
            {
              label: 'Top Agriculture Wards',
              value: `${agriTopRows.length}`,
              hint: 'Shown below for quick thematic drill-in.',
            },
          ])}
          <div class="ugm-insight-stack">
            ${renderInsightSection(
              'Landcover Pattern',
              `KwaDukuza landcover signals are profile-led, with ${topStoryClass} currently the most common ward story class.`,
              [
                'Story classes combine urban share, agriculture intensity, protected context, mining context, and vegetation signal.',
                'These profiles help distinguish production, conservation, and mixed-use wards.',
              ],
            )}
            ${renderInsightSection(
              'Agriculture and Irrigation',
              'Agriculture-facing wards differ strongly in irrigation intensity and production footprint, which affects resilience and service needs.',
              [
                'Use top agriculture wards to identify where land and service planning should be coordinated.',
              ],
            )}
            ${renderInsightSection(
              'Vegetation and Tourism Signals',
              'NDVI and tourism class provide additional context on landscape condition and economic use patterns.',
              [
                'Combine these with protected and mining shares when sequencing land-use interventions.',
              ],
            )}
            ${renderInsightSection(
              'Planning Implication',
              'Use profile-led segmentation to tailor policy instruments instead of one-size-fits-all land-use action.',
              [
                'Prioritise profile-appropriate interventions at ward level, then scale by action-tag priority.',
              ],
            )}
          </div>
          <div class="ugm-depth-columns">
            <section class="ugm-depth-block">
              <h4>Top Agriculture Wards</h4>
              ${agriTopList}
            </section>
            <section class="ugm-depth-block">
              <h4>Landcover Story Mix</h4>
              ${renderRankList(
                storyMix.slice(0, 6).map(([label, count]) => ({
                  label,
                  value: `${count} wards`,
                })),
              )}
            </section>
          </div>
          <div class="ugm-depth-columns">
            <section class="ugm-depth-block">
              <h4>Agriculture Profile Mix</h4>
              ${renderRankList(
                profileMix.slice(0, 6).map(([label, count]) => ({
                  label,
                  value: `${count} wards`,
                })),
              )}
            </section>
            <section class="ugm-depth-block">
              <h4>Protected-Context Wards</h4>
              ${renderRankList(protectedTop)}
            </section>
            <section class="ugm-depth-block">
              <h4>Tourism Class Mix</h4>
              ${renderRankList(
                tourismMix.slice(0, 6).map(([label, count]) => ({
                  label,
                  value: `${count} wards`,
                })),
              )}
            </section>
          </div>
          <section class="ugm-depth-block">
            <h4>Mining-Context Wards</h4>
            ${renderRankList(miningTop)}
          </section>
        `;
      } else {
        const p = selectedFeature.properties;
        const wardInsight = state.wardInsightsById[p.ward_id];
        const landcoverInsight = wardInsight?.landcover;
        const landcoverStory = landcoverInsight?.landcover_story_class ?? p.landcover_story_class ?? 'Mixed Urban';
        const agriProfile = landcoverInsight?.landcover_agriculture_profile ?? 'Unclassified';
        const tourismClass = landcoverInsight?.landcover_tourism_class ?? 'Unclassified';
        const irrigationRatio = landcoverInsight?.landcover_irrigation_ratio ?? NaN;
        const ndviMean = landcoverInsight?.landcover_ndvi_2024_mean ?? NaN;
        const breakdown = buildLandcoverBreakdown(selectedFeature);
        const rowsHtml = breakdown.rows
          .map(
            (row) => `
              <tr>
                <td>${escapeHtml(row.label)}</td>
                <td>${escapeHtml(row.rawDisplay)}</td>
                <td>${formatNumber(row.percentileRank, 1)}</td>
                <td>${formatNumber(row.weight * 100, 0)}%</td>
                <td>${formatNumber(row.contribution, 2)}</td>
              </tr>
            `,
          )
          .join('');
        const reasons = wardInsight?.why_this_ward ?? [];
        const reasonsHtml =
          reasons.length > 0
            ? `<ul class="ugm-insight-points">${reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>`
            : '<p class="ugm-depth-empty">No additional ward notes available for this ward.</p>';
        const landImplication =
          p.protected_area_pct >= 20
            ? 'Strong conservation context suggests planning should prioritize compatible/infill options.'
            : p.lc_urban_pct >= 60
              ? 'High urban share suggests emphasis on efficient servicing and targeted redevelopment.'
              : 'Mixed land-use profile suggests ward-specific planning and phased intervention design.';

        trendContext.innerHTML = `
          ${renderDepthCards([
            {
              label: 'Selected Ward',
              value: wardNameWithLabel(selectedFeature),
            },
            {
              label: 'Landcover Story',
              value: landcoverStory,
            },
            {
              label: 'Constraint Score',
              value: `${safeRound(p.constraint_score, 1)}/100`,
              hint: 'Composite signal used for map shading in this mode.',
            },
          ])}
          <div class="ugm-insight-stack">
            ${renderInsightSection(
              'Landcover Story',
              `${wardName(selectedFeature)} is classified as ${landcoverStory}. ${landcoverStorySummary(
                landcoverStory,
              )}`,
              [
                `Agriculture profile tag: ${agriProfile}.`,
                `Agriculture share: ${safePercent(landcoverInsight?.landcover_agriculture_pct, 1)}.`,
                `Irrigation ratio signal: ${safeRound(irrigationRatio, 2)}.`,
                `Irrigation context: ${irrigationContextText(irrigationRatio)}.`,
              ],
            )}
            ${renderInsightSection(
              'Vegetation and Tourism Context',
              `The ward currently shows ${ndviContextText(ndviMean)} with tourism class ${tourismClass}.`,
              [
                `NDVI mean: ${safeRound(ndviMean, 3)}.`,
                `Tourism class: ${tourismClass}.`,
              ],
            )}
            ${renderInsightSection(
              'Protected and Mining Context',
              'Protected and extractive land-use shares help explain development constraints and tradeoffs.',
              [
                `Protected area: ${safePercent(p.protected_area_pct, 1)}.`,
                `Mining share: ${safePercent(p.lc_mining_pct, 1)}.`,
                `Urban share: ${safePercent(p.lc_urban_pct, 1)}.`,
              ],
            )}
            ${renderInsightSection('Planning Implication', landImplication, [
              actionTagPlanningNote(p.action_tag),
            ])}
          </div>
          <section class="ugm-depth-block">
            <h4>Script-Derived Ward Insights</h4>
            ${reasonsHtml}
          </section>
          <div class="ugm-method-details">
            <details>
              <summary>Method details: composite landcover score construction</summary>
              <div class="ugm-breakdown-wrap">
                <table class="ugm-breakdown-table">
                  <thead>
                    <tr>
                      <th>Driver</th>
                      <th>Raw Value</th>
                      <th>Rank (0-100)</th>
                      <th>Weight</th>
                      <th>Contribution</th>
                    </tr>
                  </thead>
                  <tbody>${rowsHtml}</tbody>
                </table>
              </div>
              <p><strong>Constraint Score</strong> = ${formatNumber(breakdown.computedScore, 2)}/100 (stored ${safeRound(
                breakdown.storedScore,
                2,
              )}/100).</p>
            </details>
          </div>
        `;
      }
      return;
    }

    trendCanvasWrap.hidden = false;
    trendContext.hidden = true;

    if (state.selectedMode === 'gdp-momentum') {
      trendTitle.textContent = 'VIIRS Radiance Trend';
      trendSubtitle.textContent = 'Non-metro municipality: VIIRS radiance used as economic activity proxy.';

      const cityTimeseries = state.summary.city_viirs_timeseries ?? [];
      if (cityTimeseries.length === 0) {
        trendSubtitle.textContent = 'VIIRS time series data unavailable.';
        trendChart.data.labels = [];
        trendChart.data.datasets[0].data = [];
        trendChart.data.datasets[1].data = [];
        trendChart.update();
        return;
      }

      const viirsDates = cityTimeseries.map((row) => row.date).sort();
      const baseMonth = state.summary.viirs_index_base_month ?? viirsDates[0] ?? '';
      const cityByDate = new Map(cityTimeseries.map((row) => [row.date, row.city_viirs_mean]));
      const citySeries = buildIndexedSeries(viirsDates, cityByDate, baseMonth);

      let selectedSeries: Array<number | null> = viirsDates.map(() => null);
      let selectedLabel = 'Selected ward (choose a ward)';
      if (selectedFeature) {
        selectedLabel = `${wardName(selectedFeature)} VIIRS index`;
      }

      trendChart.data.labels = viirsDates;
      trendChart.data.datasets[0].data = selectedSeries;
      trendChart.data.datasets[0].label = selectedLabel;
      trendChart.data.datasets[1].data = citySeries;
      trendChart.data.datasets[1].label = 'City VIIRS indexed reference';
      trendChart.update();

      trendSubtitle.textContent = `VIIRS index base: ${baseMonth}. City-level radiance trend shown as economic proxy.`;
      return;
    }

    trendTitle.textContent = 'Mode Context';
    trendSubtitle.textContent = 'No trend line in this mode.';
    trendCanvasWrap.hidden = true;
    trendContext.hidden = false;
    trendContext.innerHTML = '<p>Select VIIRS Momentum to view the VIIRS radiance trend chart.</p>';
  }

  function topRowsForMode(): Array<{ ward_id: string; ward_label: string; value: number }> {
    const cfg = MODE_CONFIG[state.selectedMode];
    const rows = state.wards.features
      .map((feature) => {
        const rawValue = feature.properties[cfg.rankingField];
        const value = typeof rawValue === 'number' ? rawValue : Number(rawValue);
        return {
          ward_id: feature.properties.ward_id,
          ward_label: feature.properties.ward_label,
          value,
        };
      })
      .filter((row) => Number.isFinite(row.value))
      .filter((row) => isWardVisibleByFilterId(row.ward_id));

    rows.sort((a, b) => {
      const diff = state.rankingDirection === 'top' ? b.value - a.value : a.value - b.value;
      if (Math.abs(diff) > 1e-12) return diff;
      return a.ward_label.localeCompare(b.ward_label);
    });

    return rows.slice(0, 10);
  }

  function updateRankingChart(): void {
    const rows = topRowsForMode();
    currentRankingRows = rows;

    const dirLabel = state.rankingDirection === 'top' ? 'Top 10' : 'Bottom 10';
    rankingTitle.textContent = `${dirLabel} ${MODE_CONFIG[state.selectedMode].rankingMetricLabel}`;
    rankingChart.data.labels = rows.map((row) => row.ward_label);
    rankingChart.data.datasets[0].label = rankingTitle.textContent;
    rankingChart.data.datasets[0].data = rows.map((row) => row.value);
    rankingChart.data.datasets[0].backgroundColor =
      state.selectedMode === 'ghsl-service-pressure'
        ? '#c55f1d'
        : state.selectedMode === 'gdp-momentum'
          ? '#6d4db2'
          : '#398f52';

    const values = rows.map((row) => row.value).filter((value) => Number.isFinite(value));
    const minValue = values.length > 0 ? Math.min(...values) : 0;
    const maxValue = values.length > 0 ? Math.max(...values) : 1;

    const yScale = rankingChart.options.scales?.y as any;
    if (yScale) {
      if (state.selectedMode === 'gdp-momentum') {
        yScale.suggestedMin = Math.min(-3, minValue * 1.15);
        yScale.suggestedMax = Math.max(3, maxValue * 1.15);
      } else if (state.selectedMode === 'landcover-constraints') {
        yScale.suggestedMin = 0;
        yScale.suggestedMax = 100;
      } else {
        yScale.suggestedMin = 0;
        yScale.suggestedMax = maxValue * 1.1;
      }
    }

    if (state.selectedMode === 'gdp-momentum') {
      rankingSubtitle.textContent = `Y-axis is VIIRS CAGR %. Zero is the negative/positive growth cutoff. Rankings reflect the active action-tag filter.`;
    } else if (state.selectedMode === 'landcover-constraints') {
      rankingSubtitle.textContent = 'Y-axis is Constraint Score (0-100). Rankings reflect the active action-tag filter.';
    } else {
      rankingSubtitle.textContent = 'Y-axis is population density (persons/km²). Rankings reflect the active action-tag filter.';
    }

    updateRankingDirectionButtons();
    rankingChart.update();
    scheduleBottomPanelSync();
  }

  function updateDriverBars(): void {
    const feature = getWardFeature(state.wards, state.selectedWardId);
    if (!feature) {
      driverBars.innerHTML = 'Select a ward to see driver contributions.';
      return;
    }

    const p = feature.properties;
    const bars = [
      {
        label: 'Stress (pressure + density + growth load)',
        value: p.stress_score,
        median: state.summary.kpis.median_stress_score,
        className: 'stress',
      },
      {
        label: 'Momentum (night-lights trend signal)',
        value: p.momentum_score,
        median: state.summary.kpis.median_momentum_score,
        className: 'momentum',
      },
      {
        label: 'Constraint (land-use limitation composite)',
        value: p.constraint_score,
        median: state.summary.kpis.median_constraint_score,
        className: 'constraint',
      },
    ];

    driverBars.innerHTML = bars
      .map(
        (bar) => `
      <div class="ugm-driver-row">
        <div class="ugm-driver-meta"><span>${bar.label}</span><strong>${formatNumber(bar.value, 1)}</strong></div>
        <div class="ugm-driver-track"><div class="ugm-driver-fill ${bar.className}" style="width:${Math.max(
          0,
          Math.min(100, bar.value),
        )}%"></div></div>
        <small>City median ${formatNumber(bar.median, 1)}</small>
      </div>
    `,
      )
      .join('');
  }

  function updateWardPanel(): void {
    const feature = getWardFeature(state.wards, state.selectedWardId);
    if (!feature) {
      wardHeadline.textContent = 'Click a ward to inspect risk and intervention priority.';
      return;
    }

    const p = feature.properties;
    const insight = state.wardInsightsById[p.ward_id];
    const reasons = insight?.why_this_ward ?? [];
    const reasonsHtml = reasons.length
      ? `<ul class="ugm-why-list">${reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>`
      : '<p class="ugm-why-empty">No ward drivers available.</p>';
    const popChangeAbs = safeSignedNumber(p.ghsl_pop_change_2022_2030, 0);
    const popChangePct = safePercent(p.ghsl_pop_pct_change_2022_2030, 1);
    const popChangeLabel = popChangeAbs === 'n/a' || popChangePct === 'n/a' ? 'n/a' : `${popChangeAbs} (${popChangePct})`;
    const landcoverStoryChip =
      state.selectedMode === 'landcover-constraints'
        ? `<span class="ugm-story-chip">Story: ${escapeHtml(p.landcover_story_class || 'Unclassified')}</span>`
        : '';

    wardHeadline.innerHTML = `
      <div class="ugm-ward-headline-row">
        <div>
          <div class="ugm-ward-title">${escapeHtml(wardNameWithLabel(feature))}</div>
          <div class="ugm-ward-sub">ID ${escapeHtml(p.ward_id)} • ${escapeHtml(p.district_name)}</div>
        </div>
        <div class="ugm-ward-headline-tags">
          ${landcoverStoryChip}
          <span class="${actionChipClass(p.action_tag)}">${escapeHtml(p.action_tag)}</span>
        </div>
      </div>
      <dl class="ugm-ward-grid">
        <dt>Priority Risk Score</dt><dd>${formatNumber(p.priority_risk_score, 1)} (Rank #${p.priority_rank})</dd>
        <dt>Bivariate Class</dt><dd>${escapeHtml(p.bivariate_class)}</dd>
        <dt>Stress / Momentum / Constraint</dt><dd>${formatNumber(p.stress_score, 1)} / ${formatNumber(
          p.momentum_score,
          1,
        )} / ${formatNumber(p.constraint_score, 1)}</dd>
        <dt>Census 2022</dt><dd>${safeRound(p.census_pop_2022, 0)}</dd>
        <dt>Forecast Pop 2030</dt><dd>${safeRound(p.ghsl_pop_2030, 0)}</dd>
        <dt>Census→2030 Change</dt><dd>${popChangeLabel}</dd>
        <dt>Pop Density 2022</dt><dd>${formatDensity(p.ghsl_pop_density_2022)}</dd>
        <dt>Pop Density 2030</dt><dd>${formatDensity(p.ghsl_pop_density_2030)}</dd>
        <dt>Density Gap Flag</dt><dd>${escapeHtml(p.ghsl_density_gap_flag)}</dd>
        <dt>S-Mod Transition</dt><dd>${escapeHtml(p.smod_transition_class)}</dd>
        <dt>Landcover Story</dt><dd>${escapeHtml(p.landcover_story_class)}</dd>
        <dt>VIIRS Growth Rank</dt><dd>${insight?.ranks?.viirs_growth_rank ?? 'n/a'}</dd>
        <dt>Service Pressure Density Rank</dt><dd>${insight?.ranks?.ghsl_pop_density_rank ?? 'n/a'}</dd>
        <dt>Landcover Agriculture Rank</dt><dd>${insight?.ranks?.landcover_agriculture_rank ?? 'n/a'}</dd>
        <dt>VIIRS CAGR</dt><dd>${safePercent(p.viirs_cagr_mean, 2)}</dd>
        <dt>VIIRS YoY</dt><dd>${safePercent(p.viirs_yoy_mean, 2)}</dd>
        <dt>VIIRS Trend Slope</dt><dd>${safeRound(p.viirs_trend_slope, 4)}</dd>
        <dt>Latest Avg Radiance</dt><dd>${safeRound(p.viirs_latest_mean, 2)}</dd>
        <dt>Census→Forecast Watchlist</dt><dd>${p.ghsl_negative_growth_flag ? 'Yes (audit flagged)' : 'No'}</dd>
        <dt>Score Confidence</dt><dd>${formatNumber(p.score_confidence, 1)}</dd>
      </dl>
      <h4 class="ugm-why-title">Why This Ward</h4>
      ${reasonsHtml}
    `;
  }

  function updateLegend(): void {
    legend.innerHTML = renderLegend(state.selectedMode, state.modeBreaks[state.selectedMode], state.wards);
  }

  function updateTabState(): void {
    for (const tab of tabButtons) {
      tab.classList.toggle('is-active', tab.dataset.mode === state.selectedMode);
    }
  }

  function updateAllPanels(): void {
    updateFormulaCard();
    updateKpis();
    updateWardPanel();
    updateDriverBars();
    updateRankingChart();
    updateTrendChart();
    updateLegend();
    updateTabState();
    updateSelectedWardChip();
    scheduleBottomPanelSync();
  }

  function applyFallbackSelectionHighlight(): void {
    for (const path of fallbackPaths) {
      const isSelected = path.dataset.wardId === state.selectedWardId;
      path.classList.toggle('is-selected', Boolean(isSelected));
    }
  }

  function refreshFallbackColors(): void {
    const transitionFocusActive = isTransitionFocusActive();
    for (const path of fallbackPaths) {
      const wardId = path.dataset.wardId;
      const feature = wardId ? getWardFeature(state.wards, wardId) : undefined;
      if (!feature) continue;
      const value = metricValue(feature, state.selectedMode);
      const color = colorForValue(state.selectedMode, value, state.modeBreaks[state.selectedMode]);
      path.setAttribute('fill', color);
      const visible = isWardVisibleOnMap(feature);
      path.style.opacity = visible ? '0.95' : '0.08';
      path.classList.toggle('is-dimmed', !visible);
      path.classList.toggle('is-filter-match', state.selectedActionFilter !== 'All' && isWardVisibleByFilter(feature));
      path.classList.toggle('is-transition-match', transitionFocusActive && isWardInTransitionFocus(feature));
    }
  }

  function renderFallbackSvg(): void {
    const width = Math.max(320, Math.round(mapWrap.clientWidth));
    const height = Math.max(320, Math.round(mapWrap.clientHeight));

    fallbackMap.setAttribute('viewBox', `0 0 ${width} ${height}`);
    fallbackMap.setAttribute('width', String(width));
    fallbackMap.setAttribute('height', String(height));

    while (fallbackMap.firstChild) {
      fallbackMap.removeChild(fallbackMap.firstChild);
    }

    const projection = geoMercator().fitSize([width, height], wards as unknown as any);
    const pathBuilder = geoPath(projection);

    fallbackPaths = wards.features.map((feature) => {
      const pathNode = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const d = pathBuilder(feature as unknown as any) ?? '';
      pathNode.setAttribute('d', d);

      const value = metricValue(feature, state.selectedMode);
      pathNode.setAttribute('fill', colorForValue(state.selectedMode, value, state.modeBreaks[state.selectedMode]));
      pathNode.setAttribute('stroke', '#243646');
      pathNode.setAttribute('stroke-width', '0.8');
      pathNode.classList.add('ugm-fallback-path');
      pathNode.dataset.wardId = feature.properties.ward_id;
      pathNode.dataset.wardLabel = feature.properties.ward_label;

      pathNode.addEventListener('mouseenter', () => {
        fallbackMap.style.cursor = 'pointer';
      });
      pathNode.addEventListener('mousemove', (event) => {
        const rect = mapWrap.getBoundingClientRect();
        showMapTooltip(feature, event.clientX - rect.left, event.clientY - rect.top);
      });
      pathNode.addEventListener('mouseleave', () => {
        fallbackMap.style.cursor = '';
        hideMapTooltip();
      });
      pathNode.addEventListener('click', () => {
        applyWardSelection(feature.properties.ward_id);
      });
      fallbackMap.appendChild(pathNode);
      return pathNode;
    });

    state.mapFeatureCount = fallbackPaths.length;
    refreshFallbackColors();
    applyFallbackSelectionHighlight();
    updateRuntimeDiag();
    scheduleBottomPanelSync();
  }

  function activateFallback(reason: string): void {
    if (state.fallbackActive) return;
    state.fallbackActive = true;
    state.fallbackReason = reason;
    state.activeRenderer = 'svg';
    state.basemapStatus = 'n/a';

    fallbackBadge.hidden = false;
    fallbackBadge.textContent = `Fallback mode active (offline-safe renderer): ${reason}. Basemap not shown in SVG fallback.`;
    mapCanvas.style.display = 'none';
    fallbackMap.style.display = 'block';

    renderFallbackSvg();
    setRenderBadge();
    updateRuntimeDiag();
    scheduleBottomPanelSync();
  }

  function mapFillOpacity(): number | unknown[] {
    const actionFilterActive = state.selectedActionFilter !== 'All';
    const transitionFocusActive = isTransitionFocusActive();

    if (!actionFilterActive && !transitionFocusActive) {
      return 0.76;
    }
    if (actionFilterActive && transitionFocusActive) {
      return [
        'case',
        [
          'all',
          ['==', ['get', 'action_tag'], state.selectedActionFilter],
          ['==', ['get', 'smod_transition_class'], state.selectedTransitionClass],
        ],
        0.95,
        0.08,
      ];
    }
    if (actionFilterActive) {
      return ['case', ['==', ['get', 'action_tag'], state.selectedActionFilter], 0.95, 0.08];
    }
    return ['case', ['==', ['get', 'smod_transition_class'], state.selectedTransitionClass], 0.95, 0.08];
  }

  function updateFilterMatchOutline(): void {
    if (!map?.getLayer('ward-filter-match-outline')) return;
    if (state.selectedActionFilter === 'All') {
      map.setFilter('ward-filter-match-outline', ['==', ['get', 'ward_id'], '']);
      return;
    }
    map.setFilter('ward-filter-match-outline', ['==', ['get', 'action_tag'], state.selectedActionFilter]);
  }

  function updateTransitionFocusOutline(): void {
    if (!map?.getLayer('ward-transition-focus-outline')) return;
    if (!isTransitionFocusActive()) {
      map.setFilter('ward-transition-focus-outline', ['==', ['get', 'ward_id'], '']);
      return;
    }
    map.setFilter(
      'ward-transition-focus-outline',
      ['==', ['get', 'smod_transition_class'], state.selectedTransitionClass as string],
    );
  }

  function updateMapSelection(): void {
    if (state.fallbackActive) {
      applyFallbackSelectionHighlight();
      return;
    }

    if (map?.getLayer('ward-highlight')) {
      map.setFilter('ward-highlight', ['==', ['get', 'ward_id'], state.selectedWardId ?? '']);
    }
  }

  function updateMapColors(): void {
    if (state.fallbackActive) {
      refreshFallbackColors();
      updateLegend();
      return;
    }

    if (map?.getLayer('ward-fills')) {
      map.setPaintProperty(
        'ward-fills',
        'fill-color',
        modeColorExpression(state.selectedMode, state.modeBreaks[state.selectedMode]) as any,
      );
      map.setPaintProperty('ward-fills', 'fill-opacity', mapFillOpacity() as any);
    }
    updateFilterMatchOutline();
    updateTransitionFocusOutline();
    updateLegend();
  }

  function applyWardSelection(wardId: string): void {
    if (!wardId) return;
    if (state.selectedActionFilter !== 'All' && !isWardVisibleByFilterId(wardId)) {
      state.selectedActionFilter = 'All';
      updateActionFilterButtons();
      updateMapColors();
    }
    state.selectedWardId = wardId;
    updateMapSelection();
    updateKpis();
    updateWardPanel();
    updateDriverBars();
    updateTrendChart();
    updateRankingChart();
    updateSelectedWardChip();
    scheduleBottomPanelSync();
  }

  function clearWardSelection(): void {
    if (!state.selectedWardId) return;
    state.selectedWardId = null;
    updateMapSelection();
    updateAllPanels();
    scheduleBottomPanelSync();
  }

  function isBasemapError(event: unknown): boolean {
    const evt = event as {
      sourceId?: string;
      tile?: { tileID?: { canonical?: { z?: number; x?: number; y?: number } } };
      error?: { message?: string };
    };
    const sourceId = String(evt?.sourceId ?? '');
    const message = String(evt?.error?.message ?? '').toLowerCase();
    if (sourceId === 'carto-base' || sourceId === 'carto-labels') return true;
    if (message.includes('cartocdn.com')) return true;
    if (message.includes('carto-base') || message.includes('carto-labels')) return true;
    if (message.includes('raster') && message.includes('tile')) return true;
    return false;
  }

  function registerBasemapWarning(message: string): void {
    state.basemapStatus = 'warning';
    state.basemapWarning = message;
    if (map?.getLayer('carto-base')) {
      map.setLayoutProperty('carto-base', 'visibility', 'none');
    }
    if (map?.getLayer('carto-labels')) {
      map.setLayoutProperty('carto-labels', 'visibility', 'none');
    }
    setRenderBadge();
    updateRuntimeDiag();
  }

  function initializeMap(): void {
    if (state.requestedRenderer === 'svg') {
      activateFallback('renderer=svg (forced)');
      return;
    }

    const mapWatchdog = window.setTimeout(() => {
      if (!mapLoaded) activateFallback('WebGL load timeout (>2s)');
    }, 2000);

    try {
      map = new maplibregl.Map({
        container: 'mapCanvas',
        style: {
          version: 8,
          sources: {
            'carto-base': {
              type: 'raster',
              tiles: [
                'https://a.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png',
                'https://b.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png',
                'https://c.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png',
                'https://d.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png',
              ],
              tileSize: 256,
              attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
              maxzoom: 20,
            },
            'carto-labels': {
              type: 'raster',
              tiles: [
                'https://a.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}.png',
                'https://b.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}.png',
                'https://c.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}.png',
                'https://d.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}.png',
              ],
              tileSize: 256,
              attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
              maxzoom: 20,
            },
          },
          layers: [
            { id: 'background', type: 'background', paint: { 'background-color': '#edf2f5' } },
            {
              id: 'carto-base',
              type: 'raster',
              source: 'carto-base',
              minzoom: 0,
              maxzoom: 22,
              paint: { 'raster-opacity': 0.96 },
            },
          ],
        },
        center: [18.45, -33.92],
        zoom: 9,
      });
    } catch (error) {
      window.clearTimeout(mapWatchdog);
      activateFallback(toErrorMessage(error, 'Map initialization error'));
      return;
    }

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');

    map.on('error', (event) => {
      if (isBasemapError(event)) {
        const message = toErrorMessage((event as { error?: unknown }).error, 'Basemap tile warning');
        registerBasemapWarning(message);
        return;
      }
      if (!state.fallbackActive) {
        activateFallback(toErrorMessage((event as { error?: unknown }).error, 'Map runtime error'));
      }
    });

    map.on('load', () => {
      mapLoaded = true;
      window.clearTimeout(mapWatchdog);
      state.activeRenderer = 'webgl';
      state.basemapStatus = state.basemapStatus === 'warning' ? 'warning' : 'active';
      state.basemapWarning = state.basemapStatus === 'warning' ? state.basemapWarning : null;

      if (!map) return;

      map.addSource('wards', { type: 'geojson', data: wards as unknown as GeoJSON.FeatureCollection });
      map.addLayer({
        id: 'ward-fills',
        type: 'fill',
        source: 'wards',
        paint: {
          'fill-color': modeColorExpression(state.selectedMode, state.modeBreaks[state.selectedMode]) as any,
          'fill-opacity': mapFillOpacity() as any,
        },
      });
      map.addLayer({
        id: 'carto-labels',
        type: 'raster',
        source: 'carto-labels',
        minzoom: 0,
        maxzoom: 22,
        paint: { 'raster-opacity': 0.86 },
      });
      map.addLayer({
        id: 'ward-outlines',
        type: 'line',
        source: 'wards',
        paint: {
          'line-color': '#32495c',
          'line-width': 0.75,
        },
      });
      map.addLayer({
        id: 'ward-filter-match-outline',
        type: 'line',
        source: 'wards',
        paint: {
          'line-color': '#102f49',
          'line-width': 1.6,
          'line-opacity': 0.95,
        },
        filter: ['==', ['get', 'ward_id'], ''],
      });
      map.addLayer({
        id: 'ward-transition-focus-outline',
        type: 'line',
        source: 'wards',
        paint: {
          'line-color': '#173a5a',
          'line-width': 1.9,
          'line-opacity': 0.95,
        },
        filter: ['==', ['get', 'ward_id'], ''],
      });
      map.addLayer({
        id: 'ward-highlight',
        type: 'line',
        source: 'wards',
        paint: {
          'line-color': '#001f3f',
          'line-width': 2.8,
        },
        filter: ['==', ['get', 'ward_id'], ''],
      });

      map.on('click', 'ward-fills', (event) => {
        const feature = event.features?.[0] as WardFeature | undefined;
        if (!feature) return;
        applyWardSelection(feature.properties.ward_id);
      });

      map.on('mouseenter', 'ward-fills', () => {
        if (map) map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mousemove', 'ward-fills', (event) => {
        const feature = event.features?.[0] as WardFeature | undefined;
        if (!feature) return;
        showMapTooltip(feature, event.point.x, event.point.y);
      });
      map.on('mouseleave', 'ward-fills', () => {
        if (map) map.getCanvas().style.cursor = '';
        hideMapTooltip();
      });

      map.fitBounds(getBounds(wards), { padding: 24, duration: 0 });

      window.setTimeout(() => {
        try {
          const featureCount = map?.querySourceFeatures('wards')?.length ?? 0;
          state.mapFeatureCount = featureCount;
          if (featureCount === 0) activateFallback('Ward layer did not render features');
          else updateRuntimeDiag();
        } catch (error) {
          activateFallback(toErrorMessage(error, 'Ward feature query failed'));
        }
      }, 500);

      setRenderBadge();
      updateFilterMatchOutline();
      updateTransitionFocusOutline();
      updateRuntimeDiag();
      scheduleBottomPanelSync();
    });
  }

  function configureActionFilterControls(): void {
    while (actionFilterBar.firstChild) actionFilterBar.removeChild(actionFilterBar.firstChild);
    for (const filter of ACTION_FILTER_OPTIONS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ugm-filter-btn';
      button.textContent = filter;
      button.dataset.filter = filter;
      button.addEventListener('click', () => {
        const next = actionFilterFromText(button.dataset.filter ?? 'All');
        if (state.selectedActionFilter === next) return;
        state.selectedActionFilter = next;
        updateActionFilterButtons();
        updateMapColors();
        updateRankingChart();
        updateRuntimeDiag();
      });
      actionFilterButtons.set(filter, button);
      actionFilterBar.appendChild(button);
    }
    updateActionFilterButtons();
  }

  function configureRankingDirectionControls(): void {
    for (const button of rankingDirectionButtons) {
      const direction = (button.dataset.rankingDirection ?? 'top') as RankingDirection;
      rankingDirectionButtonMap.set(direction, button);
      button.addEventListener('click', () => {
        if (state.rankingDirection === direction) return;
        state.rankingDirection = direction;
        updateRankingChart();
      });
    }
    updateRankingDirectionButtons();
  }

  trendContext.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const card = target.closest<HTMLElement>('[data-transition-class]');
    if (card) {
      const transitionClass = card.dataset.transitionClass ?? null;
      if (!transitionClass) return;
      if (state.selectedTransitionClass === transitionClass) {
        setTransitionFocus(null);
      } else {
        setTransitionFocus(transitionClass);
      }
      return;
    }

    const clearFocus = target.closest<HTMLElement>('[data-clear-transition-focus]');
    if (clearFocus) {
      setTransitionFocus(null);
      return;
    }

    const wardChip = target.closest<HTMLElement>('[data-transition-ward-id]');
    if (wardChip) {
      const wardId = wardChip.dataset.transitionWardId ?? '';
      if (!wardId) return;
      applyWardSelection(wardId);
    }
  });

  manifestBadge.textContent = `Dataset ${manifest.dataset_version} • ${manifest.generated_at}`;
  dataBadge.textContent = `Wards: ${manifest.ward_count} • Latest VIIRS: ${manifest.latest_viirs_month}${
    contentInsights ? ' • Content + S-Mod transitions ready' : ' • Content fallback'
  }`;
  setRenderBadge();
  updateRuntimeDiag();
  configureActionFilterControls();
  configureRankingDirectionControls();
  clearSelectionBtn.addEventListener('click', () => {
    clearWardSelection();
  });

  for (const tab of tabButtons) {
    tab.addEventListener('click', () => {
      const mode = tab.dataset.mode as ModeId;
      if (!mode || state.selectedMode === mode) return;
      state.selectedMode = mode;
      updateMapColors();
      updateAllPanels();
    });
  }

  updateAllPanels();
  initializeMap();
  scheduleBottomPanelSync();

  if ('ResizeObserver' in window) {
    resizeObserver = new ResizeObserver(() => {
      scheduleBottomPanelSync();
    });
    resizeObserver.observe(leftCol);
    resizeObserver.observe(mapWrap);
  }

  window.addEventListener('resize', () => {
    if (resizeDebounceTimer !== null) {
      window.clearTimeout(resizeDebounceTimer);
    }
    resizeDebounceTimer = window.setTimeout(() => {
      if (state.fallbackActive) renderFallbackSvg();
      else map?.resize();
      scheduleBottomPanelSync();
    }, 90);
  });

  window.addEventListener('beforeunload', () => {
    if (resizeObserver) resizeObserver.disconnect();
  });
}

bootstrap().catch((error) => {
  const app = document.querySelector<HTMLDivElement>('#app');
  if (!app) return;
  app.innerHTML = `<pre class="ugm-error">Failed to load dashboard: ${String(error)}</pre>`;
});
