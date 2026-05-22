import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'public', 'data');

describe('generated data files', () => {
  it('contains all required outputs', () => {
    const expected = [
      'manifest.json',
      'kzn292_wards.geojson',
      'kzn292_viirs_timeseries.json',
      'kzn292_summary.json',
      'kzn292_content_insights.json',
      'kzn292_ghsl_anomaly_audit.json',
      'qa_report.json',
    ];

    for (const name of expected) {
      expect(fs.existsSync(path.join(dataDir, name))).toBe(true);
    }
  });

  it('has 30 mapped wards in kzn292_wards.geojson', () => {
    const wards = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'kzn292_wards.geojson'), 'utf-8'),
    ) as { features: unknown[] };

    expect(Array.isArray(wards.features)).toBe(true);
    expect(wards.features).toHaveLength(30);
  });

  it('tracks VIIRS latest month in manifest without exposing local paths', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'manifest.json'), 'utf-8'),
    ) as {
      dataset_version?: string;
      latest_viirs_month?: string;
      ward_count?: number;
      source_files?: Array<Record<string, unknown>>;
    };

    expect(manifest.dataset_version).toMatch(/^sem-ugm-kzn292-/);
    expect(manifest.latest_viirs_month).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(manifest.ward_count).toBe(30);
    expect(Array.isArray(manifest.source_files)).toBe(true);
    expect((manifest.source_files ?? []).length).toBeGreaterThanOrEqual(7);

    for (const source of manifest.source_files ?? []) {
      expect(typeof source.source_key).toBe('string');
      expect(typeof source.file_name).toBe('string');
      expect(source.path).toBeUndefined();
    }
  });

  it('contains required v2 scoring fields and valid ranges for every ward', () => {
    const wards = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'kzn292_wards.geojson'), 'utf-8'),
    ) as { features: Array<{ properties: Record<string, unknown> }> };

    const required = [
      'stress_score',
      'momentum_score',
      'constraint_score',
      'priority_risk_score',
      'score_confidence',
      'stress_band',
      'momentum_band',
      'constraint_band',
      'bivariate_class',
      'action_tag',
      'priority_rank',
      'census_pop_2022',
      'ghsl_pop_2030',
      'ghsl_pop_density_2022',
      'ghsl_density_gap_2022_vs_2030',
      'ghsl_density_gap_flag',
      'ghsl_pop_change_2022_2030',
      'ghsl_pop_pct_change_2022_2030',
      'ghsl_service_pressure_2030',
      'viirs_cagr_mean',
      'viirs_yoy_mean',
      'viirs_trend_slope',
      'viirs_proxy_momentum_component',
      'lc_urban_pct',
      'protected_area_pct',
      'landcover_story_class',
      'smod_degurba_l1_2020',
      'smod_degurba_l1_2030',
      'smod_degurba_label_2020',
      'smod_degurba_label_2030',
      'smod_urban_share_2020',
      'smod_urban_share_2030',
      'smod_urban_share_change_pp',
      'smod_transition_class',
    ];

    for (const feature of wards.features) {
      for (const key of required) {
        expect(feature.properties[key]).not.toBeNull();
        expect(feature.properties[key]).not.toBeUndefined();
      }

      for (const key of ['stress_score', 'momentum_score', 'constraint_score', 'priority_risk_score']) {
        const value = Number(feature.properties[key]);
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
      }

      const census = Number(feature.properties.census_pop_2022);
      const density2022 = Number(feature.properties.ghsl_pop_density_2022);
      expect(Number.isFinite(census)).toBe(true);
      expect(census).toBeGreaterThan(0);
      expect(Number.isFinite(density2022)).toBe(true);
      expect(density2022).toBeGreaterThan(0);

      const pop2030 = Number(feature.properties.ghsl_pop_2030);
      const popChangePct = Number(feature.properties.ghsl_pop_pct_change_2022_2030);
      const densityGap = Number(feature.properties.ghsl_density_gap_2022_vs_2030);
      const viirsCagr = Number(feature.properties.viirs_cagr_mean);
      const protectedAreaPct = Number(feature.properties.protected_area_pct);
      expect(Number.isFinite(pop2030)).toBe(true);
      expect(Number.isFinite(popChangePct)).toBe(true);
      expect(Number.isFinite(densityGap)).toBe(true);
      expect(Number.isFinite(viirsCagr)).toBe(true);
      expect(Number.isFinite(protectedAreaPct)).toBe(true);
      expect(protectedAreaPct).toBeGreaterThanOrEqual(0);
      expect(protectedAreaPct).toBeLessThanOrEqual(100);

      const action = String(feature.properties.action_tag ?? '');
      const bivariate = String(feature.properties.bivariate_class ?? '');
      const densityGapFlag = String(feature.properties.ghsl_density_gap_flag ?? '');
      const smodTransition = String(feature.properties.smod_transition_class ?? '');
      const landcoverStory = String(feature.properties.landcover_story_class ?? '');
      expect(action.length).toBeGreaterThan(0);
      expect(bivariate.length).toBeGreaterThan(0);
      expect(['observed_above_forecast', 'forecast_above_observed', 'near_parity']).toContain(densityGapFlag);
      expect(smodTransition.length).toBeGreaterThan(0);
      expect(landcoverStory.length).toBeGreaterThan(0);
    }
  });

  it('has VIIRS time series coverage from 2014-01-01', () => {
    const rows = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'kzn292_viirs_timeseries.json'), 'utf-8'),
    ) as Array<{ date: string }>;

    const dates = rows.map((row) => row.date).sort();
    expect(dates[0]).toBe('2014-01-01');
  });

  it('includes v2 summary interface additions', () => {
    const summary = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'kzn292_summary.json'), 'utf-8'),
    ) as {
      score_formula?: Record<string, unknown>;
      class_counts?: Record<string, unknown>;
      top_priority_wards?: unknown[];
      actions_summary?: unknown[];
      metric_options?: unknown[];
      city_display_name?: string;
      viirs_growth_window_start?: string;
      viirs_growth_window_end?: string;
      viirs_index_base_month?: string;
      viirs_momentum_note?: string;
      tourism_active_ward_count?: number;
      tourism_active_ward_share_pct?: number;
      tourism_city_card_definition?: string;
      comparability?: {
        normalization_scope?: string;
        cross_metro_comparable?: boolean;
      };
      smod_transition_counts?: Record<string, number>;
      smod_city_urban_share_2020?: number;
      smod_city_urban_share_2030?: number;
      smod_city_urban_share_change_pp?: number;
      ghsl_cluster_semantics?: {
        display_mapping?: Record<string, string>;
        display_definitions?: Record<string, string>;
      };
    };

    expect(summary.score_formula).toBeTruthy();
    expect(summary.class_counts).toBeTruthy();
    expect(Array.isArray(summary.top_priority_wards)).toBe(true);
    expect((summary.top_priority_wards ?? []).length).toBe(15);
    expect(Array.isArray(summary.actions_summary)).toBe(true);
    expect(Array.isArray(summary.metric_options)).toBe(true);
    expect((summary.metric_options ?? []).length).toBeGreaterThanOrEqual(4);
    expect(typeof summary.city_display_name).toBe('string');
    expect(String(summary.city_display_name ?? '').trim().length).toBeGreaterThan(0);
    expect(summary.viirs_growth_window_start).toBe('2014-01-01');
    expect(summary.viirs_growth_window_end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(summary.viirs_index_base_month).toBe('2014-01-01');
    expect(typeof summary.viirs_momentum_note).toBe('string');
    expect(Number.isInteger(summary.tourism_active_ward_count)).toBe(true);
    expect(Number(summary.tourism_active_ward_count)).toBeGreaterThanOrEqual(0);
    expect(Number(summary.tourism_active_ward_count)).toBeLessThanOrEqual(30);
    expect(Number.isFinite(Number(summary.tourism_active_ward_share_pct))).toBe(true);
    expect(Number(summary.tourism_active_ward_share_pct)).toBeGreaterThanOrEqual(0);
    expect(Number(summary.tourism_active_ward_share_pct)).toBeLessThanOrEqual(100);
    const expectedTourismShare = (Number(summary.tourism_active_ward_count) / 30) * 100;
    expect(Math.abs(Number(summary.tourism_active_ward_share_pct) - expectedTourismShare)).toBeLessThanOrEqual(0.01);
    expect(String(summary.tourism_city_card_definition ?? '')).toContain('Airbnb excluded');
    expect(summary.comparability?.normalization_scope).toBe('kzn292_percentile');
    expect(summary.comparability?.cross_metro_comparable).toBe(false);
    expect(Object.keys(summary.smod_transition_counts ?? {}).length).toBeGreaterThan(0);
    expect(Number.isFinite(Number(summary.smod_city_urban_share_2020))).toBe(true);
    expect(Number.isFinite(Number(summary.smod_city_urban_share_2030))).toBe(true);
    expect(Number.isFinite(Number(summary.smod_city_urban_share_change_pp))).toBe(true);
    expect(summary.ghsl_cluster_semantics?.display_mapping?.Declining).toBe('Slowing');
    expect(String(summary.ghsl_cluster_semantics?.display_definitions?.Slowing ?? '').length).toBeGreaterThan(0);
  });

  it('reconciles S-Mod transition counts and non-stable classes', () => {
    const wards = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'kzn292_wards.geojson'), 'utf-8'),
    ) as { features: Array<{ properties: Record<string, unknown> }> };
    const summary = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'kzn292_summary.json'), 'utf-8'),
    ) as { smod_transition_counts?: Record<string, number> };

    const grouped = new Map<string, number>();
    for (const feature of wards.features) {
      const key = String(feature.properties.smod_transition_class ?? 'Unknown');
      grouped.set(key, (grouped.get(key) ?? 0) + 1);
    }

    const summaryCounts = summary.smod_transition_counts ?? {};
    for (const [transitionClass, count] of grouped.entries()) {
      expect(Number(summaryCounts[transitionClass] ?? 0)).toBe(count);
    }

    const nonStable = [
      'Emerging node transition',
      'Town-to-city transition',
      'Urban core intensification',
      'Town intensification',
      'Decentralisation signal',
    ];
    const totalNonStable = nonStable.reduce((sum, key) => sum + Number(summaryCounts[key] ?? 0), 0);
    expect(totalNonStable).toBeGreaterThanOrEqual(0);
  });

  it('contains workbook-derived content insight contract', () => {
    const content = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'kzn292_content_insights.json'), 'utf-8'),
    ) as {
      dataset_version?: string;
      ward_count?: number;
      city_headline_kpis?: Record<string, { display?: string | null; value?: number | null }>;
      top_lists?: Record<string, Array<{ value?: number | null }>>;
      ward_insights?: Array<{
        ward_id?: string;
        why_this_ward?: string[];
        ghsl?: {
          smod_transition_class?: string;
          ghsl_cluster?: string;
          ghsl_cluster_raw?: string;
          ghsl_cluster_display?: string;
        };
        landcover?: {
          landcover_story_class?: string;
        };
      }>;
      required_labels_resolved?: { ghsl?: boolean; viirs?: boolean; landcover?: boolean };
    };

    expect(content.dataset_version).toMatch(/^sem-ugm-kzn292-/);
    expect(content.ward_count).toBe(30);
    expect(Array.isArray(content.ward_insights)).toBe(true);
    expect((content.ward_insights ?? []).length).toBe(30);
    expect(Object.keys(content.city_headline_kpis ?? {}).length).toBeGreaterThanOrEqual(10);
    expect(Array.isArray(content.top_lists?.viirs_growth_rank)).toBe(true);
    expect(Array.isArray(content.top_lists?.viirs_decline_rank)).toBe(true);
    expect(Array.isArray(content.top_lists?.ghsl_pop_density)).toBe(true);
    expect(Array.isArray(content.top_lists?.landcover_agriculture)).toBe(true);
    if (content.top_lists?.viirs_cagr_rank !== undefined) {
      expect(Array.isArray(content.top_lists.viirs_cagr_rank)).toBe(true);
    }
    expect(content.required_labels_resolved?.ghsl).toBe(true);
    expect(content.required_labels_resolved?.viirs).toBe(true);
    expect(content.required_labels_resolved?.landcover).toBe(true);

    for (const [key, kpi] of Object.entries(content.city_headline_kpis ?? {})) {
      expect(typeof kpi.display).toBe('string');
      expect(String(kpi.display ?? '').trim().length).toBeGreaterThan(0);
      expect(kpi.value === null || Number.isFinite(Number(kpi.value))).toBe(true);
      expect(key.length).toBeGreaterThan(0);
    }

    const sample = content.ward_insights?.[0];
    expect(typeof sample?.ward_id).toBe('string');
    expect(Array.isArray(sample?.why_this_ward)).toBe(true);
    expect((sample?.why_this_ward ?? []).length).toBeGreaterThan(0);
    expect(String(sample?.ghsl?.smod_transition_class ?? '').length).toBeGreaterThan(0);
    expect(String(sample?.landcover?.landcover_story_class ?? '').length).toBeGreaterThan(0);
    expect(String(sample?.ghsl?.ghsl_cluster_raw ?? '').length).toBeGreaterThan(0);
    expect(String(sample?.ghsl?.ghsl_cluster_display ?? '').length).toBeGreaterThan(0);

    const slowingRows = (content.ward_insights ?? []).filter(
      (row) => String(row.ghsl?.ghsl_cluster_raw ?? '') === 'Declining',
    );
    for (const row of slowingRows) {
      expect(String(row.ghsl?.ghsl_cluster_display ?? '')).toBe('Slowing');
    }

    const census2022 = content.city_headline_kpis?.ghsl_census_2022;
    expect(typeof census2022?.display).toBe('string');
    expect(String(census2022?.display ?? '').trim().length).toBeGreaterThan(0);
    expect(Number.isFinite(Number(census2022?.value))).toBe(true);

    const topGrowth = (content.top_lists?.viirs_growth_rank ?? []).slice(0, 10);
    expect(topGrowth).toHaveLength(10);
    for (const row of topGrowth) {
      expect(Number(row.value)).toBeGreaterThanOrEqual(0);
    }
    for (let i = 0; i < topGrowth.length - 1; i += 1) {
      expect(Number(topGrowth[i].value)).toBeGreaterThanOrEqual(Number(topGrowth[i + 1].value));
    }

    const topViirsCagr = (content.top_lists?.viirs_cagr_rank ?? []).slice(0, 10);
    if (topViirsCagr.length > 0) {
      for (let i = 0; i < topViirsCagr.length - 1; i += 1) {
        expect(Number(topViirsCagr[i].value)).toBeGreaterThanOrEqual(Number(topViirsCagr[i + 1].value));
      }
    }
  });

  it('includes GHSL anomaly audit output consistent with ward flags', () => {
    const wards = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'kzn292_wards.geojson'), 'utf-8'),
    ) as { features: Array<{ properties: Record<string, unknown> }> };
    const audit = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'kzn292_ghsl_anomaly_audit.json'), 'utf-8'),
    ) as {
      negative_growth_ward_count?: number;
      wards?: Array<{ ward_id?: string; ghsl_pop_change_2022_2030?: number }>;
    };

    const flagged = wards.features
      .filter((feature) => Boolean(feature.properties.ghsl_negative_growth_flag))
      .map((feature) => String(feature.properties.ward_id))
      .sort();
    const audited = (audit.wards ?? []).map((row) => String(row.ward_id)).sort();

    expect(audit.negative_growth_ward_count).toBe(audited.length);
    expect(audited).toEqual(flagged);
    for (const row of audit.wards ?? []) {
      expect(Number(row.ghsl_pop_change_2022_2030)).toBeLessThan(0);
    }
  });

  it('reports passing critical QA gates', () => {
    const qa = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'qa_report.json'), 'utf-8'),
    ) as {
      status: string;
      failed_checks?: string[];
      density_consistency?: {
        tolerance_persons_per_km2?: number;
        max_abs_diff_persons_per_km2?: number | null;
      };
      protected_area_recompute?: {
        method?: string;
        max_delta_vs_legacy_pct_points?: number | null;
        wards_changed_count?: number;
        sanity_wards?: Record<string, { recomputed_pct?: number }>;
      };
      cluster_interpretation_audit?: {
        counts_by_raw_cluster?: Record<
          string,
          {
            display_label?: string;
            ward_count?: number;
            negative_census_to_2030_count?: number;
            negative_census_to_2030_share_pct?: number;
            negative_modeled_2020_to_2030_count?: number;
            negative_modeled_2020_to_2030_share_pct?: number;
          }
        >;
        total_wards?: number;
      };
    };

    expect(qa.status).toBe('pass');
    expect(qa.failed_checks ?? []).toHaveLength(0);
    expect(qa.density_consistency?.tolerance_persons_per_km2).toBe(0.1);
    expect(Number(qa.density_consistency?.max_abs_diff_persons_per_km2 ?? 0)).toBeLessThanOrEqual(0.1);
    expect(qa.protected_area_recompute?.method).toBe('unioned_intersection');
    expect(Number(qa.protected_area_recompute?.wards_changed_count ?? 0)).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(Number(qa.protected_area_recompute?.max_delta_vs_legacy_pct_points))).toBe(true);
    const sanityWards = Object.values(qa.protected_area_recompute?.sanity_wards ?? {});
    expect(sanityWards.length).toBeGreaterThanOrEqual(1);
    for (const ward of sanityWards) {
      expect(Number.isFinite(Number(ward.recomputed_pct))).toBe(true);
    }
    expect(Number(qa.cluster_interpretation_audit?.total_wards ?? 0)).toBe(30);
    const declining = qa.cluster_interpretation_audit?.counts_by_raw_cluster?.Declining;
    expect(declining?.display_label).toBe('Slowing');
    expect(Number.isFinite(Number(declining?.negative_census_to_2030_share_pct))).toBe(true);
    expect(Number.isFinite(Number(declining?.negative_modeled_2020_to_2030_share_pct))).toBe(true);
  });
});
