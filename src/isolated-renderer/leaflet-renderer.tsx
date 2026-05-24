/**
 * Leaflet/GeoJSON Renderer Plugin
 *
 * On-demand renderer plugin for application/geo+json outputs.
 * Bundles Leaflet directly — no window.L global.
 * Loaded into the isolated iframe via the renderer plugin API.
 *
 * Leaflet CSS is delivered via the plugin's css channel and injected
 * as a <style> tag by the iframe's installRendererPlugin() handler.
 */

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";

// --- Types ---

interface RendererProps {
  data: unknown;
  metadata?: Record<string, unknown>;
  mimeType: string;
}

interface LeafletMapState {
  element: HTMLDivElement;
  map: L.Map;
  tileLayer: L.TileLayer;
  geoJsonLayer: L.GeoJSON;
  resizeObserver: ResizeObserver;
  themeObserver: MutationObserver;
}

function parseGeoJson(data: unknown): GeoJSON.GeoJsonObject | null {
  if (typeof data === "string") {
    try {
      return JSON.parse(data) as GeoJSON.GeoJsonObject;
    } catch {
      return null;
    }
  }
  return data ? (data as GeoJSON.GeoJsonObject) : null;
}

function tileUrlForTheme(isDark: boolean): string {
  return isDark
    ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
    : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
}

function featureColorForTheme(isDark: boolean): string {
  return isDark ? "#818cf8" : "#4f46e5";
}

function addTileLayer(map: L.Map, isDark: boolean): L.TileLayer {
  return L.tileLayer(tileUrlForTheme(isDark), {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    maxZoom: 19,
  }).addTo(map);
}

function addGeoJsonLayer(map: L.Map, data: GeoJSON.GeoJsonObject, isDark: boolean): L.GeoJSON {
  const featureColor = featureColorForTheme(isDark);
  return L.geoJSON(data, {
    style: {
      color: featureColor,
      weight: 2,
      fillOpacity: 0.25,
      fillColor: featureColor,
    },
    pointToLayer: (_feature, latlng) => {
      return L.circleMarker(latlng, {
        radius: 6,
        color: featureColor,
        weight: 2,
        fillOpacity: 0.5,
        fillColor: featureColor,
      });
    },
  }).addTo(map);
}

function fitInitialBounds(map: L.Map, geoJsonLayer: L.GeoJSON): void {
  const bounds = geoJsonLayer.getBounds();
  if (bounds.isValid()) {
    map.fitBounds(bounds, { padding: [20, 20] });
  } else {
    map.setView([0, 0], 2);
  }
}

// --- GeoJSON Renderer ---

function GeoJsonRenderer({ data: rawData }: RendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapStateRef = useRef<LeafletMapState | null>(null);

  const data = useMemo(() => parseGeoJson(rawData), [rawData]);

  const cleanupMap = useCallback(() => {
    const state = mapStateRef.current;
    if (!state) return;

    state.themeObserver.disconnect();
    state.resizeObserver.disconnect();
    state.map.remove();
    mapStateRef.current = null;
  }, []);

  const setContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      const previous = containerRef.current;
      if (!node && previous && mapStateRef.current?.element === previous) {
        cleanupMap();
      }
      containerRef.current = node;
    },
    [cleanupMap],
  );

  useEffect(() => () => cleanupMap(), [cleanupMap]);

  useEffect(() => {
    if (!containerRef.current || !data) {
      cleanupMap();
      return;
    }

    const el = containerRef.current;
    const isDark = document.documentElement.classList.contains("dark");
    const existingState = mapStateRef.current;

    if (existingState?.element === el) {
      existingState.geoJsonLayer.remove();
      existingState.geoJsonLayer = addGeoJsonLayer(existingState.map, data, isDark);
      return;
    }

    cleanupMap();

    const map = L.map(el, { zoomAnimation: true });
    const tileLayer = addTileLayer(map, isDark);
    const geoJsonLayer = addGeoJsonLayer(map, data, isDark);
    fitInitialBounds(map, geoJsonLayer);

    const resizeObserver = new ResizeObserver(() => {
      map.invalidateSize();
    });
    resizeObserver.observe(el);

    const themeObserver = new MutationObserver(() => {
      const state = mapStateRef.current;
      if (!state) return;

      const nowDark = document.documentElement.classList.contains("dark");
      const newColor = featureColorForTheme(nowDark);

      state.tileLayer.remove();
      state.tileLayer = addTileLayer(state.map, nowDark);
      state.geoJsonLayer.setStyle({
        color: newColor,
        fillColor: newColor,
      });
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    mapStateRef.current = {
      element: el,
      map,
      tileLayer,
      geoJsonLayer,
      resizeObserver,
      themeObserver,
    };
  }, [cleanupMap, data]);

  if (!data) return null;

  return (
    <div
      ref={setContainerRef}
      data-slot="geojson-output"
      className={cn("not-prose py-2 max-w-full")}
      style={{ height: "400px", width: "100%" }}
    />
  );
}

// --- Plugin install ---

export function install(ctx: {
  register: (mimeTypes: string[], component: React.ComponentType<RendererProps>) => void;
}) {
  ctx.register(["application/geo+json"], GeoJsonRenderer);
}
