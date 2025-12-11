'use client';

import {
  useRef,
  useState,
  useMemo,
  useEffect,
  useCallback,
  lazy,
  Suspense,
} from 'react';
import * as React from 'react';

// Dynamic imports to prevent infinite renders
const BarChart = lazy(() =>
  import('./bar-chart').then((m) => ({ default: m.BarChart })),
);
const LineChart = lazy(() =>
  import('./line-chart').then((m) => ({ default: m.LineChart })),
);
const PieChart = lazy(() =>
  import('./pie-chart').then((m) => ({ default: m.PieChart })),
);
const ChartWrapper = lazy(() =>
  import('./chart-wrapper').then((m) => ({ default: m.ChartWrapper })),
);
const ChartColorEditor = lazy(() =>
  import('./chart-color-editor').then((m) => ({ default: m.ChartColorEditor })),
);

// Import type only (no runtime import)
import type { ChartType } from './chart-type-selector';

export interface ChartConfig {
  chartType: ChartType;
  title?: string;
  data: Array<Record<string, unknown>>;
  config: {
    colors: string[];
    labels?: Record<string, string>;
    xKey?: string;
    yKey?: string;
    nameKey?: string;
    valueKey?: string;
  };
}

export interface ChartRendererProps {
  chartConfig: ChartConfig;
}

/**
 * Generic chart renderer that accepts LLM output and renders the appropriate chart component
 * Wrapped with title, download, and copy functionality
 */
/**
 * Generate a unique key for chart color persistence
 */
function getChartColorKey(chartConfig: ChartConfig): string {
  // Create a stable key based on chart type, title, and data structure
  const dataHash =
    chartConfig.data.length > 0
      ? JSON.stringify(
          chartConfig.data.slice(0, 3).map((d) => Object.keys(d).sort()),
        )
      : 'empty';
  return `chart-colors:${chartConfig.chartType}:${chartConfig.title || 'untitled'}:${dataHash}`;
}

export function ChartRenderer({ chartConfig }: ChartRendererProps) {
  const { chartType, title } = chartConfig;
  const chartRef = useRef<HTMLDivElement>(null);
  const colorKey = useMemo(() => getChartColorKey(chartConfig), [chartConfig]);

  // Calculate required number of colors based on chart type and data
  const requiredColorCount = useMemo(() => {
    if (chartType === 'pie') {
      // Pie charts need one color per data point (slice)
      return chartConfig.data.length;
    } else if (chartType === 'bar' || chartType === 'line') {
      // Bar and line charts use a single color for the series
      return 1;
    }
    return chartConfig.config.colors.length;
  }, [chartType, chartConfig.data.length, chartConfig.config.colors.length]);

  // Load persisted colors from localStorage on mount
  const loadPersistedColors = useCallback((): string[] | null => {
    if (typeof window === 'undefined') return null;
    try {
      const stored = window.localStorage.getItem(colorKey);
      if (stored) {
        const parsed = JSON.parse(stored) as string[];
        // Validate that it's an array of strings
        if (
          Array.isArray(parsed) &&
          parsed.every((c) => typeof c === 'string')
        ) {
          return parsed.slice(0, requiredColorCount);
        }
      }
    } catch {
      // Ignore localStorage errors
    }
    return null;
  }, [colorKey, requiredColorCount]);

  // Initialize customColors with persisted colors or default
  const [customColors, setCustomColors] = useState<string[]>(() => {
    const persisted = loadPersistedColors();
    if (persisted && persisted.length === requiredColorCount) {
      return persisted;
    }
    return chartConfig.config.colors.slice(0, requiredColorCount);
  });

  // Persist colors to localStorage when they change
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const trimmed = customColors.slice(0, requiredColorCount);
      window.localStorage.setItem(colorKey, JSON.stringify(trimmed));
    } catch {
      // Ignore localStorage errors (e.g., quota exceeded)
    }
  }, [customColors, colorKey, requiredColorCount]);

  // Sync colors when chart config changes (e.g., new chart generated)
  // But preserve persisted colors if they exist
  useEffect(() => {
    const persisted = loadPersistedColors();
    if (persisted && persisted.length === requiredColorCount) {
      // Use queueMicrotask to avoid setState in effect
      queueMicrotask(() => {
        setCustomColors(persisted);
      });
      return;
    }

    const currentColors = chartConfig.config.colors;
    const trimmedColors = currentColors.slice(0, requiredColorCount);
    // If we need more colors than provided, pad with default colors
    if (trimmedColors.length < requiredColorCount) {
      const defaultColors = [
        '#8884d8',
        '#82ca9d',
        '#ffc658',
        '#ff7c7c',
        '#8dd1e1',
      ];
      const paddedColors = [
        ...trimmedColors,
        ...defaultColors.slice(trimmedColors.length, requiredColorCount),
      ];
      queueMicrotask(() => {
        setCustomColors(paddedColors);
      });
    } else {
      queueMicrotask(() => {
        setCustomColors(trimmedColors);
      });
    }
  }, [chartConfig.config.colors, requiredColorCount, loadPersistedColors]);

  const trimmedCustomColors = useMemo(() => {
    return customColors.slice(0, requiredColorCount);
  }, [customColors, requiredColorCount]);

  // Create a modified chart config with custom colors
  const modifiedChartConfig: ChartConfig = useMemo(
    () => ({
      ...chartConfig,
      config: {
        ...chartConfig.config,
        colors: trimmedCustomColors,
      },
    }),
    [chartConfig, trimmedCustomColors],
  );

  const chartComponent = (() => {
    switch (chartType) {
      case 'bar':
        return (
          <Suspense fallback={<div className="p-4">Loading chart...</div>}>
            <BarChart
              chartConfig={
                modifiedChartConfig as {
                  chartType: 'bar';
                  data: Array<Record<string, unknown>>;
                  config: {
                    colors: string[];
                    labels?: Record<string, string>;
                    xKey?: string;
                    yKey?: string;
                  };
                }
              }
            />
          </Suspense>
        );
      case 'line':
        return (
          <Suspense fallback={<div className="p-4">Loading chart...</div>}>
            <LineChart
              chartConfig={
                modifiedChartConfig as {
                  chartType: 'line';
                  data: Array<Record<string, unknown>>;
                  config: {
                    colors: string[];
                    labels?: Record<string, string>;
                    xKey?: string;
                    yKey?: string;
                  };
                }
              }
            />
          </Suspense>
        );
      case 'pie':
        return (
          <Suspense fallback={<div className="p-4">Loading chart...</div>}>
            <PieChart
              chartConfig={
                modifiedChartConfig as {
                  chartType: 'pie';
                  data: Array<Record<string, unknown>>;
                  config: {
                    colors: string[];
                    labels?: Record<string, string>;
                    nameKey?: string;
                    valueKey?: string;
                  };
                }
              }
            />
          </Suspense>
        );
      default:
        return (
          <div className="text-muted-foreground p-4 text-sm">
            Unsupported chart type: {chartType}
          </div>
        );
    }
  })();

  return (
    <div className="space-y-4">
      <Suspense fallback={<div className="p-4">Loading chart wrapper...</div>}>
        <ChartWrapper
          title={title}
          chartRef={chartRef as React.RefObject<HTMLDivElement>}
          hideAxisLabelsCheckbox={chartType === 'pie'}
          chartData={chartConfig.data}
        >
          {chartComponent}
        </ChartWrapper>
      </Suspense>
      <div className="flex justify-end">
        <Suspense fallback={<div className="p-2">Loading color editor...</div>}>
          <ChartColorEditor
            colors={trimmedCustomColors}
            onChange={setCustomColors}
            maxColors={requiredColorCount}
          />
        </Suspense>
      </div>
    </div>
  );
}
