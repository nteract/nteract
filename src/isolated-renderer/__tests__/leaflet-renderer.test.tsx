import { cleanup, render, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { RendererProps } from "@/lib/renderer-registry";
import { install } from "../leaflet-renderer";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof globalThis.ResizeObserver;
}

const leafletMocks = vi.hoisted(() => {
  const maps: any[] = [];
  const tileLayers: any[] = [];
  const geoJsonLayers: any[] = [];

  return {
    maps,
    tileLayers,
    geoJsonLayers,
    map: vi.fn((_element, _options) => {
      const map = {
        fitBounds: vi.fn(),
        setView: vi.fn(),
        invalidateSize: vi.fn(),
        remove: vi.fn(),
      };
      maps.push(map);
      return map;
    }),
    tileLayer: vi.fn((_url, _options) => {
      const layer = {
        addTo: vi.fn().mockReturnThis(),
        remove: vi.fn(),
        getTileUrl: vi.fn(),
      };
      tileLayers.push(layer);
      return layer;
    }),
    geoJSON: vi.fn((_data, _options) => {
      const layer = {
        addTo: vi.fn().mockReturnThis(),
        remove: vi.fn(),
        setStyle: vi.fn(),
        getBounds: vi.fn(() => ({ isValid: () => true })),
      };
      geoJsonLayers.push(layer);
      return layer;
    }),
    circleMarker: vi.fn(() => ({ kind: "circle-marker" })),
  };
});

vi.mock("leaflet", () => ({
  default: leafletMocks,
}));

function installLeafletRenderer() {
  let Renderer: ComponentType<RendererProps> | undefined;

  install({
    register: (_mimeTypes, component) => {
      Renderer = component;
    },
  });

  expect(Renderer).toBeDefined();
  return Renderer!;
}

describe("Leaflet renderer plugin", () => {
  const firstGeoJson = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "first" },
        geometry: { type: "Point", coordinates: [-122.4, 37.8] },
      },
    ],
  };

  const nextGeoJson = {
    ...firstGeoJson,
    features: [
      {
        type: "Feature",
        properties: { name: "next" },
        geometry: { type: "Point", coordinates: [-73.9, 40.7] },
      },
    ],
  };

  afterEach(() => {
    cleanup();
    document.documentElement.classList.remove("dark");
    vi.clearAllMocks();
    leafletMocks.maps.length = 0;
    leafletMocks.tileLayers.length = 0;
    leafletMocks.geoJsonLayers.length = 0;
  });

  it("replaces GeoJSON data without recreating the Leaflet map", () => {
    const Renderer = installLeafletRenderer();

    const { rerender } = render(<Renderer data={firstGeoJson} mimeType="application/geo+json" />);

    expect(leafletMocks.map).toHaveBeenCalledTimes(1);
    expect(leafletMocks.tileLayer).toHaveBeenCalledTimes(1);
    expect(leafletMocks.geoJSON).toHaveBeenCalledTimes(1);
    expect(leafletMocks.maps[0].fitBounds).toHaveBeenCalledTimes(1);

    rerender(<Renderer data={nextGeoJson} mimeType="application/geo+json" />);

    expect(leafletMocks.map).toHaveBeenCalledTimes(1);
    expect(leafletMocks.tileLayer).toHaveBeenCalledTimes(1);
    expect(leafletMocks.geoJSON).toHaveBeenCalledTimes(2);
    expect(leafletMocks.geoJsonLayers[0].remove).toHaveBeenCalledTimes(1);
    expect(leafletMocks.geoJsonLayers[1].addTo).toHaveBeenCalledWith(leafletMocks.maps[0]);
    expect(leafletMocks.maps[0].fitBounds).toHaveBeenCalledTimes(1);
    expect(leafletMocks.maps[0].remove).not.toHaveBeenCalled();
  });

  it("removes the Leaflet map when data becomes invalid", () => {
    const Renderer = installLeafletRenderer();

    const { rerender } = render(<Renderer data={firstGeoJson} mimeType="application/geo+json" />);

    rerender(<Renderer data={null} mimeType="application/geo+json" />);

    expect(leafletMocks.maps[0].remove).toHaveBeenCalledTimes(1);
  });

  it("updates the current tile and GeoJSON layers on theme changes", async () => {
    const Renderer = installLeafletRenderer();

    const { rerender } = render(<Renderer data={firstGeoJson} mimeType="application/geo+json" />);
    rerender(<Renderer data={nextGeoJson} mimeType="application/geo+json" />);

    document.documentElement.classList.add("dark");

    await waitFor(() => expect(leafletMocks.tileLayer).toHaveBeenCalledTimes(2));

    expect(leafletMocks.tileLayers[0].remove).toHaveBeenCalledTimes(1);
    expect(leafletMocks.geoJsonLayers[0].setStyle).not.toHaveBeenCalled();
    expect(leafletMocks.geoJsonLayers[1].setStyle).toHaveBeenCalledWith({
      color: "#818cf8",
      fillColor: "#818cf8",
    });
  });
});
