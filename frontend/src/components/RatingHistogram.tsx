import React from 'react';

interface RatingHistogramProps {
  histogram: [number, number, number, number, number] | number[];
  mean: number | null;
  totalResponses: number;
}

/** Renders a 1-5 rating distribution histogram and mean score. */
export function RatingHistogram({ histogram, mean, totalResponses }: RatingHistogramProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between rounded-lg bg-slate-50 px-4 py-3">
        <span className="text-sm font-medium text-slate-600">Average Rating</span>
        <span className="text-xl font-bold text-slate-900">
          {mean !== null && Number.isFinite(mean) ? `Mean: ${mean.toFixed(1)} / 5` : 'Mean: 0.0 / 5'}
        </span>
      </div>
      <div className="space-y-2">
        {[1, 2, 3, 4, 5].map((score) => {
          const count = histogram[score - 1] ?? 0;
          const pct = totalResponses > 0 ? (count / totalResponses) * 100 : 0;
          return (
            <div key={score} className="flex items-center gap-3 text-sm">
              <span className="w-8 font-semibold text-slate-700">{score} ★</span>
              <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-emerald-600 transition-all duration-200"
                  style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                />
              </div>
              <span className="w-20 text-right text-slate-600">
                {count} ({pct.toFixed(1)}%)
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
