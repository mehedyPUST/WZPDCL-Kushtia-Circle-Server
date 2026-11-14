import Calculation from "../models/Calculation.js";
import { DHAKA_OFFSET_MS, dhakaNowParts } from "../lib/dhakaTime.js";

const VALID_RANGES = new Set([
  "today",
  "last7days",
  "lastweek",
  "monthly",
  "yearly",
  "alltime",
]);

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export const ACTIVE_CALCULATION_FILTER = {
  $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
};

export const TRASH_CALCULATION_FILTER = {
  deletedAt: { $ne: null },
};

function resolveRangeBounds(
  range: string,
  year: number,
  month: number,
  now: Date
): { start: Date | null; end: Date | null; label: string } {
  const parts = dhakaNowParts(now);

  switch (range) {
    case "today": {
      const start = new Date(
        Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0) -
          DHAKA_OFFSET_MS
      );
      const end = new Date(
        Date.UTC(parts.year, parts.month - 1, parts.day + 1, 0, 0, 0, 0) -
          DHAKA_OFFSET_MS
      );
      return { start, end, label: "Today" };
    }
    case "last7days": {
      const end = new Date(
        Date.UTC(parts.year, parts.month - 1, parts.day + 1, 0, 0, 0, 0) -
          DHAKA_OFFSET_MS
      );
      const start = new Date(
        Date.UTC(parts.year, parts.month - 1, parts.day + 1 - 7, 0, 0, 0, 0) -
          DHAKA_OFFSET_MS
      );
      return { start, end, label: "Last 7 days" };
    }
    case "lastweek": {
      const dhakaDate = new Date(
        Date.UTC(parts.year, parts.month - 1, parts.day)
      );
      const day = dhakaDate.getUTCDay();
      const daysSinceMon = day === 0 ? 6 : day - 1;
      const end = new Date(
        Date.UTC(
          parts.year,
          parts.month - 1,
          parts.day - daysSinceMon,
          0,
          0,
          0,
          0
        ) - DHAKA_OFFSET_MS
      );
      const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
      return { start, end, label: "Last week" };
    }
    case "yearly": {
      const start = new Date(
        Date.UTC(year, 0, 1, 0, 0, 0, 0) - DHAKA_OFFSET_MS
      );
      const end = new Date(
        Date.UTC(year + 1, 0, 1, 0, 0, 0, 0) - DHAKA_OFFSET_MS
      );
      return { start, end, label: `Year ${year}` };
    }
    case "alltime":
      return { start: null, end: null, label: "All time" };
    case "monthly":
    default: {
      const start = new Date(
        Date.UTC(year, month - 1, 1, 0, 0, 0, 0) - DHAKA_OFFSET_MS
      );
      const end =
        month === 12
          ? new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0, 0) - DHAKA_OFFSET_MS)
          : new Date(
              Date.UTC(year, month, 1, 0, 0, 0, 0) - DHAKA_OFFSET_MS
            );
      return { start, end, label: `${MONTH_NAMES[month - 1]} ${year}` };
    }
  }
}

export async function computeMaxLoadReport(query: {
  range?: unknown;
  year?: unknown;
  month?: unknown;
  ringMode?: unknown;
  peakBy?: unknown;
}) {
  const now = new Date();
  const dhakaNow = dhakaNowParts(now);

  let range = String(query.range || "monthly").toLowerCase();
  if (!VALID_RANGES.has(range)) range = "monthly";

  let year = parseInt(String(query.year || ""), 10);
  let month = parseInt(String(query.month || ""), 10);
  if (!Number.isFinite(year) || year < 2000 || year > 2100) {
    year = dhakaNow.year;
  }
  if (!Number.isFinite(month) || month < 1 || month > 12) {
    month = dhakaNow.month;
  }

  let ringMode = String(query.ringMode || "with").toLowerCase();
  if (!["without", "with", "all"].includes(ringMode)) ringMode = "with";

  let peakBy = String(query.peakBy || "mw").toLowerCase();
  if (!["mw", "amps"].includes(peakBy)) peakBy = "mw";

  const { start, end, label } = resolveRangeBounds(range, year, month, now);

  const andParts: any[] = [ACTIVE_CALCULATION_FILTER];
  let dateMatchServer: Record<string, any> | null = null;
  if (start || end) {
    const rangeQ: Record<string, any> = {};
    if (start) rangeQ.$gte = start;
    if (end) rangeQ.$lt = end;
    dateMatchServer = {
      $or: [{ calculatedAt: rangeQ }, { createdAt: rangeQ }],
    };
    andParts.push(dateMatchServer);
  }

  if (ringMode === "without") {
    andParts.push({
      $and: [
        {
          $or: [
            { hasActiveRing: false },
            { hasActiveRing: { $exists: false } },
            { hasActiveRing: null },
          ],
        },
        { $nor: [{ "feeders.ringActive": true }] },
      ],
    });
  }

  const baseMatch = { $and: andParts };

  const hourlyCount = await Calculation.countDocuments({
    $and: [
      ...andParts,
      {
        $or: [
          { isHourly: true },
          { hourSlot: { $type: "string", $ne: "" } },
        ],
      },
    ],
  });

  const pipeline: any[] = [
    { $match: baseMatch },
    { $unwind: "$feeders" },
    {
      $addFields: {
        eventAt: { $ifNull: ["$calculatedAt", "$createdAt"] },
      },
    },
    {
      $sort:
        peakBy === "amps"
          ? { "feeders.amps": -1, "feeders.mw": -1, eventAt: 1 }
          : { "feeders.mw": -1, "feeders.amps": -1, eventAt: 1 },
    },
    {
      $group: {
        _id: "$feeders.id",
        name: { $first: "$feeders.name" },
        bus: { $first: "$feeders.bus" },
        peaks: {
          $push: {
            maxMW: "$feeders.mw",
            maxLoadAt: "$eventAt",
            ampsAtMax: "$feeders.amps",
            hourSlot: "$hourSlot",
            hasActiveRing: { $eq: ["$hasActiveRing", true] },
          },
        },
        recordCount: { $sum: 1 },
      },
    },
    {
      $project: {
        name: 1,
        bus: 1,
        recordCount: 1,
        peaks: { $slice: ["$peaks", 5] },
        maxMW: { $arrayElemAt: ["$peaks.maxMW", 0] },
        maxLoadAt: { $arrayElemAt: ["$peaks.maxLoadAt", 0] },
        ampsAtMax: { $arrayElemAt: ["$peaks.ampsAtMax", 0] },
      },
    },
    { $sort: { _id: 1 } },
  ];

  const stationPeakMatch = {
    $and: [
      ACTIVE_CALCULATION_FILTER,
      ...(dateMatchServer ? [dateMatchServer] : []),
    ],
  };

  const [rows, totalPeak, bottail11Peaks, sampleCount] = await Promise.all([
    Calculation.aggregate(pipeline),
    Calculation.aggregate([
      { $match: stationPeakMatch },
      {
        $addFields: {
          eventAt: { $ifNull: ["$calculatedAt", "$createdAt"] },
          totalMWNum: {
            $convert: {
              input: "$totalMW",
              to: "double",
              onError: 0,
              onNull: 0,
            },
          },
        },
      },
      { $sort: { totalMWNum: -1, eventAt: 1 } },
      { $limit: 1 },
      {
        $project: {
          _id: 0,
          maxTotalMW: "$totalMWNum",
          maxTotalAt: "$eventAt",
          hourSlot: 1,
          hasActiveRing: { $eq: ["$hasActiveRing", true] },
        },
      },
    ]),
    Calculation.aggregate([
      { $match: stationPeakMatch },
      { $addFields: { eventAt: { $ifNull: ["$calculatedAt", "$createdAt"] } } },
      { $sort: { bottail11kV: -1, eventAt: 1 } },
      { $limit: 5 },
      {
        $project: {
          _id: 0,
          maxMW: { $ifNull: ["$bottail11kV", 0] },
          maxLoadAt: "$eventAt",
          hourSlot: 1,
          hasActiveRing: { $eq: ["$hasActiveRing", true] },
          ampsAtMax: {
            $sum: {
              $map: {
                input: {
                  $filter: {
                    input: "$feeders",
                    as: "f",
                    cond: { $in: ["$$f.id", [8, 9]] },
                  },
                },
                as: "f",
                in: { $ifNull: ["$$f.amps", 0] },
              },
            },
          },
        },
      },
    ]),
    Calculation.countDocuments(baseMatch),
  ]);

  return {
    range,
    label,
    ringMode,
    peakBy,
    year,
    month,
    start: start ? start.toISOString() : null,
    end: end ? end.toISOString() : null,
    sampleCount,
    hourlyOnly: hourlyCount > 0,
    data: rows.map((r: any) => ({
      feederId: r._id,
      name: r.name,
      bus: r.bus,
      maxMW: r.maxMW ?? 0,
      maxLoadAt: r.maxLoadAt,
      ampsAtMax: r.ampsAtMax ?? 0,
      recordCount: r.recordCount ?? 0,
      peaks: (r.peaks || []).map((p: any) => ({
        maxMW: p.maxMW ?? 0,
        maxLoadAt: p.maxLoadAt,
        ampsAtMax: p.ampsAtMax ?? 0,
        hourSlot: p.hourSlot || null,
        hasActiveRing: !!p.hasActiveRing,
      })),
    })),
    bottail11Peaks: (bottail11Peaks || []).map((p: any) => ({
      maxMW: p.maxMW ?? 0,
      maxLoadAt: p.maxLoadAt,
      ampsAtMax: p.ampsAtMax ?? 0,
      hourSlot: p.hourSlot || null,
      hasActiveRing: !!p.hasActiveRing,
    })),
    totalPeak: totalPeak[0]
      ? {
          ...totalPeak[0],
          hasActiveRing: !!totalPeak[0].hasActiveRing,
        }
      : null,
  };
}
