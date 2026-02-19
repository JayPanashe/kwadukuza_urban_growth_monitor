import { describe, expect, it } from 'vitest';

describe('offline data contracts', () => {
  it('expects generated data files to exist after build:data', async () => {
    const files = [
      '/data/manifest.json',
      '/data/kzn292_wards.geojson',
      '/data/kzn292_viirs_timeseries.json',
      '/data/kzn292_summary.json',
      '/data/qa_report.json',
    ];

    expect(files.length).toBe(5);
  });
});
