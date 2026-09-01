import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildBasemapStyle,
  createMapboxComplianceControl,
  initializeMapboxRenderer,
  isMapboxBasemapError,
} from '../src/basemap';

describe('UGM Mapbox basemap', () => {
  it('builds a Mapbox Light Static Tiles source when a token is supplied', () => {
    const result = buildBasemapStyle('pk.test-token');

    expect(result.kind).toBe('available');
    if (result.kind !== 'available') return;

    const source = result.style.sources['mapbox-light'];
    expect(source).toEqual({
      type: 'raster',
      tiles: ['https://api.mapbox.com/styles/v1/mapbox/light-v11/tiles/512/{z}/{x}/{y}?access_token=pk.test-token'],
      tileSize: 512,
      attribution:
        '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> <a href="https://apps.mapbox.com/feedback/" target="_blank" rel="noopener noreferrer">Improve this map</a>',
      maxzoom: 22,
    });
    expect(result.style.layers).toContainEqual({
      id: 'mapbox-light',
      type: 'raster',
      source: 'mapbox-light',
      minzoom: 0,
      maxzoom: 22,
      paint: { 'raster-opacity': 0.96 },
    });
    expect(JSON.stringify(result.style)).not.toContain('cartocdn.com');
    expect(JSON.stringify(result.style)).not.toContain('pk.ey');
  });

  it('renders the official local Mapbox wordmark and all required text links only while active', () => {
    const control = createMapboxComplianceControl(document);
    const wordmark = control.element.querySelector<HTMLAnchorElement>('.ugm-mapbox-wordmark');
    const wordmarkSvg = wordmark?.querySelector('svg');
    const wordmarkPath = wordmarkSvg?.querySelector('path');
    const textLinks = Array.from(
      control.element.querySelectorAll<HTMLAnchorElement>('.ugm-mapbox-attribution a'),
    );

    expect(control.element.hidden).toBe(true);
    expect(wordmark?.href).toBe('https://www.mapbox.com/');
    expect(wordmarkSvg?.getAttribute('viewBox')).toBe('0 0 81 20');
    expect(createHash('sha256').update(wordmarkPath?.getAttribute('d') ?? '').digest('hex')).toBe(
      'c3de6bddb0897c333645a0f814aa8bb531da6ccebc785c92788eb542ca350c51',
    );
    expect(control.element.querySelector('img[src^="http"]')).toBeNull();
    expect(textLinks.map((link) => link.textContent?.trim())).toEqual([
      '© Mapbox',
      '© OpenStreetMap',
      'Improve this map',
    ]);
    expect(textLinks.map((link) => link.href)).toEqual([
      'https://www.mapbox.com/about/maps/',
      'https://www.openstreetmap.org/copyright',
      'https://apps.mapbox.com/feedback/',
    ]);

    control.show({ lng: 18.45, lat: -33.92, zoom: 9 });
    expect(control.element.hidden).toBe(false);
    expect(textLinks[2].href).toBe('https://apps.mapbox.com/feedback/#/18.45/-33.92/9');

    control.hide();
    expect(control.element.hidden).toBe(true);
  });

  it('reports Mapbox tile errors without treating CARTO errors as its provider', () => {
    expect(isMapboxBasemapError({ sourceId: 'mapbox-light' })).toBe(true);
    expect(isMapboxBasemapError({ error: { message: 'Request to api.mapbox.com failed' } })).toBe(true);
    expect(isMapboxBasemapError({ sourceId: 'carto-base' })).toBe(false);
    expect(isMapboxBasemapError({ error: { message: 'cartocdn.com tile failed' } })).toBe(false);
  });

  it('fails closed when the Mapbox token is missing', () => {
    expect(buildBasemapStyle(undefined)).toEqual({
      kind: 'unavailable',
      warning: 'Mapbox basemap unavailable: VITE_MAPBOX_ACCESS_TOKEN is not configured.',
    });
  });

  it.each(['sk.secret-token', 'not-a-mapbox-token'])('fails closed for a non-public token: %s', (token) => {
    const result = buildBasemapStyle(token);

    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') return;
    expect(result.warning).toContain('public pk.* token');
    expect(result.warning).not.toContain(token);
  });

  it('activates fallback without constructing a renderer when the token is missing', () => {
    let rendererConstructed = false;
    let fallbackReason: string | null = null;
    const renderer = initializeMapboxRenderer(
      '   ',
      () => {
        rendererConstructed = true;
        return { renderer: 'webgl' };
      },
      (warning) => {
        fallbackReason = warning;
      },
    );

    expect(renderer).toBeNull();
    expect(rendererConstructed).toBe(false);
    expect(fallbackReason).toBe('Mapbox basemap unavailable: VITE_MAPBOX_ACCESS_TOKEN is not configured.');
  });
});
